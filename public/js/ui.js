import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Tiny DOM builder. Children that are strings become text nodes, so user
// data is never interpreted as HTML.

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate', 'multiple', 'required', 'readOnly']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROPS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export { icon };

export function btn(label, { variant = '', size = '', iconName, onClick, type = 'button', disabled, href, title, block } = {}) {
  const cls = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, block && 'btn-block'].filter(Boolean).join(' ');
  const content = [iconName ? icon(iconName) : null, label ? h('span', null, label) : null];
  if (href) return h('a', { class: cls, href, title }, content);
  return h('button', { class: cls, type, onclick: onClick, disabled, title }, content);
}

export function iconBtn(name, { title, onClick, href } = {}) {
  if (href) return h('a', { class: 'icon-btn', href, title, 'aria-label': title }, icon(name));
  return h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: onClick }, icon(name));
}

// ---------------------------------------------------------------------------
// Formatting

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function fmtDate(iso) {
  return iso ? fullFmt.format(new Date(iso)) : '';
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? dateFmt.format(d) : fullFmt.format(d)}, ${timeFmt.format(d)}`;
}

export function relTime(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60_000) return 'just now';
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  if (abs < 30 * 86400_000) return rtf.format(Math.round(diff / 86400_000), 'day');
  return fmtDate(iso);
}

/** "Due tomorrow" / "Overdue by 3 days" */
export function dueText(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff >= 0) return `Due ${relTime(iso)}`;
  const abs = -diff;
  if (abs < 3600_000) return `Overdue by ${Math.max(1, Math.round(abs / 60_000))} min`;
  if (abs < 86400_000) return `Overdue by ${Math.round(abs / 3600_000)} h`;
  const days = Math.round(abs / 86400_000);
  return `Overdue by ${days} day${days === 1 ? '' : 's'}`;
}

export function fmtMoney(cents) {
  if (cents === null || cents === undefined) return '';
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

/** Value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

/** Default due time: N days from now at 3:30 pm. */
export function defaultDue(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(15, 30, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Status badges & thumbnails

export function badge(status, { large = false } = {}) {
  return h('span', { class: `badge ${status.code}${large ? ' lg' : ''}` }, status.label);
}

export const STATUS_META = {
  available: { label: 'Available', color: 'var(--ok-dot)' },
  checked_out: { label: 'Checked out', color: 'var(--out-dot)' },
  reserved: { label: 'Reserved', color: 'var(--res-dot)' },
  unavailable: { label: 'Out of service', color: 'var(--na-dot)' },
};

export function legend() {
  return h('div', { class: 'legend' }, Object.values(STATUS_META).map((m) => h('span', null, h('i', { style: { background: m.color } }), m.label)));
}

function hueFor(text) {
  const hues = [215, 262, 172, 32, 345, 145, 198, 18, 238, 88, 290, 0];
  let n = 0;
  for (const ch of String(text)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[n % hues.length];
}

/** Item photo, or an illustration of its category when there's no photo. */
export function thumb(item, size = '') {
  const cls = `thumb${size ? ` thumb-${size}` : ''}`;
  if (item.photo_url) {
    return h('div', { class: cls }, h('img', { src: item.photo_url, alt: item.name, loading: 'lazy' }));
  }
  const fallback = h('div', { class: 'thumb-fallback' }, icon(item.icon || 'box'));
  fallback.style.setProperty('--hue', hueFor(item.category));
  return h('div', { class: cls, title: item.category }, fallback);
}

export function mosaic(items) {
  const four = items.slice(0, 4);
  while (four.length < 4) four.push(null);
  return h('div', { class: 'mosaic' }, four.map((it) => (it ? thumb(it) : h('div', { class: 'thumb' }))));
}

export function tagCode(tag) {
  return h('span', { class: 'tag-code' }, tag);
}

/** Card for the thumbnail grid. */
export function assetCard(asset, { href = `#/item/${asset.id}`, extra, action, onClick, selected, dim } = {}) {
  const s = asset.status;
  let statusLine = null;
  if (s.code === 'checked_out' && s.due_at) {
    statusLine = h('div', { class: `extra${s.overdue ? ' danger' : ''}` }, [s.borrower ? `${s.borrower.name} · ` : '', dueText(s.due_at)]);
  } else if (s.code === 'reserved' && s.start_at) {
    statusLine = h('div', { class: 'extra' }, `From ${fmtDateTime(s.start_at)}`);
  }
  const tagName = onClick ? 'button' : 'a';
  const card = h(
    tagName,
    {
      class: `asset-card${selected ? ' selected' : ''}${dim ? ' dim' : ''}`,
      href: onClick ? undefined : href,
      type: onClick ? 'button' : undefined,
      onclick: onClick,
      style: onClick ? { textAlign: 'left', cursor: 'pointer', font: 'inherit', padding: 0 } : undefined,
    },
    thumb(asset),
    badge(s),
    h('div', { class: 'card-body' },
      h('div', { class: 'name' }, asset.name),
      h('div', { class: 'meta' }, tagCode(asset.tag), h('span', { class: 'truncate' }, asset.category)),
      statusLine,
      extra),
  );
  if (action) card.append(h('div', { class: 'card-action' }, action));
  return card;
}

