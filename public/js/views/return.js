import { api, qs } from '../api.js';
import { photoPicker } from '../photo.js';
import { scanField } from '../scanner.js';
import {
  banner, btn, clear, dueText, emptyState, field, fmtDateTime, fmtMoney, h, icon, openModal, plural, segmented,
  tagCode, thumb, toast,
} from '../ui.js';
import { CONDITION_OPTIONS, conditionBadge, personChip } from './shared.js';

/**
 * Return: scan anything from a loan to load it, then confirm every item
 * individually (scan or tap), choose its condition, and optionally add a
 * photo. Kits never return "as a whole" — each piece must be confirmed.
 */
export async function returnView({ query, app }) {
  const admin = app.isAdmin;
  const page = h('div', { class: 'page page-narrow' });
  if (!app.canSelfServe) {
    return clear(page, h('h1', null, 'Return'), h('div', { style: { marginTop: '14px' } },
      banner('info', 'Self returns are turned off. Bring the gear to a teacher so they can check it in.')));
  }

  const loans = new Map(); // loan id -> loan
  const confirmations = new Map(); // loan item id -> { confirmation, condition, notes, photo }
  const rows = new Map(); // loan item id -> row component
  const loansBox = h('div', { class: 'stack' });
  const resultBox = h('div');
  const summary = h('div', { class: 'summary' });
  const submitBtn = btn('Return items', { variant: 'primary', size: 'lg', iconName: 'return', onClick: () => submit() });
  const footer = h('div', { class: 'sticky-actions', hidden: true }, summary, submitBtn);

  const openItems = () => [...loans.values()].flatMap((l) => l.items.filter((i) => !i.outcome).map((i) => ({ loan: l, item: i })));

  function confirmItem(item, how) {
    if (item.outcome) return;
    const existing = confirmations.get(item.id);
    if (existing) {
      if (how === 'scan') existing.confirmation = 'scan';
    } else {
      confirmations.set(item.id, { confirmation: how, condition: null, notes: '', photo: null });
    }
    const row = rows.get(item.id);
    row?.update();
    if (row) {
      row.el.classList.remove('flash');
      void row.el.offsetWidth;
      row.el.classList.add('flash');
      row.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    renderFooter();
  }

  async function onScan(code) {
    const lower = code.toLowerCase();
    const hit = openItems().find(({ item }) => item.asset.tag.toLowerCase() === lower);
    if (hit) {
      confirmItem(hit.item, 'scan');
      return { ok: true, message: `Confirmed ${hit.item.asset.tag} · ${hit.item.asset.name}` };
    }
    try {
      const res = await api.get(`/returns/lookup${qs({ code })}`);
      for (const loan of res.loans) loans.set(loan.id, loan);
      renderLoans();
      if (res.matched.type === 'asset') {
        const found = openItems().find(({ item }) => item.asset.id === res.matched.id);
        if (found) confirmItem(found.item, 'scan');
        return { ok: true, message: `Confirmed ${res.matched.tag} · ${res.matched.name}` };
      }
      if (res.matched.type === 'kit') {
        toast(`Kit ${res.matched.tag} loaded — now scan each item in it to confirm`, 'info', 5000);
        return { ok: true, message: `Kit loaded. Scan each item to confirm it.` };
      }
      toast(`Loaded ${plural(res.loans.length, 'loan')} for ${res.matched.name}`, 'info');
      return { ok: true, message: `${res.matched.name}: ${plural(res.loans.length, 'loan')}` };
    } catch (err) {
      toast(err.message, 'error');
      return { ok: false, message: err.message };
    }
  }

  // --- one row per loan item -----------------------------------------------
  function createRow(initialItem) {
    let item = initialItem;
    let details = null;
    const el = h('div', { class: 'return-item' });

    const buildDetails = (c) => {
      const photo = photoPicker({ label: 'Add photo', onChange: (v) => { c.photo = v; } });
      const notes = h('input', { class: 'input', placeholder: 'Notes (optional)', value: c.notes, oninput: (e) => { c.notes = e.target.value; } });
      const seg = segmented(CONDITION_OPTIONS, c.condition, (v) => {
        c.condition = v;
        photo.setEmphasis(v === 'damaged');
        notes.placeholder = v === 'damaged' ? 'What is broken? Add a photo if you can.' : 'Notes (optional)';
        hint.hidden = v !== 'damaged';
        renderFooter();
      });
      const hint = h('div', { class: 'issue warning', hidden: c.condition !== 'damaged' }, icon('camera'), h('span', null, 'Damaged items go to repair. A photo helps whoever fixes it.'));
      return h('div', { class: 'stack-sm' }, h('div', { class: 'small bold' }, 'Condition'), seg, hint, h('div', { class: 'row' }, h('div', { style: { flex: '1', minWidth: '180px' } }, notes), photo.el));
    };

    const update = () => {
      const c = confirmations.get(item.id);
      el.className = `return-item${c ? ' confirmed' : ''}`;
      let state;
      let actions = null;
      if (item.outcome === 'returned') {
        state = h('span', { class: 'confirm-state', style: { color: 'var(--ok)' } }, icon('check-circle'), 'Returned', item.condition_in ? [' · ', conditionBadge(item.condition_in)] : null);
      } else if (item.outcome === 'lost') {
        state = h('span', { class: 'confirm-state', style: { color: 'var(--out)' } }, icon('alert'), 'Marked lost');
      } else if (c) {
        state = h('span', { class: 'confirm-state' }, icon('check-circle'), c.confirmation === 'scan' ? 'Scanned' : 'Confirmed by hand');
        actions = btn('Undo', { size: 'sm', variant: 'ghost', onClick: () => { confirmations.delete(item.id); details = null; update(); renderFooter(); } });
      } else {
        state = h('span', { class: 'confirm-state' }, icon('scan'), 'Scan to confirm');
        actions = h('div', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' } },
          btn('Confirm', { size: 'sm', iconName: 'check', onClick: () => confirmItem(item, 'manual') }),
          admin ? btn('Lost', { size: 'sm', variant: 'ghost', onClick: () => markLost(item) }) : null);
      }
      const head = h('div', { class: 'return-head' },
        thumb(item.asset, 'sm'),
        h('div', { class: 'info' },
          h('div', { class: 'bold truncate' }, item.asset.name),
          h('div', { class: 'row small muted', style: { gap: '6px' } }, tagCode(item.asset.tag), item.kit ? `kit ${item.kit.tag}` : item.asset.category),
          state),
        actions ? h('div', { class: 'actions' }, actions) : null);
      if (c && !item.outcome) details ??= buildDetails(c);
      else details = null;
      clear(el, head, details);
    };
    update();
    return {
      el,
      update,
      setItem(next) {
        item = next;
        update();
      },
    };
  }

  function rowFor(item) {
    let row = rows.get(item.id);
    if (row) row.setItem(item);
    else {
      row = createRow(item);
      rows.set(item.id, row);
    }
    return row.el;
  }

  function loanCard(loan) {
    const open = loan.items.filter((i) => !i.outcome);
    const closedNow = loan.items.filter((i) => i.outcome);
    return h('section', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '6px' } },
        admin ? personChip(loan.borrower) : h('div', { class: 'bold' }, 'Your loan'),
        h('span', { class: 'spacer' }),
        h('a', { href: `#/loan/${loan.id}`, class: 'small' }, `Loan #${loan.id}`)),
      h('div', { class: 'small muted', style: { marginBottom: '6px' } },
        `Out since ${fmtDateTime(loan.checked_out_at)} · `,
        loan.closed_at ? h('span', { style: { color: 'var(--ok)', fontWeight: 650 } }, 'All items returned')
          : h('span', { style: loan.overdue ? { color: 'var(--out)', fontWeight: 650 } : {} }, dueText(loan.due_at)),
        open.length && closedNow.length ? ` · ${open.length} of ${loan.items.length} still out` : ''),
      open.length > 1 ? h('p', { class: 'small faint' }, 'Scan or confirm each item that is coming back.') : null,
      h('div', null, [...open, ...closedNow].map((i) => rowFor(i))));
  }

  function renderLoans() {
    if (loans.size === 0) {
      clear(loansBox, emptyState('return', 'Scan something to start', admin
        ? 'Scan any item, a kit label or a student ID card to load what they have out.'
        : 'Scan any item you are bringing back.'));
    } else {
      clear(loansBox, [...loans.values()].map(loanCard));
    }
    renderFooter();
  }

  function renderFooter() {
    const confirmed = openItems().filter(({ item }) => confirmations.has(item.id));
    const missingCondition = confirmed.filter(({ item }) => !confirmations.get(item.id).condition).length;
    footer.hidden = loans.size === 0;
    clear(summary,
      h('div', { class: 'bold' }, `${plural(confirmed.length, 'item')} confirmed`),
      h('div', { class: 'small muted' }, missingCondition ? `Choose the condition for ${plural(missingCondition, 'item')}` : confirmed.length ? 'Ready to check in' : 'Scan or confirm items first'));
    submitBtn.querySelector('span:last-child').textContent = confirmed.length ? `Return ${confirmed.length}` : 'Return items';
    submitBtn.disabled = confirmed.length === 0 || missingCondition > 0;
  }

  async function submit() {
    const confirmed = openItems().filter(({ item }) => confirmations.has(item.id));
    submitBtn.disabled = true;
    try {
      const res = await api.post('/returns', {
        items: confirmed.map(({ item }) => {
          const c = confirmations.get(item.id);
          return { loan_item_id: item.id, condition: c.condition, notes: c.notes || undefined, photo: c.photo || undefined, confirmation: c.confirmation };
        }),
      });
      for (const { item } of confirmed) confirmations.delete(item.id);
      for (const loan of res.loans) loans.set(loan.id, loan);
      renderLoans();
      const msgs = [h('div', { class: 'bold' }, `${plural(res.returned, 'item')} checked back in.`)];
      if (res.incidents) msgs.push(h('div', null, `${plural(res.incidents, 'damage report')} recorded.`));
      for (const f of res.fines) msgs.push(h('div', null, `Late fine: ${fmtMoney(f.amount_cents)} — ${f.reason}`));
      const stillOut = openItems().length;
      if (stillOut) msgs.push(h('div', null, `${plural(stillOut, 'item')} still out on ${loans.size === 1 ? 'this loan' : 'these loans'}.`));
      clear(resultBox, banner(res.fines.length || res.incidents ? 'warning' : 'success', msgs));
      toast(`Returned ${plural(res.returned, 'item')}`, 'success');
      if (!admin) app.refreshMe().catch(() => {});
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toast(err.message, 'error');
      renderFooter();
    }
  }

  function markLost(item) {
    const notes = h('textarea', { class: 'textarea', placeholder: 'What happened?' });
    const charge = h('input', { type: 'checkbox' });
    openModal({
      title: `Mark ${item.asset.tag} as lost`,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, `${item.asset.name} will be closed on this loan, marked lost and added to the loss report.`),
        field('Notes', notes),
        item.asset.value_cents ? h('label', { class: 'check' }, charge, h('span', null, `Add a replacement fine of ${fmtMoney(item.asset.value_cents)}`)) : null),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Mark lost', variant: 'solid-danger',
          onClick: async () => {
            const { loan } = await api.post(`/loan-items/${item.id}/lost`, { notes: notes.value, charge_replacement: charge.checked });
            confirmations.delete(item.id);
            loans.set(loan.id, loan);
            renderLoans();
            toast(`${item.asset.tag} marked lost`, 'warning');
          },
        },
      ],
    });
  }

  // --- prefill -------------------------------------------------------------
  try {
    if (query.loan) {
      const { loan } = await api.get(`/loans/${encodeURIComponent(query.loan)}`);
      loans.set(loan.id, loan);
    } else if (!admin) {
      const { loans: mine } = await api.get('/loans?scope=open');
      for (const loan of mine) loans.set(loan.id, loan);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  renderLoans();
  if (query.code) await onScan(query.code);

  clear(page,
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Return'),
      h('p', { class: 'sub' }, 'Scan each item coming back, then record its condition.'))),
    h('div', { class: 'stack' },
      resultBox,
      h('section', { class: 'card' }, scanField({
        placeholder: admin ? 'Scan an item, kit or student ID' : 'Scan an item you are returning',
        title: 'Scan returning items',
        hint: 'Scan each item that is coming back',
        buttonLabel: 'Go',
        onScan,
      })),
      loansBox),
    footer);
  return page;
}
