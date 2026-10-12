import { api } from '../api.js';
import {
  STATUS_META, assetCard, banner, btn, clear, debounce, emptyState, h, icon, kitCard, legend, openModal,
  plural, tabs, toast,
} from '../ui.js';
import { restrictionBanner } from './shared.js';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'available', label: 'Available' },
  { value: 'checked_out', label: 'Checked out' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'unavailable', label: 'Out of service' },
];

/** Home screen: a photo grid of every item, grouped by category. */
export async function catalogView({ query, app }) {
  const state = {
    tab: query.tab === 'kits' ? 'kits' : 'items',
    q: query.q ?? '',
    status: query.status ?? '',
    category: query.category ?? '',
    compat: query.compat ?? '',
  };
  let [{ assets }, compatData, kitsData] = await Promise.all([
    api.get('/assets'),
    state.compat ? api.get(`/assets/${encodeURIComponent(state.compat)}`).catch(() => null) : null,
    state.tab === 'kits' ? api.get('/kits') : null,
  ]);
  let compatMatches = compatData ? new Map(compatData.compatible.map((a) => [a.id, a.match])) : null;
  const categories = app.categories.filter((c) => assets.some((a) => a.category.toLowerCase() === c.name.toLowerCase()));

  const page = h('div', { class: 'page' });
  const results = h('div');
  const syncQuery = () => app.replaceQuery({ tab: state.tab === 'kits' ? 'kits' : '', q: state.q, status: state.status, category: state.category, compat: state.compat });

  const header = h('div', { class: 'page-header' },
    h('div', { class: 'grow' },
      h('h1', null, 'Equipment'),
      h('p', { class: 'sub' }, app.isAdmin
        ? `${plural(assets.length, 'item')} in inventory`
        : 'Tap any item to see what it is, whether it’s free, and what works with it.')),
    app.isAdmin ? h('div', { class: 'row' },
      btn('Import', { iconName: 'upload', onClick: () => importDialog(app) }),
      btn('Add item', { variant: 'primary', iconName: 'plus', href: '#/item/new' })) : null);

  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search name, tag, brand, “mount:EF”…', value: state.q, 'aria-label': 'Search equipment',
    oninput: debounce(() => {
      state.q = search.value.trim();
      syncQuery();
      renderResults();
    }, 120),
  });

  const statusChips = h('div', { class: 'chips scroll' });
  const categoryChips = h('div', { class: 'chips scroll' });
  const renderChips = () => {
    clear(statusChips, STATUS_FILTERS.map((f) => h('button', {
      type: 'button', class: `chip${state.status === f.value ? ' on' : ''}`,
      onclick: () => { state.status = f.value; syncQuery(); renderChips(); renderResults(); },
    }, f.value ? h('span', { class: 'dot', style: { background: STATUS_META[f.value].color } }) : null, f.label)));
    clear(categoryChips,
      h('button', { type: 'button', class: `chip${!state.category ? ' on' : ''}`, onclick: () => { state.category = ''; syncQuery(); renderChips(); renderResults(); } }, 'All types'),
      categories.map((c) => h('button', {
        type: 'button', class: `chip${state.category.toLowerCase() === c.name.toLowerCase() ? ' on' : ''}`,
        onclick: () => { state.category = c.name; syncQuery(); renderChips(); renderResults(); },
      }, icon(c.icon), c.name)));
  };

  function filtered() {
    const q = state.q.toLowerCase();
    return assets.filter((a) => {
      if (state.status && a.status.code !== state.status) return false;
      if (state.category && a.category.toLowerCase() !== state.category.toLowerCase()) return false;
      if (compatMatches && !compatMatches.has(a.id)) return false;
      if (!q) return true;
      return [a.tag, a.name, a.brand, a.model, a.category, a.location, ...(a.compat ?? [])]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
  }

  function renderResults() {
    const list = filtered();
    if (!list.length) {
      clear(results, emptyState('search', 'Nothing matches', 'Try a different search or clear the filters.',
        btn('Clear filters', { onClick: () => { state.q = ''; state.status = ''; state.category = ''; search.value = ''; syncQuery(); renderChips(); renderResults(); } })));
      return;
    }
    const card = (a) => assetCard(a, {
      extra: compatMatches ? h('div', { class: 'extra' }, `Fits: ${compatMatches.get(a.id).join(', ')}`) : null,
    });
    if (state.q || state.category) {
      clear(results, h('p', { class: 'small muted', style: { marginBottom: '10px' } }, plural(list.length, 'result')), h('div', { class: 'grid-cards' }, list.map(card)));
      return;
    }
    const groups = new Map();
    for (const a of list) {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category).push(a);
    }
    clear(results, [...groups].map(([category, items]) => h('section', { class: 'section' },
      h('div', { class: 'section-title' }, icon(items[0].icon), h('h2', null, category, ' ', h('span', { class: 'count' }, `(${items.length})`))),
      h('div', { class: 'grid-cards' }, items.map(card)))));
  }

  const compatBanner = compatData
    ? banner('info', h('div', { class: 'row' },
      h('span', { class: 'spacer' }, 'Showing gear that works with ', h('strong', null, compatData.asset.name), ` (${compatData.asset.tag})`),
      btn('Show everything', { size: 'sm', onClick: () => { state.compat = ''; compatMatches = null; syncQuery(); app.refresh(); } })), 'link')
    : null;

  if (state.tab === 'kits') {
    const kits = kitsData.kits;
    clear(page, header, restrictionBanner(app),
      tabs([{ value: 'items', label: 'Items', href: '#/' }, { value: 'kits', label: 'Kits', count: kits.length }], 'kits'),
      h('p', { class: 'small muted', style: { marginBottom: '12px' } }, 'A kit is a ready-to-go bundle. Scan the kit label once to check out everything in it.'),
      kits.length ? h('div', { class: 'grid-cards' }, kits.map((k) => kitCard(k))) : emptyState('kit', 'No kits yet', app.isAdmin ? 'Group a camera, battery, charger and card into a kit from the Kits page.' : null,
        app.isAdmin ? btn('Manage kits', { href: '#/kits', variant: 'primary' }) : null));
    return page;
  }

  renderChips();
  renderResults();

  // Keep the colour-coded badges live while the grid is open.
  const timer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const fresh = (await api.get('/assets')).assets;
      const signature = (list) => list.map((a) => `${a.id}:${a.status.code}:${a.status.label}`).join('|');
      if (signature(fresh) !== signature(assets)) {
        assets = fresh;
        renderResults();
      }
    } catch {
      // offline for a moment; try again next tick
    }
  }, 20_000);
  app.onLeave(() => clearInterval(timer));

  clear(page, header, restrictionBanner(app),
    tabs([{ value: 'items', label: 'Items', count: assets.length }, { value: 'kits', label: 'Kits', href: '#/?tab=kits' }], 'items'),
    h('div', { class: 'stack', style: { marginBottom: '6px' } },
      compatBanner,
      h('div', { class: 'search' }, icon('search'), search),
      statusChips,
      categoryChips,
      legend()),
    results);
  return page;
}