export function kitCard(kit, { href = `#/kit/${kit.id}` } = {}) {
  return h('a', { class: 'asset-card', href },
    mosaic(kit.items),
    badge(kit.status),
    h('div', { class: 'card-body' },
      h('div', { class: 'name' }, kit.name),
      h('div', { class: 'meta' }, tagCode(kit.tag), h('span', { class: 'truncate' }, plural(kit.item_count, 'item')))));
}

export function listItem({ href, onClick, leading, title, sub, trailing, className = '' }) {
  const tagName = href ? 'a' : onClick ? 'button' : 'div';
  return h(tagName, {
    class: `list-item ${className}`.trim(),
    href,
    onclick: onClick,
    type: onClick && !href ? 'button' : undefined,
    style: onClick && !href ? { width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--border)', textAlign: 'left', cursor: 'pointer', font: 'inherit' } : undefined,
  }, leading, h('div', { class: 'main' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'sub' }, sub) : null), trailing);
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('h3', null, title), text ? h('p', null, text) : null, action ? h('div', { style: { marginTop: '14px' } }, action) : null);
}

export function loading() {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' }));
}

export function banner(kind, content, iconName) {
  const icons = { danger: 'ban', warning: 'alert', success: 'check-circle', info: 'info' };
  return h('div', { class: `banner ${kind}`, role: kind === 'danger' ? 'alert' : undefined }, icon(iconName || icons[kind]), h('div', { class: 'b-body' }, content));
}

export function field(label, control, hint) {
  const parts = [h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null];
  // A <label> would name only the first button of a button group, so groups
  // get role="group" with their own accessible name instead.
  if (control.classList?.contains('seg')) return h('div', { class: 'field', role: 'group', 'aria-label': label }, parts);
  return h('label', { class: 'field' }, parts);
}

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const render = (current) => {
    clear(wrap, options.map((o) => h('button', {
      type: 'button',
      class: `${o.value === current ? 'on ' : ''}${o.className ?? ''}`,
      role: 'radio',
      'aria-checked': String(o.value === current),
      onclick: () => {
        render(o.value);
        onChange(o.value);
      },
    }, o.label)));
  };
  render(value);
  return wrap;
}

export function tabs(items, current, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => h(t.href ? 'a' : 'button', {
    class: `tab${t.value === current ? ' on' : ''}`,
    href: t.href,
    role: 'tab',
    'aria-selected': String(t.value === current),
    onclick: t.href ? undefined : () => onSelect(t.value),
  }, t.label, t.count !== undefined ? h('span', { class: 'pill' }, t.count) : null)));
}

// ---------------------------------------------------------------------------
// Toasts, modals, feedback

let toastWrap;
export function toast(message, type = 'info', ms = 3500) {
  if (!toastWrap) {
    toastWrap = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const icons = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' };
  const el = h('div', { class: `toast ${type}` }, icon(icons[type] ?? 'info'), h('div', null, message));
  toastWrap.append(el);
  setTimeout(() => el.remove(), ms);
}

export function openModal({ title, body, actions = [], onClose, wide = false }) {
  const previous = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
    previous?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? { maxWidth: '760px' } : undefined },
    h('div', { class: 'modal-head' }, h('h2', null, title), iconBtn('x', { title: 'Close', onClick: close })),
    body,
    actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => btn(a.label, {
      variant: a.variant, iconName: a.icon, disabled: a.disabled,
      onClick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const keepOpen = await a.onClick?.();
          if (keepOpen !== false) close();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          button.disabled = false;
        }
      },
    }))) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, modal);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  // Focus the first field, unless the user (or a barcode scanner) is already
  // typing somewhere in the dialog.
  setTimeout(() => {
    if (modal.contains(document.activeElement)) return;
    const first = modal.querySelector('input, select, textarea') ?? modal.querySelector('.modal-actions .btn-primary');
    // The dialog itself was just opened by a click, so whatever had focus
    // before (usually the button that opened it) is fair to move away from.
    if (first && !modal.contains(document.activeElement)) first.focus();
  }, 30);
  return { close, modal };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: h('p', { class: 'muted' }, message),
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, variant: danger ? 'solid-danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

let audioCtx;
/** Short beep + vibration so scanning feels responsive without looking. */
export function feedback(ok = true) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ok ? 1046 : 220;
    osc.type = ok ? 'sine' : 'square';
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (ok ? 0.12 : 0.3));
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (ok ? 0.12 : 0.3));
  } catch {
    // Audio is a nicety; ignore browsers that block it.
  }
  navigator.vibrate?.(ok ? 40 : [60, 40, 60]);
}

/**
 * Focuses `el` only if the user isn't already in another field. Delayed
 * autofocus must never pull the cursor away from someone (or a barcode
 * scanner) who has started typing elsewhere.
 */
export function focusIfIdle(el, { within } = {}) {
  const active = document.activeElement;
  if (!active || active === document.body || active === el || (within && within.contains(active))) el.focus();
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
