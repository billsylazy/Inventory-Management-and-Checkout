import { api, qs } from '../api.js';
import {
  btn, clear, emptyState, fmtDate, fmtDateTime, fmtMoney, h, icon, plural, tagCode,
} from '../ui.js';

const RANGES = [
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: '365', label: 'Last 12 months', days: 365 },
  { value: 'all', label: 'All time', days: 365 * 5 },
];

const SERIES = [
  { key: 'lost', label: 'Lost', cls: 's1', color: 'var(--series-1)' },
  { key: 'damaged', label: 'Damaged', cls: 's2', color: 'var(--series-2)' },
];

const pct = (x) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

// One shared tooltip; values lead, series names follow.
let tip;
function showTip(target, head, rows) {
  tip ??= document.body.appendChild(h('div', { class: 'chart-tip', role: 'tooltip' }));
  clear(tip, h('div', { class: 't-head' }, head),
    rows.map((r) => h('div', { class: 't-row' }, h('i', { style: { background: r.color } }), h('b', null, r.value), h('span', null, r.label))));
  tip.hidden = false;
  const rect = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2))}px`;
  tip.style.top = `${Math.max(8, rect.top - tip.offsetHeight - 8)}px`;
}
function hideTip() {
  if (tip) tip.hidden = true;
}
function hoverable(el, head, rows) {
  el.tabIndex = 0;
  el.setAttribute('aria-label', `${head}: ${rows.map((r) => `${r.value} ${r.label}`).join(', ')}`);
  const show = () => showTip(el, head, rows);
  el.addEventListener('pointerenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('blur', hideTip);
  return el;
}

function legend() {
  return h('div', { class: 'chart-legend' }, SERIES.map((s) => h('span', null, h('i', { class: s.cls }), s.label)));
}

/** Horizontal stacked bars: lost + damaged incidents per category. */
function categoryChart(rows) {
  const withIncidents = rows.filter((r) => r.lost + r.damaged > 0);
  if (!withIncidents.length) return h('p', { class: 'small muted' }, 'No losses or damage in this period.');
  const max = Math.max(...withIncidents.map((r) => r.lost + r.damaged));
  return h('div', null, legend(), withIncidents.map((r) => {
    const total = r.lost + r.damaged;
    const bar = h('div', { class: 'hbar', style: { width: `calc((100% - 3.5em) * ${total / max})` } },
      SERIES.filter((s) => r[s.key] > 0).map((s) => hoverable(
        h('div', { class: `seg ${s.cls}`, style: { flex: `${r[s.key]} 1 0` } }),
        r.category,
        SERIES.map((x) => ({ value: r[x.key], label: x.label, color: x.color })),
      )));
    return h('div', { class: 'hbar-row' },
      h('div', { class: 'label', title: r.category }, r.category),
      h('div', { class: 'hbar-track' }, bar, h('span', { class: 'hbar-val' }, total)));
  }));
}

/** Stacked columns per month; only the peak month is labelled. */
function monthChart(months) {
  const totals = months.map((m) => m.lost + m.damaged);
  const max = Math.max(...totals);
  if (max === 0) return h('p', { class: 'small muted' }, 'No losses or damage in this period.');
  const step = Math.max(1, Math.ceil(max / 3));
  const top = step * 3;
  const ticks = [0, step, step * 2, top];
  const peak = totals.indexOf(max);
  const plotH = 160;
  const label = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'short' });
  const yearLabel = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const every = Math.ceil(months.length / 12);
  return h('div', null, legend(),
    h('div', { class: 'cols' },
      h('div', { class: 'cols-y' }, ticks.map((t) => h('span', { style: { bottom: `${(t / top) * 100}%` } }, t))),
      h('div', { class: 'cols-plot' },
        ticks.slice(1).map((t) => h('div', { class: 'cols-grid', style: { bottom: `${(t / top) * 100}%` } })),
        months.map((m, i) => hoverable(h('div', { class: 'col-slot' },
          i === peak ? h('div', { class: 'col-cap' }, totals[i]) : null,
          h('div', { class: 'col-stack' }, SERIES.filter((s) => m[s.key] > 0).map((s) => h('div', {
            class: s.cls, style: { height: `${Math.max(3, (m[s.key] / top) * (plotH - 18))}px` },
          })))), yearLabel(m.month), SERIES.map((s) => ({ value: m[s.key], label: s.label, color: s.color })))))),
    h('div', { class: 'cols-x' }, months.map((m, i) => h('span', null, i % every === 0 ? label(m.month) : ''))),
    h('details', { class: 'table-view' }, h('summary', null, 'Show as a table'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', { class: 'num' }, 'Lost'), h('th', { class: 'num' }, 'Damaged'))),
        h('tbody', null, months.map((m) => h('tr', null, h('td', null, yearLabel(m.month)), h('td', { class: 'num' }, m.lost), h('td', { class: 'num' }, m.damaged))))))));
}

export async function reportsView({ query, app }) {
  const range = RANGES.find((r) => r.value === query.range) ?? RANGES[2];
  const from = new Date(Date.now() - range.days * 86400_000).toISOString();
  const data = await api.get(`/reports/loss-damage${qs({ from })}`);
  const t = data.totals;
  const page = h('div', { class: 'page' });

  const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);

  const filterRow = h('div', { class: 'row', style: { marginBottom: '16px' } },
    h('div', { class: 'chips' }, RANGES.map((r) => h('a', { class: `chip${r === range ? ' on' : ''}`, href: `#/reports${qs({ range: r.value })}` }, r.label))),
    h('span', { class: 'spacer' }),
    btn('Download CSV', { size: 'sm', iconName: 'download', href: `/api/reports/loss-damage.csv${qs({ from })}` }));

  const categoryTable = h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Category'), h('th', { class: 'num' }, 'Returns'), h('th', { class: 'num' }, 'Damaged'),
      h('th', { class: 'num' }, 'Damage rate'), h('th', { class: 'num' }, 'Lost'), h('th', { class: 'num' }, 'Value lost'))),
    h('tbody', null, data.by_category.map((c) => h('tr', null,
      h('td', null, c.category), h('td', { class: 'num' }, c.returns), h('td', { class: 'num' }, c.damaged),
      h('td', { class: 'num' }, c.returns ? pct(c.damage_rate) : '—'), h('td', { class: 'num' }, c.lost),
      h('td', { class: 'num' }, c.lost_value_cents ? fmtMoney(c.lost_value_cents) : '—'))))));

  const topTable = data.top_assets.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Category'), h('th', { class: 'num' }, 'Lost'), h('th', { class: 'num' }, 'Damaged'), h('th', null, 'Last incident'))),
    h('tbody', null, data.top_assets.map((a) => h('tr', null,
      h('td', null, h('a', { href: `#/item/${a.id}` }, a.name), ' ', tagCode(a.tag), a.state !== 'active' ? h('span', { class: 'small muted' }, ` (${a.state === 'repair' ? 'in repair' : a.state})`) : null),
      h('td', null, a.category), h('td', { class: 'num' }, a.lost), h('td', { class: 'num' }, a.damaged), h('td', { class: 'nowrap' }, fmtDate(a.last_at)))))))
    : h('p', { class: 'small muted' }, 'Nothing to show.');

  const incidents = data.incidents.length ? h('div', { class: 'list' }, data.incidents.map((i) => h('div', { class: 'list-item', style: { alignItems: 'flex-start' } },
    i.photo_url
      ? h('a', { href: i.photo_url, target: '_blank', rel: 'noopener' }, h('img', { src: i.photo_url, alt: 'Damage photo', loading: 'lazy', style: { width: '64px', height: '64px', objectFit: 'cover', borderRadius: '10px', border: '1px solid var(--border)' } }))
      : h('span', { class: 'icon-btn', style: { width: '64px', height: '64px', background: 'var(--surface-2)', borderRadius: '10px' } }, icon(i.type === 'lost' ? 'alert' : 'wrench')),
    h('div', { class: 'main' },
      h('div', { class: 'title' }, h('span', { class: `badge plain ${i.type === 'lost' ? 'checked_out' : 'reserved'}` }, i.type === 'lost' ? 'Lost' : 'Damaged'),
        h('a', { href: `#/item/${i.asset.id}`, class: 'truncate' }, i.asset.name), tagCode(i.asset.tag)),
      h('div', { class: 'sub' }, [fmtDateTime(i.created_at), i.borrower ? `borrowed by ${i.borrower.name}` : null, i.reported_by ? `reported by ${i.reported_by}` : null, i.cost_cents ? fmtMoney(i.cost_cents) : null].filter(Boolean).join(' · ')),
      i.notes ? h('div', { class: 'small' }, `“${i.notes}”`) : null,
      i.resolved_at ? h('div', { class: 'small', style: { color: 'var(--ok)' } }, `Resolved (${i.resolution}) ${fmtDate(i.resolved_at)}`) : h('div', { class: 'small faint' }, 'Open'))))) : null;

  return clear(page,
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Loss & damage'),
      h('p', { class: 'sub' }, 'Which accessories go missing or come back broken, so you can fix the cause.'))),
    filterRow,
    h('div', { class: 'kpis' },
      kpi('Items lost', t.lost, `${fmtMoney(t.lost_value_cents)} replacement value`),
      kpi('Damage reports', t.damaged, `${plural(t.unresolved, 'incident')} still open`),
      kpi('Damage rate', pct(t.damage_rate), `${t.damaged_returns} of ${plural(t.returns, 'return')}`),
      kpi('Out of service now', t.lost_now + t.repair_now, `${t.lost_now} lost · ${t.repair_now} in repair`)),
    rangeHasData(data) ? h('div', { class: 'two-col', style: { marginTop: '16px' } },
      h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'Incidents by category')), categoryChart(data.by_category)),
      h('section', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'Incidents per month')), monthChart(data.by_month)))
      : h('div', { class: 'card', style: { marginTop: '16px' } }, emptyState('check-circle', 'No losses or damage', `Nothing was lost or damaged in the ${range.label.toLowerCase()}.`)),
    h('section', { class: 'section card' }, h('div', { class: 'card-title' }, h('h2', null, 'Damage rate by category')), data.by_category.length ? categoryTable : h('p', { class: 'small muted' }, 'No returns in this period.')),
    h('section', { class: 'section card' }, h('div', { class: 'card-title' }, h('h2', null, 'Most affected items')), topTable),
    incidents ? h('section', { class: 'section card' }, h('div', { class: 'card-title' }, h('h2', null, 'Incident log'), h('span', { class: 'small muted' }, plural(data.incidents.length, 'record'))), incidents) : null);
}

function rangeHasData(data) {
  return data.totals.lost + data.totals.damaged > 0;
}
