import { api, qs } from '../api.js';
import { photoPicker } from '../photo.js';
import { scanField } from '../scanner.js';
import {
  assetCard, badge, banner, btn, clear, confirmDialog, dueText, field, fmtDateTime, fmtMoney, h, icon,
  openModal, plural, relTime, tagCode, thumb, toast,
} from '../ui.js';
import { assetRow, backLink, conditionBadge } from './shared.js';

export async function assetView({ params, app }) {
  const data = await api.get(`/assets/${params.id}`);
  const { asset } = data;
  const admin = app.isAdmin;
  const s = asset.status;
  const page = h('div', { class: 'page' });

  // --- status line -------------------------------------------------------
  let statusInfo = null;
  if (s.code === 'checked_out') {
    statusInfo = banner(s.overdue ? 'danger' : 'warning', h('div', null,
      h('div', { class: 'bold' }, s.mine ? 'You have this item' : s.borrower ? `Checked out to ${s.borrower.name}` : 'Checked out'),
      h('div', null, `${dueText(s.due_at)} (${fmtDateTime(s.due_at)})`),
      s.loan_id ? h('a', { href: `#/loan/${s.loan_id}` }, 'View loan →') : null), 'clock');
  } else if (s.code === 'reserved') {
    statusInfo = banner('warning', h('div', null,
      h('div', { class: 'bold' }, s.mine ? 'Reserved for you' : s.reserved_by ? `Reserved by ${s.reserved_by.name}` : 'Reserved'),
      h('div', null, `${fmtDateTime(s.start_at)} → ${fmtDateTime(s.end_at)}`)), 'calendar');
  } else if (s.code === 'unavailable') {
    statusInfo = banner('danger', h('div', { class: 'bold' }, `${s.label} — not available to borrow`), asset.state === 'repair' ? 'wrench' : 'ban');
  }

  // --- actions -------------------------------------------------------------
  const canTake = s.code === 'available' || (s.code === 'reserved' && s.mine);
  const actions = h('div', { class: 'action-bar' },
    app.canSelfServe && canTake ? btn('Check out', { variant: 'primary', iconName: 'checkout', href: `#/checkout${qs({ add: asset.tag })}` }) : null,
    app.canBook && asset.state === 'active' ? btn('Book', { iconName: 'calendar', href: `#/bookings/new${qs({ add: asset.id })}` }) : null,
    data.compatible.length ? btn('Compatible gear', { iconName: 'link', href: `#/${qs({ compat: asset.id })}` }) : null,
    admin ? btn('Edit', { iconName: 'edit', href: `#/item/${asset.id}/edit` }) : null,
    admin ? btn('Label', { iconName: 'print', href: `#/labels${qs({ tags: asset.tag })}` }) : null,
    admin ? btn('More', { iconName: 'menu', onClick: () => moreMenu(app, data) }) : null);

  // --- photo ---------------------------------------------------------------
  const hero = h('div', { class: 'stack-sm' }, h('div', { class: 'thumb-hero', style: { overflow: 'hidden' } }, thumb(asset)));
  if (admin) {
    const picker = photoPicker({
      label: asset.photo_url ? 'Replace photo' : 'Add a photo',
      maxSize: 1000,
      onChange: async (dataUrl) => {
        if (!dataUrl) return;
        await api.post(`/assets/${asset.id}/photo`, { image: dataUrl });
        toast('Photo saved', 'success');
        app.refresh();
      },
    });
    hero.append(picker.el);
  }

  const facts = h('div', { class: 'facts' },
    fact('Category', asset.category),
    asset.brand || asset.model ? fact('Make / model', [asset.brand, asset.model].filter(Boolean).join(' ')) : null,
    admin || asset.value_cents ? fact('Value', asset.value_cents ? fmtMoney(asset.value_cents) : '—') : null,
    fact('Condition', conditionBadge(asset.condition)),
    asset.location ? fact('Home location', asset.location) : null,
    admin && asset.serial_number ? fact('Serial number', h('span', { class: 'mono' }, asset.serial_number)) : null,
    data.kit ? fact('Kit', h('a', { href: `#/kit/${data.kit.id}` }, `${data.kit.name} (${data.kit.tag})`)) : null,
    data.parent ? fact('Attached to', h('a', { href: `#/item/${data.parent.id}` }, `${data.parent.name} (${data.parent.tag})`)) : null,
    asset.requires_signature || (app.settings.signature_threshold_cents > 0 && asset.value_cents >= app.settings.signature_threshold_cents)
      ? fact('Check-out', h('span', null, icon('pen'), ' Signature required')) : null);

  const top = h('div', { class: 'detail-hero' }, hero,
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, badge(s, { large: true }), tagCode(asset.tag)),
      h('h1', null, asset.name),
      asset.description ? h('p', { class: 'muted' }, asset.description) : null,
      statusInfo,
      facts,
      asset.compat?.length ? h('div', { class: 'stack-sm' },
        h('div', { class: 'small bold muted' }, 'Compatibility'),
        h('div', { class: 'chips' }, asset.compat.map((t) => h('span', { class: 'chip chip-static' }, t)))) : null,
      admin && asset.notes ? banner('info', asset.notes, 'info') : null,
      actions));

  // --- attached accessories ----------------------------------------------
  let attached = null;
  if (data.children.length || admin) {
    attached = h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, icon('link'), h('h2', null, 'Attached accessories')),
      h('p', { class: 'small muted', style: { marginBottom: '8px' } }, 'Attached items go out with this one but keep their own tags and history.'),
      data.children.length
        ? h('div', { class: 'list' }, data.children.map((c) => assetRow(c, {
          trailing: admin ? btn('Detach', {
            size: 'sm', iconName: 'unlink',
            onClick: async (e) => {
              e.preventDefault();
              await api.post(`/assets/${c.id}/detach`);
              toast(`${c.tag} detached`, 'success');
              app.refresh();
            },
          }) : null,
        })))
        : h('p', { class: 'small faint' }, 'Nothing attached.'),
      admin ? h('div', { style: { marginTop: '10px' } }, scanField({
        placeholder: 'Scan an accessory to attach (e.g. a lens)',
        buttonLabel: 'Attach',
        continuous: false,
        autofocus: false,
        title: 'Scan the accessory',
        onScan: async (code) => {
          try {
            const res = await api.get(`/scan${qs({ code })}`);
            if (res.type !== 'asset') return { ok: false, message: 'Scan an individual item, not a kit' };
            await api.post(`/assets/${res.asset.id}/attach`, { parent_id: asset.id });
            toast(`${res.asset.tag} attached`, 'success');
            setTimeout(() => app.refresh(), 300);
            return { ok: true, message: `${res.asset.name} attached` };
          } catch (err) {
            toast(err.message, 'error');
            return { ok: false, message: err.message };
          }
        },
      })) : null);
  }

  // --- compatible gear ----------------------------------------------------
  let compat = null;
  if (data.compatible.length) {
    const isMain = asset.category_kind === 'main';
    const shown = data.compatible.slice(0, 12);
    compat = h('section', { class: 'section' },
      h('div', { class: 'section-title' }, icon('link'), h('h2', null, isMain ? 'Compatible accessories' : 'Works with'),
        data.compatible.length > shown.length ? h('a', { href: `#/${qs({ compat: asset.id })}` }, `See all ${data.compatible.length}`) : null),
      h('div', { class: 'grid-cards compact' }, shown.map((a) => assetCard(a, { extra: h('div', { class: 'extra' }, `Fits: ${a.match.join(', ')}`) }))));
  }

  // --- bookings -------------------------------------------------------------
  const bookings = data.reservations.length ? h('section', { class: 'section card' },
    h('div', { class: 'card-title' }, icon('calendar'), h('h2', null, 'Upcoming bookings')),
    h('div', { class: 'list' }, data.reservations.map((r) => h('div', { class: 'list-item' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}`),
        h('div', { class: 'sub' }, r.mine ? 'Your booking' : r.user ? r.user.name : 'Booked'))))))
    : null;

  // --- history (staff) ---------------------------------------------------
  const history = data.history ? h('section', { class: 'section card' },
    h('div', { class: 'card-title' }, icon('history'), h('h2', null, 'Tracking history'),
      data.stats ? h('span', { class: 'small muted' }, `${plural(data.stats.loans, 'loan')} · ${plural(data.stats.damaged_returns ?? 0, 'damaged return')}`) : null),
    data.history.length ? h('ul', { class: 'timeline' }, data.history.map((e) => h('li', { class: `t-${e.type}` },
      h('div', null, e.message),
      h('div', { class: 'when' }, `${fmtDateTime(e.created_at)} · ${relTime(e.created_at)}${e.actor ? ` · by ${e.actor}` : ''}`,
        e.loan_id ? [' · ', h('a', { href: `#/loan/${e.loan_id}` }, 'loan')] : null),
      e.photo_url ? h('a', { href: e.photo_url, target: '_blank', rel: 'noopener' }, h('img', { src: e.photo_url, alt: 'Condition photo', loading: 'lazy' })) : null)))
      : h('p', { class: 'small faint' }, 'No history yet.'))
    : null;

  clear(page, backLink('#/', 'Equipment'), top, attached, compat, bookings, history);
  return page;
}

