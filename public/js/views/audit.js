import { api } from '../api.js';
import { scanField } from '../scanner.js';
import {
  btn, clear, confirmDialog, emptyState, field, fmtDateTime, h, icon, listItem, openModal, plural, tabs,
  tagCode, toast,
} from '../ui.js';
import { assetRow, backLink } from './shared.js';

export async function auditListView({ app }) {
  const [{ audits }, { locations }] = await Promise.all([api.get('/audits'), api.get('/locations')]);
  const location = h('select', { class: 'select' },
    h('option', { value: '' }, 'Everything (all locations)'),
    locations.map((l) => h('option', { value: l.location }, `${l.location} (${l.count})`)));
  const start = btn('Start audit', {
    variant: 'primary', iconName: 'scan',
    onClick: async () => {
      const { audit } = await api.post('/audits', { location: location.value || null });
      app.navigate(`#/audit/${audit.id}`);
    },
  });
  const active = audits.filter((a) => !a.finished_at);
  const done = audits.filter((a) => a.finished_at);
  return h('div', { class: 'page page-narrow' },
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Shelf audit'),
      h('p', { class: 'sub' }, 'Scan everything on a shelf, one after another. The app shows what’s missing and what doesn’t belong.'))),
    h('section', { class: 'card stack' },
      h('div', { class: 'card-title' }, icon('audit'), h('h2', null, 'New audit')),
      field('What are you checking?', location, 'Pick a location to compare against what should be there.'),
      h('div', null, start)),
    active.length ? h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, icon('clock'), h('h2', null, 'In progress')),
      h('div', { class: 'list' }, active.map((a) => listItem({
        href: `#/audit/${a.id}`,
        leading: h('span', { class: 'icon-btn' }, icon('audit')),
        title: a.location ?? 'All locations',
        sub: `Started ${fmtDateTime(a.started_at)} by ${a.started_by} · ${plural(a.scan_count, 'scan')}`,
        trailing: icon('chevron-right'),
      })))) : null,
    h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, icon('history'), h('h2', null, 'Past audits')),
      done.length ? h('div', { class: 'list' }, done.map((a) => listItem({
        href: `#/audit/${a.id}`,
        leading: h('span', { class: 'icon-btn' }, icon('check-circle')),
        title: a.location ?? 'All locations',
        sub: `${fmtDateTime(a.finished_at)} · ${a.counts.found}/${a.counts.expected} found · ${a.counts.missing} missing · ${a.counts.unexpected} unexpected`,
        trailing: a.counts.missing ? h('span', { class: 'badge checked_out' }, `${a.counts.missing} missing`) : h('span', { class: 'badge available' }, 'All found'),
      }))) : h('p', { class: 'small muted' }, 'No audits yet.')));
}

