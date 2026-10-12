import { api, qs } from '../api.js';
import { scanField } from '../scanner.js';
import {
  badge, btn, clear, confirmDialog, emptyState, field, fmtMoney, h, icon, kitCard, mosaic, openModal, plural, tagCode, toast,
} from '../ui.js';
import { assetRow, backLink } from './shared.js';

export async function kitsView({ app }) {
  const { kits } = await api.get('/kits');
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, 'Kits'),
        h('p', { class: 'sub' }, 'Bundles that check out with one scan. Each item still keeps its own tag and is confirmed separately on return.')),
      app.isAdmin ? btn('New kit', { variant: 'primary', iconName: 'plus', onClick: () => kitDialog(app) }) : null),
    kits.length ? h('div', { class: 'grid-cards' }, kits.map((k) => kitCard(k)))
      : emptyState('kit', 'No kits yet', 'Create a kit, then scan the camera, battery, charger and SD card into it.',
        app.isAdmin ? btn('New kit', { variant: 'primary', iconName: 'plus', onClick: () => kitDialog(app) }) : null));
  return page;
}

function kitDialog(app, kit) {
  const tag = h('input', { class: 'input mono', value: kit?.tag ?? '', placeholder: 'e.g. KIT-04', autocapitalize: 'characters' });
  const name = h('input', { class: 'input', value: kit?.name ?? '', placeholder: 'e.g. Canon Doc Kit' });
  const description = h('textarea', { class: 'textarea', placeholder: 'What’s in it / what it’s for' }, kit?.description ?? '');
  openModal({
    title: kit ? 'Edit kit' : 'New kit',
    body: h('div', { class: 'stack' }, field('Kit label (barcode)', tag, 'Print this on the kit bag or case.'), field('Name', name), field('Description', description)),
    actions: [
      { label: 'Cancel', variant: 'ghost' },
      {
        label: kit ? 'Save' : 'Create kit', variant: 'primary',
        onClick: async () => {
          const body = { tag: tag.value, name: name.value, description: description.value };
          const res = kit ? await api.patch(`/kits/${kit.id}`, body) : await api.post('/kits', body);
          toast(kit ? 'Kit saved' : 'Kit created — now scan items into it', 'success');
          app.navigate(`#/kit/${res.kit.id}`);
          if (kit) app.refresh();
        },
      },
    ],
  });
}

export async function kitView({ params, app }) {
  const { kit } = await api.get(`/kits/${params.id}`);
  const admin = app.isAdmin;
  const available = kit.status.code === 'available' || (kit.status.code === 'reserved' && kit.status.mine);

  const addScanner = admin ? scanField({
    placeholder: 'Scan an item to add it to this kit',
    buttonLabel: 'Add',
    title: `Scan items into ${kit.tag}`,
    autofocus: false,
    onScan: async (code) => {
      try {
        const res = await api.post(`/kits/${kit.id}/items`, { tag: code });
        const added = res.kit.items.find((i) => i.tag.toLowerCase() === code.toLowerCase());
        toast(`${added?.name ?? code} added${res.moved_from ? ' (moved from another kit)' : ''}`, 'success');
        clear(itemsBox, itemsList(res.kit));
        return { ok: true, message: `Added ${code}` };
      } catch (err) {
        toast(err.message, 'error');
        return { ok: false, message: err.message };
      }
    },
  }) : null;

  const itemsList = (k) => (k.items.length ? h('div', { class: 'list' }, k.items.map((i) => assetRow(i, {
    trailing: admin ? h('button', {
      class: 'icon-btn', type: 'button', title: 'Remove from kit',
      onclick: async (e) => {
        e.preventDefault();
        const res = await api.del(`/kits/${k.id}/items/${i.id}`);
        toast(`${i.tag} removed from kit`, 'success');
        clear(itemsBox, itemsList(res.kit));
      },
    }, icon('x')) : null,
  }))) : h('p', { class: 'muted small' }, 'No items yet.'));
  const itemsBox = h('div', null, itemsList(kit));

  return h('div', { class: 'page' },
    backLink('#/?tab=kits', 'Kits'),
    h('div', { class: 'detail-hero' },
      h('div', { class: 'thumb-hero', style: { overflow: 'hidden' } }, mosaic(kit.items)),
      h('div', { class: 'stack' },
        h('div', { class: 'row' }, badge(kit.status, { large: true }), tagCode(kit.tag)),
        h('h1', null, kit.name),
        kit.description ? h('p', { class: 'muted' }, kit.description) : null,
        h('p', { class: 'small muted' }, `${plural(kit.item_count, 'item')}${kit.total_value_cents ? ` · ${fmtMoney(kit.total_value_cents)} total` : ''}. Scan the kit label once to check out everything; on return each item is confirmed on its own.`),
        h('div', { class: 'action-bar' },
          app.canSelfServe && available ? btn('Check out kit', { variant: 'primary', iconName: 'checkout', href: `#/checkout${qs({ kit: kit.id })}` }) : null,
          app.canBook ? btn('Book kit', { iconName: 'calendar', href: `#/bookings/new${qs({ kit: kit.id })}` }) : null,
          admin ? btn('Edit', { iconName: 'edit', onClick: () => kitDialog(app, kit) }) : null,
          admin ? btn('Label', { iconName: 'print', href: `#/labels${qs({ tags: kit.tag })}` }) : null,
          admin ? btn('Delete', {
            iconName: 'trash', variant: 'danger',
            onClick: async () => {
              if (!await confirmDialog(`Delete kit ${kit.tag}? The items stay in inventory.`, { danger: true, confirmLabel: 'Delete kit' })) return;
              await api.del(`/kits/${kit.id}`);
              toast('Kit deleted', 'success');
              app.navigate('#/?tab=kits');
            },
          }) : null))),
    h('section', { class: 'section card stack' },
      h('div', { class: 'card-title' }, icon('kit'), h('h2', null, 'In this kit')),
      addScanner,
      itemsBox));
}