function fact(k, v) {
  return h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
}

function moreMenu(app, data) {
  const { asset } = data;
  const onLoan = asset.status.code === 'checked_out';
  const item = (label, iconName, onClick, danger) => h('button', {
    type: 'button', class: 'list-item',
    style: { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--border)', cursor: 'pointer', font: 'inherit', color: danger ? 'var(--out)' : 'inherit', textAlign: 'left' },
    onclick: () => { menu.close(); onClick(); },
  }, h('span', { class: 'icon-btn', style: { color: 'inherit', pointerEvents: 'none' } }, icon(iconName)), h('div', { class: 'main' }, h('div', { class: 'title' }, label)));

  const setState = (state, title, { askNotes = true, condition } = {}) => {
    const notes = h('textarea', { class: 'textarea', placeholder: 'Notes (optional)' });
    openModal({
      title,
      body: h('div', { class: 'stack' }, askNotes ? field('Notes', notes) : null),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Save', variant: 'primary',
          onClick: async () => {
            await api.post(`/assets/${asset.id}/state`, { state, notes: notes.value, condition });
            toast('Status updated', 'success');
            app.refresh();
          },
        },
      ],
    });
  };

  const items = [];
  if (asset.parent_id) {
    items.push(item(`Detach from ${data.parent.tag}`, 'unlink', async () => {
      await api.post(`/assets/${asset.id}/detach`);
      toast('Detached', 'success');
      app.refresh();
    }));
  } else {
    items.push(item('Attach to another item…', 'link', () => attachDialog(app, asset)));
  }
  if (!onLoan) {
    if (asset.state === 'active') {
      items.push(item('Send to repair', 'wrench', () => setState('repair', 'Send to repair')));
      items.push(item('Mark as lost', 'alert', () => setState('lost', 'Mark as lost'), true));
      items.push(item('Retire (no longer in use)', 'ban', () => setState('retired', 'Retire item'), true));
    } else if (asset.state === 'repair') {
      items.push(item('Repaired — back in service', 'check-circle', () => conditionDialog(app, asset, 'Back in service')));
    } else if (asset.state === 'lost') {
      items.push(item('Found — back in service', 'check-circle', () => conditionDialog(app, asset, 'Item found')));
    } else if (asset.state === 'retired') {
      items.push(item('Return to service', 'check-circle', () => setState('active', 'Return to service')));
    }
  }
  items.push(item('Report damage', 'camera', () => damageDialog(app, asset)));
  items.push(item('Duplicate (same model, new tag)', 'copy', () => duplicateDialog(app, asset)));
  items.push(item('Delete', 'trash', async () => {
    if (!await confirmDialog(`Delete ${asset.tag} (${asset.name})? Items with check-out history can only be retired.`, { danger: true, confirmLabel: 'Delete' })) return;
    await api.del(`/assets/${asset.id}`);
    toast('Item deleted', 'success');
    app.navigate('#/');
  }, true));

  const menu = openModal({ title: `${asset.tag} actions`, body: h('div', { class: 'list' }, items) });
}

