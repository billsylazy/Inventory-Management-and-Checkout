import { api, qs } from '../api.js';
import { scanField } from '../scanner.js';
import {
  badge, banner, btn, clear, debounce, fmtDateTime, fmtMoney, h, icon, initials, listItem, tagCode, thumb,
} from '../ui.js';

export const CONDITION_OPTIONS = [
  { value: 'excellent', label: 'Excellent', className: 'c-excellent' },
  { value: 'fair', label: 'Fair', className: 'c-fair' },
  { value: 'damaged', label: 'Damaged', className: 'c-damaged' },
];

export function restrictionContent(restriction, { self = true, name } = {}) {
  const who = self ? 'You' : name;
  const parts = [];
  if (restriction.restricted) {
    parts.push(banner('danger', h('div', null,
      h('div', { class: 'bold' }, `${who} can’t book or check out new gear right now`),
      h('ul', null, restriction.reasons.map((r) => h('li', null, r.message, r.until ? ` (until ${fmtDateTime(r.until)})` : ''))))));
  }
  const warnings = restriction.warnings ?? [];
  if (warnings.length) {
    parts.push(banner('warning', h('div', null, h('ul', { style: { margin: 0, paddingLeft: '18px' } }, warnings.map((w) => h('li', null,
      w.message, w.until ? ` Return by ${fmtDateTime(w.until)}.` : ''))))));
  }
  return parts.length ? h('div', { class: 'stack-sm', style: { marginBottom: '14px' } }, parts) : null;
}

/** Shown to students at the top of key screens when they are restricted. */
export function restrictionBanner(app) {
  if (app.isAdmin || !app.restriction) return null;
  return restrictionContent(app.restriction);
}

/** One row for an item: thumbnail, name, tag, status badge. */
export function assetRow(asset, { href = `#/item/${asset.id}`, sub, trailing, className = '', showBadge = true } = {}) {
  return listItem({
    href,
    className,
    leading: thumb(asset, 'sm'),
    title: [h('span', { class: 'truncate' }, asset.name)],
    sub: sub ?? h('span', { class: 'row', style: { gap: '6px' } }, tagCode(asset.tag), `${asset.category}${asset.value_cents ? ` · ${fmtMoney(asset.value_cents)}` : ''}`),
    trailing: [showBadge ? badge(asset.status) : null, trailing].filter(Boolean),
  });
}

export function personChip(user, { href } = {}) {
  const inner = [h('span', { class: 'avatar' }, initials(user.name)), h('div', { class: 'stack-sm', style: { gap: 0 } },
    h('div', { class: 'bold' }, user.name),
    h('div', { class: 'small muted' }, [user.student_id ? `ID ${user.student_id}` : user.username].filter(Boolean).join(' · ')))];
  return href ? h('a', { class: 'borrower-card', href, style: { color: 'inherit' } }, inner) : h('div', { class: 'borrower-card' }, inner);
}

/**
 * Staff picker for choosing a student: search by name, or scan an ID card.
 */
export function userPicker({ onSelect, label = 'Find a student' }) {
  const results = h('div', { class: 'list' });
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Type a name, username or student ID', 'aria-label': label });
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return clear(results);
    const { users } = await api.get(`/users${qs({ q })}`);
    clear(results, users.slice(0, 8).map((u) => listItem({
      onClick: () => onSelect(u),
      leading: h('span', { class: 'avatar' }, initials(u.name)),
      title: u.name,
      sub: [u.student_id ? `ID ${u.student_id}` : u.username, u.role === 'admin' ? 'Staff' : null, u.restriction?.restricted ? 'Restricted' : null].filter(Boolean).join(' · '),
      trailing: u.restriction?.restricted ? icon('ban') : icon('chevron-right'),
    })), users.length === 0 ? h('p', { class: 'small muted', style: { padding: '8px 4px' } }, 'No one matches that search.') : null);
  }, 200);
  input.addEventListener('input', search);
  const scan = scanField({
    placeholder: 'Scan student ID card',
    buttonLabel: 'Find',
    continuous: false,
    title: 'Scan a student ID',
    autofocus: false,
    onScan: async (code) => {
      try {
        const res = await api.get(`/scan${qs({ code })}`);
        if (res.type !== 'user') return { ok: false, message: `${code} is not a student ID` };
        onSelect(res.user);
        return { ok: true, message: res.user.name };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },
  });
  return h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search'), input), results,
    h('div', { class: 'small muted' }, 'Or scan their ID card:'), scan);
}

export function issueList(issues) {
  if (!issues?.length) return null;
  const icons = { error: 'x-circle', warning: 'alert', info: 'info' };
  return h('div', { class: 'stack-sm', style: { gap: '2px', marginTop: '2px' } },
    issues.map((i) => h('div', { class: `issue ${i.level}` }, icon(icons[i.level] ?? 'info'), h('span', null, i.message))));
}

export function backLink(href, label) {
  return h('a', { class: 'back-link', href }, icon('chevron-left'), label);
}

export function conditionBadge(condition) {
  if (!condition) return null;
  const cls = { excellent: 'available', fair: 'reserved', damaged: 'checked_out' }[condition];
  return h('span', { class: `badge plain ${cls}` }, condition.charAt(0).toUpperCase() + condition.slice(1));
}

export { btn };