function importDialog(app) {
  const textarea = h('textarea', { class: 'textarea mono', rows: 8, placeholder: 'tag,name,category,brand,model,serial_number,value,location,compat,parent_tag,kit_tag\nCAM-010,Canon EOS R50,Camera Body,Canon,R50,,679,Cabinet A,mount:RF;battery:LP-E17;media:SD,,' });
  const file = h('input', {
    type: 'file', accept: '.csv,text/csv',
    onchange: async () => {
      const f = file.files?.[0];
      if (f) textarea.value = await f.text();
    },
  });
  const out = h('div');
  openModal({
    title: 'Import items from CSV',
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, 'The first row must be a header. Required columns: tag, name, category. Optional: brand, model, serial_number, value (dollars), location, description, compat (separate tags with ;), parent_tag (attach to another item), kit_tag (creates the kit if needed), requires_signature.'),
      file, textarea, out),
    actions: [
      { label: 'Close', variant: 'ghost' },
      {
        label: 'Import', variant: 'primary', icon: 'upload',
        onClick: async () => {
          const res = await api.post('/assets/import', { csv: textarea.value });
          clear(out,
            banner(res.errors.length ? 'warning' : 'success', h('div', null,
              h('div', { class: 'bold' }, `Imported ${plural(res.created, 'item')}.`),
              res.errors.length ? h('ul', null, res.errors.slice(0, 30).map((e) => h('li', null, `Line ${e.line}${e.tag ? ` (${e.tag})` : ''}: ${e.error}`))) : null)));
          if (res.created) toast(`Imported ${plural(res.created, 'item')}`, 'success');
          return false;
        },
      },
    ],
    onClose: () => app.refresh(),
  });
}

