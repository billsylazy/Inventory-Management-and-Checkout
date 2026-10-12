import { api, qs } from '../api.js';
import {
  assetCard, banner, btn, clear, confirmDialog, debounce, emptyState, field, fmtDateTime, fromLocalInput, h, icon,
  kitCard, plural, tabs, thumb, toLocalInput, toast,
} from '../ui.js';
import { personChip, restrictionBanner, userPicker } from './shared.js';

const STATE_BADGE = {
  booked: ['reserved', 'Booked'],
  ready: ['reserved', 'Ready for pickup'],
  fulfilled: ['available', 'Picked up'],
  cancelled: ['unavailable', 'Cancelled'],
  expired: ['unavailable', 'Expired'],
};

export async function bookingsView({ query, app }) {
  const admin = app.isAdmin;
  const past = query.past === '1';
  const { reservations } = await api.get(`/reservations${qs({ past: past ? 1 : '' })}`);
  const page = h('div', { class: 'page page-narrow' });

  const card = (r) => {
    const [cls, label] = STATE_BADGE[r.state];
    return h('section', { class: 'card stack-sm' },
      h('div', { class: 'row' },
        admin ? personChip(r.user, { href: `#/people/${r.user.id}` }) : h('div', { class: 'bold' }, `${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}`),
        h('span', { class: 'spacer' }),
        h('span', { class: `badge ${cls}` }, label)),
      admin ? h('div', { class: 'small bold' }, `${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}`) : null,
      r.note ? h('div', { class: 'small muted' }, r.note) : null,
      h('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } }, r.items.map((i) => h('a', { href: `#/item/${i.id}`, title: `${i.tag} · ${i.name}`, class: 'row-nowrap', style: { gap: '6px', padding: '4px 8px 4px 4px', border: '1px solid var(--border)', borderRadius: '10px', color: 'inherit' } },
        thumb(i, 'xs'), h('span', { class: 'small' }, i.name)))),
      ['booked', 'ready'].includes(r.state) ? h('div', { class: 'action-bar', style: { marginTop: '6px' } },
        r.state === 'ready' && app.canSelfServe ? btn('Check out now', { size: 'sm', variant: 'primary', iconName: 'checkout', href: `#/checkout${qs({ reservation: r.id })}` }) : null,
        btn('Cancel booking', {
          size: 'sm', variant: 'danger',
          onClick: async () => {
            if (!await confirmDialog('Cancel this booking? The gear will be free for others.', { confirmLabel: 'Cancel booking', danger: true })) return;
            await api.post(`/reservations/${r.id}/cancel`);
            toast('Booking cancelled', 'success');
            app.refresh();
          },
        })) : null);
  };

  return clear(page,
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, 'Bookings'), h('p', { class: 'sub' }, admin ? 'Upcoming bookings for everyone.' : 'Reserve gear ahead of time for a shoot.')),
      app.canBook ? btn('Book gear', { variant: 'primary', iconName: 'plus', href: '#/bookings/new' }) : null),
    restrictionBanner(app),
    tabs([{ value: false, label: 'Upcoming', href: '#/bookings' }, { value: true, label: 'Past', href: '#/bookings?past=1' }], past),
    reservations.length ? h('div', { class: 'stack' }, reservations.map(card))
      : emptyState('calendar', past ? 'No past bookings' : 'No upcoming bookings', app.canBook && !past ? 'Book a camera kit for your next shoot.' : null,
        app.canBook && !past ? btn('Book gear', { variant: 'primary', href: '#/bookings/new' }) : null));
}

