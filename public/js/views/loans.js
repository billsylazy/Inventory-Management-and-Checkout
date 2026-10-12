import { api } from '../api.js';
import {
  btn, clear, dueText, emptyState, field, fmtDateTime, fromLocalInput, h, icon, listItem, openModal, plural, tabs,
  tagCode, thumb, toLocalInput, toast,
} from '../ui.js';
import { assetRow, backLink, conditionBadge, personChip, restrictionBanner } from './shared.js';

function loanStatus(loan) {
  if (loan.closed_at) return h('span', { class: 'badge available' }, 'Returned');
  if (loan.overdue) return h('span', { class: 'badge checked_out' }, 'Overdue');
  return h('span', { class: 'badge reserved' }, 'Out');
}

function itemsSummary(loan) {
  const names = loan.items.map((i) => i.asset.name);
  const kits = [...new Set(loan.items.filter((i) => i.kit).map((i) => i.kit.name))];
  const parts = kits.length ? [...kits, ...loan.items.filter((i) => !i.kit).map((i) => i.asset.name)] : names;
  return parts.length > 2 ? `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more` : parts.join(', ');
}

export function loanListItem(loan, { showBorrower = true } = {}) {
  const open = loan.items.filter((i) => !i.outcome).length;
  return listItem({
    href: `#/loan/${loan.id}`,
    leading: thumb(loan.items[0].asset, 'sm'),
    title: showBorrower ? loan.borrower.name : itemsSummary(loan),
    sub: [
      showBorrower ? `${itemsSummary(loan)} · ` : '',
      loan.closed_at ? `Returned ${fmtDateTime(loan.closed_at)}` : h('span', { style: loan.overdue ? { color: 'var(--out)', fontWeight: 650 } : {} }, dueText(loan.due_at)),
      !loan.closed_at && open < loan.items.length ? ` · ${open} of ${loan.items.length} still out` : '',
    ],
    trailing: loanStatus(loan),
  });
}

export async function loansView({ query, app }) {
  const admin = app.isAdmin;
  const scope = ['open', 'overdue', 'closed'].includes(query.scope) ? query.scope : 'open';
  const page = h('div', { class: 'page' });

  if (!admin) {
    const [{ loans }, { reservations }] = await Promise.all([api.get('/loans?scope=all'), api.get('/reservations')]);
    await app.refreshMe();
    const open = loans.filter((l) => !l.closed_at);
    const past = loans.filter((l) => l.closed_at);
    const upcoming = reservations.filter((r) => ['booked', 'ready'].includes(r.state));
    return clear(page,
      h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'My gear'), h('p', { class: 'sub' }, 'What you have out, what you’ve booked, and your history.'))),
      restrictionBanner(app),
      h('section', { class: 'card' },
        h('div', { class: 'card-title' }, icon('clock'), h('h2', null, 'Checked out to you'), app.canSelfServe && open.length ? btn('Return', { size: 'sm', iconName: 'return', href: '#/return' }) : null),
        open.length ? h('div', { class: 'list' }, open.flatMap((l) => l.items.filter((i) => !i.outcome).map((i) => assetRow(i.asset, {
          sub: [tagCode(i.asset.tag), ' ', h('span', { style: l.overdue ? { color: 'var(--out)', fontWeight: 650 } : {} }, dueText(l.due_at))],
        })))) : h('p', { class: 'muted small' }, 'Nothing right now.')),
      h('section', { class: 'card' },
        h('div', { class: 'card-title' }, icon('calendar'), h('h2', null, 'Your bookings'), app.canBook ? btn('Book gear', { size: 'sm', iconName: 'plus', href: '#/bookings/new' }) : null),
        upcoming.length ? h('div', { class: 'list' }, upcoming.map((r) => listItem({
          href: '#/bookings',
          leading: thumb(r.items[0], 'sm'),
          title: `${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}`,
          sub: r.items.map((i) => i.name).slice(0, 3).join(', ') + (r.items.length > 3 ? ` +${r.items.length - 3}` : ''),
          trailing: h('span', { class: 'badge reserved' }, r.state === 'ready' ? 'Ready' : 'Booked'),
        }))) : h('p', { class: 'muted small' }, 'No upcoming bookings.')),
      past.length ? h('section', { class: 'card' },
        h('div', { class: 'card-title' }, icon('history'), h('h2', null, 'History')),
        h('div', { class: 'list' }, past.slice(0, 30).map((l) => loanListItem(l, { showBorrower: false })))) : null);
  }

  const [{ loans }, overview] = await Promise.all([
    api.get(`/loans?scope=${scope === 'closed' ? 'closed' : scope}`),
    api.get('/reports/overview'),
  ]);
  const c = overview.counts;
  const kpi = (label, value, color, href, sub) => h('a', { class: 'kpi', href }, h('div', { class: 'k' }, color ? h('i', { style: { background: color } }) : null, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
  return clear(page,
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, 'Loans'), h('p', { class: 'sub' }, 'Everything that is out right now.')),
      btn('Check out', { variant: 'primary', iconName: 'checkout', href: '#/checkout' }),
      btn('Return', { iconName: 'return', href: '#/return' })),
    h('div', { class: 'kpis', style: { marginBottom: '18px' } },
      kpi('Available', c.available, 'var(--ok-dot)', '#/?status=available', `of ${c.total} items`),
      kpi('Checked out', c.checked_out, 'var(--out-dot)', '#/?status=checked_out', `${plural(overview.due_today, 'loan')} due in 24 h`),
      kpi('Overdue loans', overview.overdue_loans, 'var(--out-dot)', '#/loans?scope=overdue', `${plural(c.overdue, 'item')}`),
      kpi('Reserved / out of service', `${c.reserved} / ${c.unavailable}`, 'var(--res-dot)', '#/?status=unavailable', `${plural(overview.open_incidents, 'open incident')}`)),
    tabs([
      { value: 'open', label: 'Out now', href: '#/loans' },
      { value: 'overdue', label: 'Overdue', href: '#/loans?scope=overdue' },
      { value: 'closed', label: 'Returned', href: '#/loans?scope=closed' },
    ], scope),
    loans.length
      ? h('div', { class: 'card card-tight' }, h('div', { class: 'list' }, loans.map((l) => loanListItem(l))))
      : emptyState('check-circle', scope === 'overdue' ? 'Nothing overdue' : 'Nothing here', scope === 'open' ? 'No gear is checked out right now.' : null));
}

