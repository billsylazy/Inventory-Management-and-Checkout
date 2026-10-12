import { api, qs } from '../api.js';
import { scanField } from '../scanner.js';
import { signaturePad } from '../signature.js';
import {
  assetCard, banner, btn, clear, debounce, field, fmtDateTime, fmtMoney, fromLocalInput, h, icon, defaultDue, listItem,
  plural, segmented, tagCode, thumb, toLocalInput, toast, badge,
} from '../ui.js';
import {
  assetRow, issueList, personChip, restrictionContent, userPicker,
} from './shared.js';

/**
 * Check-out: pick the borrower, scan items or kits, choose a due date, and
 * sign for high-value gear. Every change re-validates against the server.
 */
export async function checkoutView({ query, app }) {
  const admin = app.isAdmin;
  const page = h('div', { class: 'page page-narrow' });
  if (!app.canSelfServe) {
    return clear(page, h('h1', null, 'Check out'), h('div', { style: { marginTop: '14px' } },
      banner('info', 'Self check-out is turned off. Bring the gear you want to a teacher.')));
  }

  const state = {
    borrower: admin ? null : app.user,
    entries: [], // { type: 'asset'|'kit', id, tag, name, item }
    plan: null,
    bookings: [],
  };

  // --- persistent controls -------------------------------------------------
  const due = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(defaultDue(app.settings.loan_days_default)) });
  due.addEventListener('change', () => refreshPlan());
  const override = h('textarea', { class: 'textarea', rows: 2, placeholder: 'e.g. Needed for the final project, parent called' });
  override.addEventListener('input', debounce(() => refreshPlan(), 400));
  const notes = h('input', { class: 'input', placeholder: 'Optional note for this loan' });

  const signerName = h('input', { class: 'input', placeholder: 'Full name of the person signing' });
  let signerRole = 'student';
  const pad = signaturePad({ onChange: () => renderFooter() });
  signerName.addEventListener('input', () => renderFooter());

  const borrowerBox = h('div');
  const restrictionBox = h('div');
  const cartBox = h('div');
  const suggestBox = h('div');
  const overrideBox = h('div', { hidden: true }, field('Override reason (staff)', override, 'Required to check out to a restricted student or over someone else’s booking.'));
  const sigItems = h('div');
  const dueLabel = h('strong');
  const sigSection = h('section', { class: 'card stack', hidden: true },
    h('div', { class: 'card-title' }, icon('pen'), h('h2', null, 'Signature required')),
    sigItems,
    h('div', { class: 'form-grid cols-2' },
      field('Signed by', signerName),
      field('Signing as', segmented([
        { value: 'student', label: 'Student' }, { value: 'parent', label: 'Parent' }, { value: 'teacher', label: 'Teacher' },
      ], 'student', (v) => { signerRole = v; }))),
    h('p', { class: 'small muted' }, 'By signing I accept responsibility for this equipment until it is returned by ', dueLabel,
      ', and I will report any damage or loss right away.'),
    pad.el);
  const summary = h('div', { class: 'summary' });
  const confirm = btn('Check out', { variant: 'primary', size: 'lg', iconName: 'check', onClick: () => submit() });
  const footer = h('div', { class: 'sticky-actions' }, summary, confirm);

  const scanner = scanField({
    placeholder: 'Scan or type an item or kit tag',
    title: 'Scan items to check out',
    hint: 'Scan each item or a kit label',
    onScan: (code) => addCode(code),
  });

  // --- behaviour -------------------------------------------------------------
  async function addCode(code) {
    let res;
    try {
      res = await api.get(`/scan${qs({ code })}`);
    } catch (err) {
      toast(err.message, 'error');
      return { ok: false, message: err.message };
    }
    if (res.type === 'user') {
      if (!admin) return { ok: false, message: 'That is a student ID' };
      setBorrower(res.user);
      return { ok: true, message: `Borrower: ${res.user.name}` };
    }
    const item = res.type === 'kit' ? res.kit : res.asset;
    const already = state.entries.some((e) => e.type === res.type && e.id === item.id)
      || (res.type === 'asset' && state.plan?.lines.some((l) => l.asset.id === item.id));
    if (already) {
      toast(`${item.tag} is already in the list`, 'info');
      return { ok: true, message: `${item.tag} already added` };
    }
    state.entries.push({ type: res.type, id: item.id, tag: item.tag, name: item.name, item });
    await refreshPlanNow();
    const line = state.plan?.lines.find((l) => (res.type === 'kit' ? l.kit?.id === item.id : l.asset.id === item.id));
    const error = line?.issues.find((i) => i.level === 'error');
    if (error) {
      toast(`${item.tag}: ${error.message}`, 'error');
      return { ok: false, message: `${item.tag}: ${error.message}` };
    }
    toast(`Added ${item.name}`, 'success', 1800);
    return { ok: true, message: `Added ${item.tag} · ${item.name}` };
  }

  function setBorrower(user) {
    state.borrower = user;
    signerName.value = user.name;
    renderBorrower();
    refreshPlan();
    if (admin) {
      api.get(`/reservations${qs({ user_id: user.id, active: 1 })}`).then(({ reservations }) => {
        state.bookings = reservations;
        renderBorrower();
      }).catch(() => {});
    }
  }

  function loadBooking(r) {
    const seenKits = new Set();
    for (const item of r.items) {
      if (item.kit) {
        if (seenKits.has(item.kit.id) || state.entries.some((e) => e.type === 'kit' && e.id === item.kit.id)) continue;
        seenKits.add(item.kit.id);
        state.entries.push({ type: 'kit', id: item.kit.id, tag: item.kit.tag, name: item.kit.name, item: null });
      } else if (!item.parent_id || !r.items.some((o) => o.id === item.parent_id)) {
        if (!state.entries.some((e) => e.type === 'asset' && e.id === item.id)) state.entries.push({ type: 'asset', id: item.id, tag: item.tag, name: item.name, item });
      }
    }
    const end = new Date(r.end_at);
    if (end > new Date()) due.value = toLocalInput(end);
    refreshPlanNow();
  }

  let planSeq = 0;
  async function refreshPlanNow() {
    const seq = ++planSeq;
    if (!state.borrower || state.entries.length === 0) {
      state.plan = null;
      render();
      return;
    }
    try {
      const plan = await api.post('/checkout/preview', {
        borrower_id: state.borrower.id,
        entries: state.entries.map((e) => ({ type: e.type, id: e.id })),
        due_at: fromLocalInput(due.value),
        override_reason: admin ? override.value : undefined,
      });
      if (seq !== planSeq) return;
      state.plan = plan;
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }
  const refreshPlan = debounce(refreshPlanNow, 150);

  function removeEntry(entry) {
    state.entries = state.entries.filter((e) => e !== entry);
    refreshPlan();
  }

  async function submit() {
    const plan = state.plan;
    if (!plan?.can_checkout) return;
    if (plan.signature_required && (pad.isEmpty() || !signerName.value.trim())) {
      toast('Please sign and enter the signer’s name first', 'warning');
      return;
    }
    confirm.disabled = true;
    try {
      const { loan } = await api.post('/checkout', {
        borrower_id: state.borrower.id,
        entries: state.entries.map((e) => ({ type: e.type, id: e.id })),
        due_at: fromLocalInput(due.value),
        override_reason: admin ? override.value : undefined,
        notes: notes.value,
        signature: plan.signature_required ? { signer_name: signerName.value, signer_role: signerRole, image: pad.toDataURL() } : undefined,
      });
      if (!admin) app.refreshMe().catch(() => {});
      showReceipt(loan);
    } catch (err) {
      toast(err.message, 'error');
      confirm.disabled = false;
      refreshPlanNow();
    }
  }

  // --- rendering -------------------------------------------------------------
  function renderBorrower() {
    if (!admin) {
      clear(borrowerBox, h('div', { class: 'card card-tight row' }, personChip(app.user), h('span', { class: 'spacer' }),
        h('span', { class: 'small muted' }, 'Checking out for yourself')));
      return;
    }
    if (!state.borrower) {
      clear(borrowerBox, h('section', { class: 'card' },
        h('div', { class: 'card-title' }, h('span', { class: 'avatar' }, '1'), h('h2', null, 'Who is borrowing?')),
        userPicker({ onSelect: setBorrower })));
      return;
    }
    clear(borrowerBox, h('section', { class: 'card stack' },
      h('div', { class: 'row' }, personChip(state.borrower, { href: `#/people/${state.borrower.id}` }), h('span', { class: 'spacer' }),
        btn('Change', { size: 'sm', onClick: () => { state.borrower = null; state.bookings = []; state.plan = null; render(); } })),
      state.bookings.length ? h('div', { class: 'stack-sm' },
        h('div', { class: 'small bold' }, 'Bookings ready for pickup'),
        state.bookings.map((r) => h('div', { class: 'row' },
          h('span', { class: 'small spacer' }, `${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)} · ${plural(r.items.length, 'item')}`),
          btn('Load booking', { size: 'sm', iconName: 'calendar', onClick: () => loadBooking(r) })))) : null));
  }

  function groupLines(lines) {
    const groups = [];
    let current = null;
    for (const line of lines) {
      const startsGroup = line.source === 'scan' || (line.source === 'kit' && current?.kit?.id !== line.kit?.id) || !current;
      if (startsGroup) {
        current = { kit: line.source === 'kit' ? line.kit : null, lines: [] };
        current.entry = current.kit
          ? state.entries.find((e) => e.type === 'kit' && e.id === current.kit.id)
          : state.entries.find((e) => e.type === 'asset' && e.id === line.asset.id);
        groups.push(current);
      }
      current.lines.push(line);
    }
    return groups;
  }

  function lineRow(line, entry) {
    const removable = line.source === 'scan' && entry;
    return listItem({
      className: `${line.source === 'attached' ? 'indent' : ''} ${line.include ? '' : 'excluded'}`,
      leading: thumb(line.asset, 'sm'),
      title: [h('span', { class: 'truncate' }, line.asset.name), line.signature_required ? h('span', { title: 'Signature required' }, icon('pen')) : null],
      sub: h('div', null,
        h('div', { class: 'row', style: { gap: '6px' } }, tagCode(line.asset.tag),
          `${line.source === 'attached' ? `attached to ${line.parent?.tag}` : line.asset.category}${line.asset.value_cents ? ` · ${fmtMoney(line.asset.value_cents)}` : ''}`),
        issueList(line.issues)),
      trailing: removable ? h('button', { class: 'icon-btn', type: 'button', title: 'Remove', onclick: () => removeEntry(entry) }, icon('x')) : null,
    });
  }

  function renderCart() {
    if (state.entries.length === 0) {
      clear(cartBox, h('div', { class: 'empty', style: { padding: '24px 8px' } }, icon('scan'),
        h('h3', null, 'Nothing scanned yet'), h('p', { class: 'small' }, 'Scan the barcode or QR label on each item — or one kit label for the whole kit.')));
      return;
    }
    if (!state.plan) {
      // Borrower not chosen yet: show what was scanned.
      clear(cartBox, h('div', { class: 'list' }, state.entries.map((e) => (e.item
        ? (e.type === 'kit'
          ? listItem({ leading: h('span', { class: 'icon-btn' }, icon('kit')), title: e.item.name, sub: [tagCode(e.tag), ` ${plural(e.item.item_count, 'item')}`], trailing: badge(e.item.status) })
          : assetRow(e.item, { href: undefined }))
        : listItem({ title: e.name, sub: tagCode(e.tag) })))));
      return;
    }
    clear(cartBox, groupLines(state.plan.lines).map((g) => {
      if (g.kit) {
        return h('div', { class: 'cart-group' },
          h('div', { class: 'cart-group-head' }, icon('kit'), h('span', { class: 'spacer' }, g.kit.name, ' ', tagCode(g.kit.tag)),
            g.entry ? h('button', { class: 'icon-btn', type: 'button', title: 'Remove kit', onclick: () => removeEntry(g.entry) }, icon('x')) : null),
          h('div', { class: 'list' }, g.lines.map((l) => lineRow(l, null))));
      }
      return h('div', { class: 'cart-group' }, h('div', { class: 'list' }, g.lines.map((l) => lineRow(l, g.entry))));
    }));
  }

  function renderSuggestions() {
    const sugg = state.plan?.suggestions ?? [];
    if (!sugg.length) return clear(suggestBox);
    clear(suggestBox, h('section', { class: 'card stack' },
      h('div', { class: 'card-title' }, icon('link'), h('h2', null, 'Compatible accessories')),
      sugg.map((s) => h('div', { class: 'stack-sm' },
        h('div', { class: 'small muted' }, 'Available and works with ', h('strong', null, s.for.name)),
        h('div', { class: 'suggest-strip' }, s.items.map((a) => assetCard(a, {
          onClick: () => addCode(a.tag),
          extra: h('div', { class: 'extra', style: { color: 'var(--primary)', fontWeight: 650 } }, '+ Add'),
        })))))));
  }

  function renderRestriction() {
    const plan = state.plan;
    clear(restrictionBox);
    if (!plan) {
      if (!admin) restrictionBox.append(restrictionContent(app.restriction) ?? '');
      overrideBox.hidden = true;
      return;
    }
    const content = restrictionContent(plan.restriction, { self: !admin, name: plan.borrower.name });
    if (content) restrictionBox.append(content);
    const otherErrors = plan.errors.filter((e) => e.code !== 'restricted' && e.code !== 'empty');
    if (otherErrors.length) restrictionBox.append(banner('danger', otherErrors.map((e) => e.message).join(' ')));
    const overridable = plan.restriction.restricted || plan.lines.some((l) => l.issues.some((i) => /booked/i.test(i.message)));
    overrideBox.hidden = !(admin && (overridable || override.value));
  }

  function renderSignature() {
    const plan = state.plan;
    sigSection.hidden = !plan?.signature_required;
    if (!plan?.signature_required) return;
    dueLabel.textContent = fmtDateTime(plan.due_at);
    if (!signerName.value && state.borrower) signerName.value = state.borrower.name;
    clear(sigItems, h('p', { class: 'small muted' }, 'High-value gear needs a signature from the student, a parent or a teacher before it leaves the room:'),
      h('ul', { class: 'small', style: { margin: '6px 0 0', paddingLeft: '18px' } },
        plan.signature_items.map((i) => h('li', null, `${i.name} (${i.tag})${i.value_cents ? ` — ${fmtMoney(i.value_cents)}` : ''}`))));
  }

  function renderFooter() {
    const plan = state.plan;
    if (!state.borrower) {
      clear(summary, h('span', { class: 'muted' }, admin ? 'Choose who is borrowing' : ''));
      confirm.disabled = true;
      return;
    }
    if (!plan) {
      clear(summary, h('span', { class: 'muted' }, 'Scan items to add them'));
      confirm.disabled = true;
      return;
    }
    const needsSig = plan.signature_required && (pad.isEmpty() || !signerName.value.trim());
    clear(summary,
      h('div', { class: 'bold' }, `${plural(plan.item_count, 'item')}${plan.total_value_cents ? ` · ${fmtMoney(plan.total_value_cents)}` : ''}`),
      h('div', { class: 'small muted' }, plan.can_checkout ? (needsSig ? 'Signature needed' : `Due ${fmtDateTime(plan.due_at)}`) : 'Fix the problems above to continue'));
    confirm.querySelector('span:last-child').textContent = `Check out ${plan.item_count || ''}`.trim();
    confirm.disabled = !plan.can_checkout || needsSig;
  }

  function render() {
    renderRestriction();
    renderCart();
    renderSuggestions();
    renderSignature();
    renderFooter();
  }

  function showReceipt(loan) {
    const sig = loan.signatures[0];
    clear(page,
      h('div', { class: 'card' },
        h('div', { class: 'success-hero' },
          h('div', { class: 'check' }, icon('check')),
          h('h1', null, 'Checked out!'),
          h('p', { class: 'muted', style: { marginTop: '6px' } }, `${plural(loan.items.length, 'item')} to ${loan.borrower.name}. Due back ${fmtDateTime(loan.due_at)}.`),
          sig ? h('p', { class: 'small muted', style: { marginTop: '4px' } }, icon('pen'), ` Signed by ${sig.signer_name} (${sig.signer_role})`) : null),
        h('div', { class: 'list' }, loan.items.map((i) => assetRow(i.asset, { showBadge: false, sub: [tagCode(i.asset.tag), i.kit ? ` in ${i.kit.tag}` : ''] }))),
        h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'center' } },
          btn('Check out more', { variant: 'primary', iconName: 'scan', onClick: () => app.navigate('#/checkout') }),
          btn('View loan', { href: `#/loan/${loan.id}` }))));
    window.scrollTo(0, 0);
  }

  // --- prefill from links ("Check out" on an item, a kit, or a booking) -----
  if (!admin) signerName.value = app.user.name;
  if (admin && query.borrower) {
    try {
      const { user } = await api.get(`/users/${encodeURIComponent(query.borrower)}`);
      state.borrower = user;
      signerName.value = user.name;
    } catch { /* ignore */ }
  }
  if (query.reservation) {
    try {
      const { reservation } = await api.get(`/reservations/${encodeURIComponent(query.reservation)}`);
      if (admin) state.borrower = { ...reservation.user, role: 'student' };
      signerName.value = state.borrower?.name ?? '';
      loadBooking(reservation);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (query.add) await addCode(query.add);
  if (query.kit) {
    try {
      const { kit } = await api.get(`/kits/${encodeURIComponent(query.kit)}`);
      await addCode(kit.tag);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (admin && state.borrower) setBorrower(state.borrower);

  renderBorrower();
  render();

  clear(page,
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Check out'),
      h('p', { class: 'sub' }, admin ? 'Choose the student, then scan each item or kit.' : 'Scan each item or kit label you are taking.'))),
    h('div', { class: 'stack' },
      borrowerBox,
      restrictionBox,
      h('section', { class: 'card stack' },
        h('div', { class: 'card-title' }, icon('scan'), h('h2', null, 'Items')),
        scanner,
        cartBox),
      suggestBox,
      h('section', { class: 'card stack' },
        h('div', { class: 'card-title' }, icon('clock'), h('h2', null, 'Due back')),
        h('div', { class: 'form-grid cols-2' }, field('Due date and time', due, admin ? null : `Up to ${plural(app.settings.max_loan_days, 'day')}.`), field('Note', notes)),
        overrideBox),
      sigSection),
    footer);
  return page;
}