export async function bookingFormView({ query, app }) {
  const admin = app.isAdmin;
  const page = h('div', { class: 'page' });
  if (!app.canBook) return clear(page, banner('info', 'Booking is turned off. Please talk to a teacher.'));

  const [{ assets }, { kits }] = await Promise.all([api.get('/assets'), api.get('/kits')]);
  const state = { user: admin ? null : app.user, selected: new Map(), unavailable: {}, tab: query.kit ? 'kits' : 'items', q: '' };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const endDefault = new Date(tomorrow);
  endDefault.setDate(endDefault.getDate() + Math.min(app.settings.loan_days_default, app.settings.max_reservation_days));
  endDefault.setHours(15, 30, 0, 0);
  const start = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(tomorrow) });
  const end = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(endDefault) });
  const note = h('input', { class: 'input', placeholder: 'What is it for? (optional)' });

  const userBox = h('div');
  const pickerBox = h('div');
  const suggestBox = h('div');
  const selectedBox = h('div');
  const submitBtn = btn('Book', { variant: 'primary', size: 'lg', iconName: 'calendar', onClick: () => submit() });
  const summary = h('div', { class: 'summary' });

  const key = (type, id) => `${type}:${id}`;
  const isSelected = (type, id) => state.selected.has(key(type, id));
  const kitBlocked = (kit) => kit.items.filter((i) => state.unavailable[i.id]);

  async function loadAvailability() {
    const s = fromLocalInput(start.value);
    const e = fromLocalInput(end.value);
    if (!s || !e || e <= s) {
      state.unavailable = {};
      return renderAll();
    }
    try {
      const res = await api.get(`/availability${qs({ start: s, end: e, user_id: state.user?.id })}`);
      state.unavailable = res.unavailable;
    } catch (err) {
      toast(err.message, 'error');
    }
    renderAll();
  }
  start.addEventListener('change', loadAvailability);
  end.addEventListener('change', loadAvailability);

  function toggle(type, item) {
    const k = key(type, item.id);
    if (state.selected.has(k)) state.selected.delete(k);
    else {
      if (type === 'asset' && state.unavailable[item.id]) return toast(`${item.tag} isn’t available for those dates`, 'warning');
      if (type === 'kit' && kitBlocked(item).length) return toast(`Part of ${item.tag} isn’t available for those dates`, 'warning');
      state.selected.set(k, { type, id: item.id, item });
    }
    renderAll();
    if (type === 'asset' && item.category_kind === 'main' && state.selected.has(k)) loadSuggestions(item);
  }

  async function loadSuggestions(item) {
    const { assets: compat } = await api.get(`/assets/${item.id}/compatible`);
    const free = compat.filter((a) => a.state === 'active' && !state.unavailable[a.id] && !isSelected('asset', a.id));
    if (!free.length) return clear(suggestBox);
    clear(suggestBox, h('section', { class: 'card stack-sm', style: { marginBottom: '14px' } },
      h('div', { class: 'card-title' }, icon('link'), h('h2', null, `Works with ${item.name}`), btn('', { size: 'sm', variant: 'ghost', iconName: 'x', onClick: () => clear(suggestBox) })),
      h('p', { class: 'small muted' }, 'Free for your dates — tap to add.'),
      h('div', { class: 'suggest-strip' }, free.slice(0, 16).map((a) => assetCard(a, {
        onClick: () => { toggle('asset', a); loadSuggestions(item); },
        extra: h('div', { class: 'extra' }, `Fits: ${a.match.join(', ')}`),
      })))));
  }

  function renderUser() {
    if (!admin) return clear(userBox);
    if (!state.user) {
      return clear(userBox, h('section', { class: 'card stack' }, h('div', { class: 'card-title' }, icon('user'), h('h2', null, 'Who is it for?')),
        userPicker({ onSelect: (u) => { state.user = u; renderUser(); loadAvailability(); } }),
        btn('Book for myself', { size: 'sm', variant: 'ghost', onClick: () => { state.user = app.user; renderUser(); loadAvailability(); } })));
    }
    clear(userBox, h('section', { class: 'card card-tight row' }, personChip(state.user), h('span', { class: 'spacer' }),
      btn('Change', { size: 'sm', onClick: () => { state.user = null; renderUser(); } })));
  }

  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search…', 'aria-label': 'Search gear',
    oninput: debounce(() => { state.q = search.value; renderPicker(); }, 150),
  });
  const pickerTabs = h('div');
  const gridBox = h('div');
  clear(pickerBox, pickerTabs, h('div', { class: 'search', style: { marginBottom: '12px' } }, icon('search'), search), gridBox);

  function renderPicker() {
    const q = state.q.trim().toLowerCase();
    const match = (a) => !q || [a.tag, a.name, a.category, a.brand, ...(a.compat ?? [])].some((v) => v && String(v).toLowerCase().includes(q));
    let grid;
    if (state.tab === 'kits') {
      grid = h('div', { class: 'grid-cards compact' }, kits.filter(match).map((k) => {
        const blocked = kitBlocked(k);
        const card = kitCard(k);
        card.removeAttribute('href');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.classList.toggle('selected', isSelected('kit', k.id));
        card.classList.toggle('dim', blocked.length > 0);
        card.querySelector('.card-body').append(h('div', { class: `extra${blocked.length ? ' danger' : ''}` }, blocked.length ? `${blocked.length} item(s) not free` : isSelected('kit', k.id) ? '✓ Selected' : 'Free for your dates'));
        card.addEventListener('click', (e) => { e.preventDefault(); toggle('kit', k); });
        return card;
      }));
    } else {
      const list = assets.filter((a) => a.state === 'active' && match(a));
      grid = h('div', { class: 'grid-cards compact' }, list.map((a) => {
        const reason = state.unavailable[a.id];
        return assetCard(a, {
          onClick: () => toggle('asset', a),
          selected: isSelected('asset', a.id),
          dim: !!reason,
          extra: h('div', { class: `extra${reason ? ' danger' : ''}` }, reason ? `Not free: ${reason.message.toLowerCase()}` : isSelected('asset', a.id) ? '✓ Selected' : 'Free for your dates'),
        });
      }));
    }
    clear(pickerTabs, tabs([{ value: 'items', label: 'Items' }, { value: 'kits', label: 'Kits', count: kits.length }], state.tab, (v) => { state.tab = v; renderPicker(); }));
    clear(gridBox, grid);
  }

  function renderSelected() {
    const items = [...state.selected.values()];
    clear(selectedBox, items.length
      ? h('div', { class: 'chips' }, items.map((s) => h('span', { class: 'chip chip-static' }, s.type === 'kit' ? icon('kit') : null, `${s.item.tag} · ${s.item.name}`,
        h('button', { type: 'button', class: 'chip-x', title: 'Remove', onclick: () => { state.selected.delete(key(s.type, s.id)); renderAll(); } }, icon('x')))))
      : h('p', { class: 'small muted' }, 'Tap items or kits below to add them.'));
    const blocked = items.filter((s) => (s.type === 'asset' ? state.unavailable[s.id] : kitBlocked(s.item).length));
    clear(summary, h('div', { class: 'bold' }, plural(items.length, 'thing') + ' selected'),
      blocked.length ? h('div', { class: 'small', style: { color: 'var(--out)' } }, `${blocked.map((b) => b.item.tag).join(', ')} not free for these dates`)
        : h('div', { class: 'small muted' }, `${fmtDateTime(fromLocalInput(start.value))} → ${fmtDateTime(fromLocalInput(end.value))}`));
    submitBtn.disabled = !items.length || blocked.length > 0 || !state.user;
  }

  function renderAll() {
    renderPicker();
    renderSelected();
  }

  async function submit() {
    submitBtn.disabled = true;
    try {
      await api.post('/reservations', {
        user_id: state.user.id,
        start_at: fromLocalInput(start.value),
        end_at: fromLocalInput(end.value),
        note: note.value,
        entries: [...state.selected.values()].map((s) => ({ type: s.type, id: s.id })),
      });
      toast('Booked! The gear is held for you.', 'success');
      app.navigate('#/bookings');
    } catch (err) {
      toast(err.message, 'error');
      renderSelected();
    }
  }

  // prefill
  if (query.add) {
    const a = assets.find((x) => String(x.id) === query.add);
    if (a) state.selected.set(key('asset', a.id), { type: 'asset', id: a.id, item: a });
  }
  if (query.kit) {
    const k = kits.find((x) => String(x.id) === query.kit);
    if (k) state.selected.set(key('kit', k.id), { type: 'kit', id: k.id, item: k });
  }
  renderUser();
  await loadAvailability();
  const firstMain = [...state.selected.values()].find((s) => s.type === 'asset' && s.item.category_kind === 'main');
  if (firstMain) loadSuggestions(firstMain.item);

  return clear(page,
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Book gear'),
      h('p', { class: 'sub' }, `Pick your dates, then the gear. Bookings can be up to ${plural(app.settings.max_reservation_days, 'day')} and are released if not picked up within ${plural(app.settings.reservation_pickup_hours, 'hour')} of the start.`))),
    restrictionBanner(app),
    h('div', { class: 'stack' },
      userBox,
      h('section', { class: 'card' }, h('div', { class: 'form-grid cols-2' }, field('Pick up', start), field('Return by', end), h('div', { class: 'span-2' }, field('Note', note)))),
      h('section', { class: 'card stack-sm' }, h('div', { class: 'card-title' }, icon('check'), h('h2', null, 'Selected')), selectedBox),
      suggestBox,
      pickerBox),
    h('div', { class: 'sticky-actions' }, summary, submitBtn));
}