export async function auditView({ params, app }) {
  let { audit } = await api.get(`/audits/${params.id}`);
  if (audit.finished_at) return auditSummary(audit);

  let tab = 'missing';
  const lastScan = h('div', { class: 'last-scan' }, icon('scan'), h('span', null, 'Ready — scan the first item'));
  const progressBar = h('div');
  const progressText = h('div', { class: 'row' });
  const listBox = h('div');

  const render = () => {
    const found = audit.found.length;
    const pct = audit.expected_count ? Math.round((found / audit.expected_count) * 100) : 100;
    clear(progressBar, h('div', { class: 'audit-progress' }, h('div', { style: { width: `${pct}%` } })));
    clear(progressText,
      h('span', { class: 'bold' }, `${found} of ${audit.expected_count} found`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, `${audit.missing.length} missing · ${audit.unexpected.length} unexpected`));
    const lists = {
      missing: audit.missing.length
        ? audit.missing.map((a) => assetRow(a, { showBadge: false, sub: [tagCode(a.tag), ` ${a.category}`] }))
        : [emptyState('check-circle', 'Nothing missing', 'Every expected item has been scanned.')],
      found: audit.found.length
        ? audit.found.map((a) => assetRow(a, {
          showBadge: false,
          sub: [tagCode(a.tag), ` scanned ${fmtDateTime(a.scanned_at)}`],
          trailing: h('button', {
            class: 'icon-btn', type: 'button', title: 'Undo scan',
            onclick: async (e) => {
              e.preventDefault();
              ({ audit } = await api.del(`/audits/${audit.id}/scan/${a.id}`));
              render();
            },
          }, icon('x')),
        }))
        : [h('p', { class: 'small muted', style: { padding: '12px 4px' } }, 'Nothing scanned yet.')],
      unexpected: audit.unexpected.length
        ? audit.unexpected.map((a) => assetRow(a, { sub: h('span', { style: { color: 'var(--res)', fontWeight: 600 } }, `${a.tag} · ${a.reason.message}`) }))
        : [h('p', { class: 'small muted', style: { padding: '12px 4px' } }, 'Nothing out of place.')],
    };
    clear(listBox,
      tabs([
        { value: 'missing', label: 'Missing', count: audit.missing.length },
        { value: 'found', label: 'Found', count: audit.found.length },
        { value: 'unexpected', label: 'Unexpected', count: audit.unexpected.length },
      ], tab, (v) => { tab = v; render(); }),
      h('div', { class: 'list' }, lists[tab]));
  };

  const setLast = (kind, text, sub) => {
    lastScan.className = `last-scan ${kind}`;
    clear(lastScan, icon(kind === 'found' ? 'check-circle' : kind === 'unexpected' ? 'alert' : 'x-circle'),
      h('div', null, h('div', null, text), sub ? h('div', { class: 'small', style: { fontWeight: 500 } }, sub) : null));
  };

  const scanner = scanField({
    placeholder: 'Scan each item on the shelf',
    title: audit.location ? `Auditing ${audit.location}` : 'Auditing everything',
    hint: 'Scan items one after another',
    buttonLabel: 'Add',
    onScan: async (code) => {
      try {
        const res = await api.post(`/audits/${audit.id}/scan`, { code });
        audit = res.audit;
        if (res.result === 'found') {
          setLast('found', `${res.asset.tag} · ${res.asset.name}`, res.duplicate ? 'Already scanned' : 'Found — belongs here');
        } else {
          setLast('unexpected', `${res.asset.tag} · ${res.asset.name}`, res.asset.reason.message);
        }
        render();
        return { ok: res.result === 'found', message: `${res.asset.tag}: ${res.result === 'found' ? 'found' : res.asset.reason.message}` };
      } catch (err) {
        setLast('error', code, err.message);
        return { ok: false, message: err.message };
      }
    },
  });

  const finish = () => {
    const misplaced = audit.unexpected.filter((a) => a.reason.code === 'location').length;
    const lostFound = audit.unexpected.filter((a) => a.reason.code === 'lost').length;
    const checkedOut = audit.unexpected.filter((a) => a.reason.code === 'checked_out');
    const markLost = h('input', { type: 'checkbox' });
    const relocate = h('input', { type: 'checkbox', checked: misplaced > 0 });
    const restore = h('input', { type: 'checkbox', checked: lostFound > 0 });
    openModal({
      title: 'Finish audit',
      body: h('div', { class: 'stack' },
        h('p', null, `${audit.found.length} of ${audit.expected_count} expected items were found.`),
        audit.missing.length ? h('label', { class: 'check' }, markLost, h('span', null, h('strong', null, `Mark ${plural(audit.missing.length, 'missing item')} as lost`), h('br'), h('span', { class: 'small muted' }, 'Adds them to the loss report. Leave unticked if you’ll look again later.'))) : null,
        misplaced && audit.location ? h('label', { class: 'check' }, relocate, h('span', null, `Change the home location of ${plural(misplaced, 'misplaced item')} to ${audit.location}`)) : null,
        lostFound ? h('label', { class: 'check' }, restore, h('span', null, `Put ${plural(lostFound, 'item')} marked lost back into service`)) : null,
        checkedOut.length ? h('div', { class: 'banner warning' }, icon('alert'), h('div', { class: 'b-body' }, `${plural(checkedOut.length, 'item')} on the shelf ${checkedOut.length === 1 ? 'is' : 'are'} still checked out on paper (${checkedOut.map((a) => a.tag).join(', ')}). Process ${checkedOut.length === 1 ? 'its' : 'their'} return from the Return page.`)) : null),
      actions: [
        { label: 'Keep scanning', variant: 'ghost' },
        {
          label: 'Finish audit', variant: 'primary',
          onClick: async () => {
            await api.post(`/audits/${audit.id}/finish`, { mark_missing_lost: markLost.checked, relocate_unexpected: relocate.checked, restore_found_lost: restore.checked });
            toast('Audit saved', 'success');
            app.refresh();
          },
        },
      ],
    });
  };

  render();
  return h('div', { class: 'page page-narrow' },
    backLink('#/audit', 'Shelf audit'),
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, audit.location ? `Auditing ${audit.location}` : 'Auditing all locations'),
        h('p', { class: 'sub' }, `Started ${fmtDateTime(audit.started_at)} by ${audit.started_by}`)),
      btn('Finish', { variant: 'primary', iconName: 'check', onClick: finish })),
    h('div', { class: 'stack' },
      h('section', { class: 'card stack' }, progressText, progressBar, scanner, lastScan),
      h('section', { class: 'card' }, listBox),
      h('div', null, btn('Discard this audit', {
        variant: 'ghost', size: 'sm', iconName: 'trash',
        onClick: async () => {
          if (!await confirmDialog('Discard this audit and its scans?', { danger: true, confirmLabel: 'Discard' })) return;
          await api.del(`/audits/${audit.id}`);
          app.navigate('#/audit');
        },
      }))));
}