function attachDialog(app, asset) {
  let modal;
  const scan = scanField({
    placeholder: 'Scan or type the main item’s tag (e.g. CAM-001)',
    buttonLabel: 'Attach',
    continuous: false,
    title: 'Scan the main item',
    onScan: async (code) => {
      try {
        await api.post(`/assets/${asset.id}/attach`, { parent_tag: code });
        toast(`Attached to ${code}`, 'success');
        modal.close();
        app.refresh();
        return { ok: true, message: `Attached to ${code}` };
      } catch (err) {
        toast(err.message, 'error');
        return { ok: false, message: err.message };
      }
    },
  });
  modal = openModal({
    title: 'Attach to a main item',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `${asset.name} will travel with the main item when it’s checked out, but keep its own tag and history.`), scan),
  });
}

function conditionDialog(app, asset, title) {
  let condition = 'fair';
  const notes = h('textarea', { class: 'textarea', placeholder: 'What was done? (optional)' });
  const seg = h('select', { class: 'select', onchange: (e) => { condition = e.target.value; } },
    h('option', { value: 'excellent' }, 'Excellent'), h('option', { value: 'fair', selected: true }, 'Fair'), h('option', { value: 'damaged' }, 'Damaged (usable)'));
  openModal({
    title,
    body: h('div', { class: 'stack' }, field('Condition now', seg), field('Notes', notes)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Back in service', variant: 'primary',
        onClick: async () => {
          await api.post(`/assets/${asset.id}/state`, { state: 'active', condition, notes: notes.value });
          toast(`${asset.tag} is back in service`, 'success');
          app.refresh();
        },
      },
    ],
  });
}

