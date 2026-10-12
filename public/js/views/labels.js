import { api, qs } from '../api.js';
import { btn, clear, h, icon, plural } from '../ui.js';

/** Printable QR labels for items and kits. */
export async function labelsView({ query, app }) {
  const [{ assets }, { kits }, { locations }] = await Promise.all([api.get('/assets'), api.get('/kits'), api.get('/locations')]);
  const all = [
    ...kits.map((k) => ({ tag: k.tag, name: k.name, kind: 'Kit', location: null, category: 'Kit' })),
    ...assets.map((a) => ({ tag: a.tag, name: a.name, kind: 'Item', location: a.location, category: a.category })),
  ];
  const preset = new Set((query.tags ?? '').split(',').filter(Boolean).map((t) => t.toLowerCase()));
  const selected = new Set(all.filter((x) => preset.has(x.tag.toLowerCase())).map((x) => x.tag));
  let filter = '';

  const listBox = h('div', { class: 'list', style: { maxHeight: '360px', overflowY: 'auto' } });
  const sheet = h('div', { class: 'label-sheet' });
  const count = h('span', { class: 'small muted' });

  const visible = () => all.filter((x) => !filter || x.location === filter || x.category === filter || (filter === 'Kits' && x.kind === 'Kit'));

  const renderSheet = () => {
    const chosen = all.filter((x) => selected.has(x.tag));
    count.textContent = `${plural(chosen.length, 'label')} selected`;
    clear(sheet, chosen.map((x) => h('div', { class: 'asset-label' },
      h('img', { src: `/api/qr.svg${qs({ code: x.tag })}`, alt: `QR code for ${x.tag}` }),
      h('div', null, h('div', { class: 'l-tag' }, x.tag), h('div', { class: 'l-name' }, x.name), h('div', { class: 'l-org' }, app.settings.school_name)))));
  };
  const renderList = () => {
    clear(listBox, visible().map((x) => {
      const box = h('input', {
        type: 'checkbox', checked: selected.has(x.tag),
        onchange: () => { if (box.checked) selected.add(x.tag); else selected.delete(x.tag); renderSheet(); },
      });
      return h('label', { class: 'list-item check', style: { cursor: 'pointer' } }, box,
        h('div', { class: 'main' }, h('div', { class: 'title' }, x.name), h('div', { class: 'sub' }, `${x.tag} · ${x.kind === 'Kit' ? 'Kit' : x.category}${x.location ? ` · ${x.location}` : ''}`)));
    }));
  };

  const filterSel = h('select', {
    class: 'select', style: { width: 'auto' },
    onchange: (e) => { filter = e.target.value; renderList(); },
  }, h('option', { value: '' }, 'Everything'), h('option', { value: 'Kits' }, 'Kits only'),
  h('optgroup', { label: 'Location' }, locations.map((l) => h('option', { value: l.location }, l.location))),
  h('optgroup', { label: 'Category' }, app.categories.map((c) => h('option', { value: c.name }, c.name))));

  renderList();
  renderSheet();
  return h('div', { class: 'page' },
    h('div', { class: 'no-print' },
      h('div', { class: 'page-header' },
        h('div', { class: 'grow' }, h('h1', null, 'Print labels'), h('p', { class: 'sub' }, 'QR labels work with the phone scanner and most USB scanners. Print on sticker paper and stick one on each item.')),
        btn('Print', { variant: 'primary', iconName: 'print', onClick: () => window.print() })),
      h('section', { class: 'card stack', style: { marginBottom: '16px' } },
        h('div', { class: 'row' }, filterSel,
          btn('Select shown', { size: 'sm', onClick: () => { for (const x of visible()) selected.add(x.tag); renderList(); renderSheet(); } }),
          btn('Clear', { size: 'sm', variant: 'ghost', onClick: () => { selected.clear(); renderList(); renderSheet(); } }),
          h('span', { class: 'spacer' }), count),
        listBox),
      h('h2', { style: { marginBottom: '10px' } }, icon('tag'), ' Preview')),
    sheet);
}