export async function loanView({ params, app }) {
  const { loan } = await api.get(`/loans/${params.id}`);
  const admin = app.isAdmin;
  const open = loan.items.filter((i) => !i.outcome);

  const extend = () => {
    const input = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(new Date(Math.max(Date.now(), new Date(loan.due_at).getTime()) + 86400_000)) });
    openModal({
      title: 'Change due date',
      body: field('New due date', input),
      actions: [
        { label: 'Cancel', variant: 'ghost' },
        {
          label: 'Save', variant: 'primary',
          onClick: async () => {
            await api.post(`/loans/${loan.id}/extend`, { due_at: fromLocalInput(input.value) });
            toast('Due date updated', 'success');
            app.refresh();
          },
        },
      ],
    });
  };

  const outcome = (i) => {
    if (!i.outcome) return h('span', { class: 'badge checked_out' }, 'Out');
    if (i.outcome === 'lost') return h('span', { class: 'badge checked_out plain' }, 'Lost');
    return h('div', { class: 'stack-sm', style: { alignItems: 'flex-end', gap: '2px' } }, conditionBadge(i.condition_in),
      h('span', { class: 'tiny faint' }, i.confirmation === 'scan' ? 'scanned' : 'confirmed by hand'));
  };

  return h('div', { class: 'page page-narrow' },
    backLink(admin ? '#/loans' : '#/loans', admin ? 'Loans' : 'My gear'),
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, `Loan #${loan.id}`),
        h('p', { class: 'sub' }, `Checked out ${fmtDateTime(loan.checked_out_at)}${loan.issued_by ? ` by ${loan.issued_by}` : ''}`)),
      loanStatus(loan)),
    h('section', { class: 'card stack' },
      admin ? personChip(loan.borrower, { href: `#/people/${loan.borrower.id}` }) : null,
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Due'), h('div', { class: 'v', style: loan.overdue ? { color: 'var(--out)' } : {} }, fmtDateTime(loan.due_at))),
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Status'), h('div', { class: 'v' }, loan.closed_at ? `Closed ${fmtDateTime(loan.closed_at)}` : dueText(loan.due_at))),
        h('div', { class: 'fact' }, h('div', { class: 'k' }, 'Items'), h('div', { class: 'v' }, `${loan.items.length} (${open.length} out)`))),
      loan.notes ? h('p', { class: 'small' }, h('strong', null, 'Note: '), loan.notes) : null,
      loan.override_reason ? h('p', { class: 'small', style: { color: 'var(--res)' } }, h('strong', null, 'Staff override: '), loan.override_reason) : null,
      open.length ? h('div', { class: 'action-bar' },
        app.canSelfServe ? btn('Return items', { variant: 'primary', iconName: 'return', href: `#/return?loan=${loan.id}` }) : null,
        admin ? btn('Change due date', { iconName: 'clock', onClick: extend }) : null) : null),
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, icon('box'), h('h2', null, 'Items')),
      h('div', { class: 'list' }, loan.items.map((i) => h('div', null,
        assetRow(i.asset, {
          showBadge: false,
          sub: h('span', null, tagCode(i.asset.tag), i.kit ? ` kit ${i.kit.tag}` : '', i.closed_at ? ` · back ${fmtDateTime(i.closed_at)}${i.closed_by ? ` (${i.closed_by})` : ''}` : '',
            i.return_notes ? h('div', { class: 'small' }, `“${i.return_notes}”`) : null),
          trailing: outcome(i),
        }),
        i.return_photo_url ? h('a', { href: i.return_photo_url, target: '_blank', rel: 'noopener', style: { display: 'block', margin: '0 0 10px 64px' } },
          h('img', { src: i.return_photo_url, alt: 'Return photo', style: { width: '140px', borderRadius: '8px', border: '1px solid var(--border)' } })) : null)))),
    loan.signatures.length ? h('section', { class: 'card' },
      h('div', { class: 'card-title' }, icon('pen'), h('h2', null, 'Signatures')),
      loan.signatures.map((s) => h('div', { class: 'stack-sm' },
        h('div', { class: 'small' }, h('strong', null, s.signer_name), ` (${s.signer_role}) · ${fmtDateTime(s.signed_at)}`),
        s.image_url ? h('img', { class: 'sig-image', src: s.image_url, alt: `Signature of ${s.signer_name}` }) : h('p', { class: 'small muted' }, 'Signature on file.'))))
      : null);
}