function auditSummary(audit) {
  const s = audit.summary;
  const section = (title, items, render, empty) => h('section', { class: 'card' },
    h('div', { class: 'card-title' }, h('h2', null, title, ' ', h('span', { class: 'faint' }, `(${items.length})`))),
    items.length ? h('div', { class: 'list' }, items.map(render)) : h('p', { class: 'small muted' }, empty));
  const row = (a, sub) => listItem({ href: `#/item/${a.id}`, title: a.name, sub: [tagCode(a.tag), ' ', sub ?? a.category] });
  return h('div', { class: 'page page-narrow' },
    backLink('#/audit', 'Shelf audit'),
    h('div', { class: 'page-header' }, h('div', { class: 'grow' },
      h('h1', null, `Audit: ${audit.location ?? 'all locations'}`),
      h('p', { class: 'sub' }, `${fmtDateTime(audit.started_at)} – ${fmtDateTime(audit.finished_at)} · by ${audit.started_by}`))),
    h('div', { class: 'kpis', style: { marginBottom: '14px' } },
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, 'Expected'), h('div', { class: 'v' }, s.expected_count)),
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, h('i', { style: { background: 'var(--ok-dot)' } }), 'Found'), h('div', { class: 'v' }, s.found.length)),
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, h('i', { style: { background: 'var(--out-dot)' } }), 'Missing'), h('div', { class: 'v' }, s.missing.length)),
      h('div', { class: 'kpi' }, h('div', { class: 'k' }, h('i', { style: { background: 'var(--res-dot)' } }), 'Unexpected'), h('div', { class: 'v' }, s.unexpected.length))),
    s.actions?.length ? h('div', { class: 'banner info', style: { marginBottom: '14px' } }, icon('info'), h('div', { class: 'b-body' }, h('strong', null, 'Changes made: '), s.actions.join('; '))) : null,
    h('div', { class: 'stack' },
      section('Missing', s.missing, (a) => row(a), 'Nothing was missing.'),
      section('Unexpected', s.unexpected, (a) => row(a, a.reason?.message), 'Nothing was out of place.'),
      section('Found', s.found, (a) => row(a), 'Nothing was scanned.')));
}
