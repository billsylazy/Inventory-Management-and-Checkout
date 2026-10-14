import { api } from '../api.js';
import {
  banner, btn, clear, confirmDialog, field, h, icon, toast,
} from '../ui.js';

const GROUPS = [
  { title: 'General', keys: ['school_name'] },
  { title: 'Loans', keys: ['loan_days_default', 'max_loan_days', 'allow_student_self_checkout', 'signature_threshold_cents'] },
  { title: 'Overdue rules', keys: ['grace_period_hours', 'late_return_penalty_days', 'fine_per_day_cents', 'block_on_unpaid_fines'] },
  { title: 'Bookings', keys: ['allow_student_reservations', 'max_reservation_days', 'reservation_pickup_hours', 'reserved_badge_hours'] },
  { title: 'Returns', keys: ['damaged_to_repair'] },
];

export async function settingsView({ app }) {
  const { settings, fields, icons } = await api.get('/settings');
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const controls = {};
  const page = h('div', { class: 'page page-narrow' });
  const error = h('div');

  const control = (def) => {
    const value = settings[def.key];
    if (def.type === 'bool') {
      const input = h('input', { type: 'checkbox', checked: value });
      controls[def.key] = () => input.checked;
      return h('label', { class: 'check' }, input, h('span', null, def.label));
    }
    if (def.key.endsWith('_cents')) {
      const input = h('input', { class: 'input', inputmode: 'decimal', value: (value / 100).toFixed(2) });
      controls[def.key] = () => Math.round(Number(String(input.value).replace(/[$,\s]/g, '')) * 100);
      return field(def.label.replace(/,? in cents/, '').replace(/\(cents\)/, ''), h('div', { class: 'input-group' }, h('span', { class: 'btn', style: { pointerEvents: 'none' } }, '$'), input));
    }
    const input = h('input', { class: 'input', type: def.type === 'int' ? 'number' : 'text', value, min: def.min, max: def.max });
    controls[def.key] = () => (def.type === 'int' ? Number(input.value) : input.value);
    return field(def.label, input);
  };

  const save = btn('Save settings', {
    variant: 'primary', iconName: 'check',
    onClick: async () => {
      clear(error);
      const patch = Object.fromEntries(Object.entries(controls).map(([k, get]) => [k, get()]));
      try {
        await api.patch('/settings', patch);
        await app.refreshMe();
        toast('Settings saved', 'success');
      } catch (err) {
        clear(error, banner('danger', err.message));
      }
    },
  });

  // Categories
  const categoriesBox = h('div');
  const renderCategories = async () => {
    const cats = await app.loadCategories();
    const name = h('input', { class: 'input', placeholder: 'New category, e.g. Drone', 'aria-label': 'New category name' });
    const kind = h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'New category type' }, h('option', { value: 'accessory' }, 'Accessory'), h('option', { value: 'main' }, 'Main item'));
    const iconSel = h('select', { class: 'select', style: { width: 'auto' }, 'aria-label': 'New category icon' }, icons.map((i) => h('option', { value: i }, i)));
    clear(categoriesBox,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Category'), h('th', null, 'Type'), h('th', null, 'Icon'), h('th', null, ''))),
        h('tbody', null, cats.map((c) => h('tr', null,
          h('td', null, icon(c.icon)),
          h('td', null, c.name),
          h('td', null, h('select', {
            class: 'select', style: { width: 'auto', minHeight: '36px' }, 'aria-label': `Type for ${c.name}`,
            onchange: async (e) => { await api.patch(`/categories/${encodeURIComponent(c.name)}`, { kind: e.target.value }); toast('Saved', 'success'); },
          }, h('option', { value: 'main', selected: c.kind === 'main' }, 'Main item'), h('option', { value: 'accessory', selected: c.kind === 'accessory' }, 'Accessory'))),
          h('td', null, h('select', {
            class: 'select', style: { width: 'auto', minHeight: '36px' }, 'aria-label': `Icon for ${c.name}`,
            onchange: async (e) => { await api.patch(`/categories/${encodeURIComponent(c.name)}`, { icon: e.target.value }); toast('Saved', 'success'); renderCategories(); },
          }, icons.map((i) => h('option', { value: i, selected: c.icon === i }, i)))),
          h('td', null, h('button', {
            class: 'icon-btn', type: 'button', title: `Delete ${c.name}`,
            onclick: async () => {
              if (!await confirmDialog(`Delete the category “${c.name}”?`, { danger: true, confirmLabel: 'Delete' })) return;
              try {
                await api.del(`/categories/${encodeURIComponent(c.name)}`);
                renderCategories();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, icon('trash')))))))),
      h('div', { class: 'row', style: { marginTop: '12px' } }, h('div', { style: { flex: '1', minWidth: '180px' } }, name), kind, iconSel,
        btn('Add', {
          iconName: 'plus',
          onClick: async () => {
            try {
              await api.post('/categories', { name: name.value, kind: kind.value, icon: iconSel.value });
              renderCategories();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        })));
  };
  await renderCategories();

  return clear(page,
    h('div', { class: 'page-header' }, h('div', { class: 'grow' }, h('h1', null, 'Settings'), h('p', { class: 'sub' }, 'Rules for loans, overdue gear and bookings.'))),
    error,
    h('div', { class: 'stack' },
      GROUPS.map((g) => h('section', { class: 'card stack' }, h('h2', null, g.title), g.keys.filter((k) => byKey[k]).map((k) => control(byKey[k])))),
      h('div', null, save),
      h('section', { class: 'card stack' },
        h('h2', null, 'Backup'),
        h('p', { class: 'small muted' }, 'Download a copy of everything — items, kits, people, loans, bookings and history — as one database file. Keep it somewhere safe; do this regularly if the app runs on a website.'),
        h('div', null, h('a', { class: 'btn', href: '/api/backup', download: '' }, icon('download'), h('span', null, 'Download backup')))),
      h('section', { class: 'card stack' },
        h('h2', null, 'Categories'),
        h('p', { class: 'small muted' }, '“Main items” (camera bodies, camcorders…) get compatible accessory suggestions. Accessories are what gets suggested.'),
        categoriesBox)));
}