function damageDialog(app, asset) {
  const notes = h('textarea', { class: 'textarea', placeholder: 'What is damaged?', required: true });
  const photo = photoPicker({ label: 'Add photo of the damage', emphasize: true });
  const toRepair = h('input', { type: 'checkbox', checked: asset.status.code !== 'checked_out' });
  openModal({
    title: `Report damage — ${asset.tag}`,
    body: h('div', { class: 'stack' }, field('Description', notes), photo.el,
      h('label', { class: 'check' }, toRepair, h('span', null, 'Take it out of circulation (send to repair)'))),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Report damage', variant: 'solid-danger',
        onClick: async () => {
          await api.post(`/assets/${asset.id}/damage`, { notes: notes.value, photo: photo.value, to_repair: toRepair.checked });
          toast('Damage recorded', 'success');
          app.refresh();
        },
      },
    ],
  });
}

function duplicateDialog(app, asset) {
  const tag = h('input', { class: 'input mono', placeholder: 'New tag, e.g. CAM-006' });
  openModal({
    title: 'Duplicate item',
    body: h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `Creates another “${asset.name}” with the same details, photo and compatibility tags.`), field('Tag for the new item', tag)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: 'Create copy', variant: 'primary',
        onClick: async () => {
          const res = await api.post(`/assets/${asset.id}/duplicate`, { tag: tag.value });
          toast(`${res.asset.tag} created`, 'success');
          app.navigate(`#/item/${res.asset.id}`);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Create / edit form

export async function assetFormView({ params, app }) {
  const editing = !!params.id;
  const [detail, { tags }, { locations }] = await Promise.all([
    editing ? api.get(`/assets/${params.id}`) : null,
    api.get('/compat-tags'),
    api.get('/locations'),
  ]);
  const a = detail?.asset ?? {};
  const compat = [...(a.compat ?? [])];

  const input = (name, attrs = {}) => h('input', { class: 'input', name, value: a[name] ?? '', ...attrs });
  const tag = input('tag', { class: 'input mono', required: true, autocapitalize: 'characters', placeholder: 'e.g. CAM-006' });
  const name = input('name', { required: true, placeholder: 'e.g. Canon EOS Rebel T7i' });
  const category = h('select', { class: 'select', name: 'category', required: true },
    app.categories.map((c) => h('option', { value: c.name, selected: (a.category ?? '').toLowerCase() === c.name.toLowerCase() }, c.name)));
  const brand = input('brand');
  const model = input('model');
  const serial = input('serial_number');
  const value = input('value', { inputmode: 'decimal', placeholder: '0.00', value: a.value_cents ? (a.value_cents / 100).toFixed(2) : '' });
  const location = input('location', { list: 'location-list', placeholder: 'e.g. Cabinet A' });
  const requiresSig = h('input', { type: 'checkbox', checked: !!a.requires_signature });
  const description = h('textarea', { class: 'textarea', placeholder: 'What is it for? Tips for students…' }, a.description ?? '');
  const notes = h('textarea', { class: 'textarea', placeholder: 'Staff-only notes' }, a.notes ?? '');
  const parentTag = editing ? null : input('parent_tag', { class: 'input mono', placeholder: 'Optional — e.g. CAM-001' });
  const photo = editing ? null : photoPicker({ label: 'Take or choose a photo', maxSize: 1000 });

  // Compatibility tag editor
  const chipBox = h('div', { class: 'chips' });
  const compatInput = h('input', { class: 'input', list: 'compat-list', placeholder: 'Add a tag and press Enter, e.g. mount:EF' });
  const renderChips = () => clear(chipBox, compat.map((t, i) => h('span', { class: 'chip chip-static' }, t,
    h('button', { type: 'button', class: 'chip-x', title: `Remove ${t}`, onclick: () => { compat.splice(i, 1); renderChips(); } }, icon('x')))));
  const addCompat = () => {
    for (const part of compatInput.value.split(/[,;]/)) {
      const t = part.trim();
      if (t && !compat.some((c) => c.toLowerCase() === t.toLowerCase())) compat.push(t);
    }
    compatInput.value = '';
    renderChips();
  };
  compatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addCompat();
    }
  });
  compatInput.addEventListener('change', addCompat);
  renderChips();

  const error = h('div');
  const save = btn(editing ? 'Save changes' : 'Add item', { type: 'submit', variant: 'primary', size: 'lg' });
  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      addCompat();
      save.disabled = true;
      clear(error);
      const body = {
        tag: tag.value, name: name.value, category: category.value, brand: brand.value, model: model.value,
        serial_number: serial.value, value: value.value, location: location.value, requires_signature: requiresSig.checked,
        description: description.value, notes: notes.value, compat,
      };
      if (parentTag?.value.trim()) body.parent_tag = parentTag.value.trim();
      try {
        const res = editing ? await api.patch(`/assets/${a.id}`, body) : await api.post('/assets', body);
        if (photo?.value) await api.post(`/assets/${res.asset.id}/photo`, { image: photo.value });
        toast(editing ? 'Saved' : `${res.asset.tag} added`, 'success');
        app.navigate(`#/item/${res.asset.id}`);
      } catch (err) {
        clear(error, banner('danger', err.message));
        save.disabled = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
  },
  error,
  h('div', { class: 'form-grid cols-2' },
    field('Tag / barcode', h('div', { class: 'input-group' }, tag, btn('', {
      iconName: 'scan', title: 'Scan an existing label',
      onClick: () => import('../scanner.js').then(({ openCameraScanner }) => openCameraScanner({ title: 'Scan the label', onScan: (code) => { tag.value = code; return { ok: true, message: code }; } })),
    })), 'The code printed on the item’s label. Must be unique.'),
    field('Name', name),
    field('Category', category),
    field('Value (USD)', value, 'Used for signatures and loss reports.'),
    field('Brand', brand),
    field('Model', model),
    field('Serial number', serial),
    field('Home location', location, 'Where it lives — used by shelf audits.'),
    h('div', { class: 'field span-2' },
      h('span', { class: 'label' }, 'Compatibility tags'),
      chipBox, compatInput,
      h('span', { class: 'hint' }, 'Items that share a tag are suggested together. Use the same tag on a camera and its lenses (mount:EF), batteries (battery:LP-E17) and cards (media:SD). Tag tripods, bags and lights “universal”.')),
    parentTag ? field('Attach to (parent tag)', parentTag, 'For accessories that live on another item, like a lens on a camera body.') : null,
    h('div', { class: 'field span-2' }, h('label', { class: 'check' }, requiresSig, h('span', null, h('strong', null, 'Always require a signature'), h('br'), h('span', { class: 'small muted' }, `Items worth ${fmtMoney(app.settings.signature_threshold_cents)} or more always need one.`)))),
    h('div', { class: 'span-2' }, field('Description (students see this)', description)),
    h('div', { class: 'span-2' }, field('Staff notes', notes)),
    photo ? h('div', { class: 'span-2 field' }, h('span', { class: 'label' }, 'Photo'), photo.el) : null),
  h('div', { class: 'row' }, save, btn('Cancel', { variant: 'ghost', href: editing ? `#/item/${a.id}` : '#/' })),
  h('datalist', { id: 'compat-list' }, tags.map((t) => h('option', { value: t.tag }))),
  h('datalist', { id: 'location-list' }, locations.map((l) => h('option', { value: l.location }))));

  return h('div', { class: 'page page-narrow' },
    backLink(editing ? `#/item/${a.id}` : '#/', editing ? a.name : 'Equipment'),
    h('div', { class: 'page-header' }, h('h1', null, editing ? `Edit ${a.tag}` : 'Add an item')),
    editing ? null : h('p', { class: 'muted', style: { marginTop: '-8px', marginBottom: '14px' } }, 'Tip: add one item, then use “Duplicate” on it for identical units.'),
    form);
}

