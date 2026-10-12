import { api, setUnauthorizedHandler } from './api.js';
import { closeActiveScanner } from './scanner.js';
import {
  banner, btn, clear, field, h, icon, initials, loading, openModal, toast,
} from './ui.js';
import { accountView } from './views/account.js';
import { assetFormView, assetView } from './views/asset.js';
import { auditListView, auditView } from './views/audit.js';
import { bookingFormView, bookingsView } from './views/bookings.js';
import { catalogView } from './views/catalog.js';
import { checkoutView } from './views/checkout.js';
import { kitsView, kitView } from './views/kits.js';
import { labelsView } from './views/labels.js';
import { loansView, loanView } from './views/loans.js';
import { peopleView, personView } from './views/people.js';
import { reportsView } from './views/reports.js';
import { returnView } from './views/return.js';
import { settingsView } from './views/settings.js';

const ROUTES = [
  { path: '/', view: catalogView },
  { path: '/item/new', view: assetFormView, admin: true },
  { path: '/item/:id', view: assetView },
  { path: '/item/:id/edit', view: assetFormView, admin: true },
  { path: '/kits', view: kitsView },
  { path: '/kit/:id', view: kitView },
  { path: '/checkout', view: checkoutView },
  { path: '/return', view: returnView },
  { path: '/loans', view: loansView },
  { path: '/loan/:id', view: loanView },
  { path: '/bookings', view: bookingsView },
  { path: '/bookings/new', view: bookingFormView },
  { path: '/audit', view: auditListView, admin: true },
  { path: '/audit/:id', view: auditView, admin: true },
  { path: '/reports', view: reportsView, admin: true },
  { path: '/people', view: peopleView, admin: true },
  { path: '/people/:id', view: personView, admin: true },
  { path: '/settings', view: settingsView, admin: true },
  { path: '/labels', view: labelsView, admin: true },
  { path: '/account', view: accountView },
];

const state = { user: null, settings: null, restriction: null, categories: [] };
let cleanups = [];
let renderToken = 0;
let lastPath = null;
let shell = null;

// Handed to every view.
export const app = {
  get user() { return state.user; },
  get settings() { return state.settings; },
  get restriction() { return state.restriction; },
  get categories() { return state.categories; },
  get isAdmin() { return state.user?.role === 'admin'; },
  /** Students may check out / return themselves only if staff allow it. */
  get canSelfServe() { return state.user?.role === 'admin' || !!state.settings?.allow_student_self_checkout; },
  get canBook() { return state.user?.role === 'admin' || !!state.settings?.allow_student_reservations; },
  navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  /** Updates the query string without re-rendering (filters, search). */
  replaceQuery(params) {
    const { path } = parseHash();
    const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    history.replaceState(null, '', `#${path}${search ? `?${search}` : ''}`);
  },
  onLeave(fn) { cleanups.push(fn); },
  refresh: () => render(),
  async refreshMe() {
    const me = await api.get('/auth/me');
    state.user = me.user;
    state.settings = me.settings;
    state.restriction = me.restriction;
    if (shell) updateShell();
    return me;
  },
  async loadCategories() {
    state.categories = (await api.get('/categories')).categories;
    return state.categories;
  },
};

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(search)) };
}

function matchRoute(path) {
  for (const route of ROUTES) {
    const names = [];
    const pattern = new RegExp(`^${route.path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}/?$`);
    const m = pattern.exec(path);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation

function navItems() {
  const admin = app.isAdmin;
  const items = [
    { href: '#/', label: 'Equipment', icon: 'grid', match: /^\/($|item|kit)/ },
    app.canSelfServe && { href: '#/checkout', label: 'Check out', icon: 'checkout', match: /^\/checkout/ },
    app.canSelfServe && { href: '#/return', label: 'Return', icon: 'return', match: /^\/return/ },
    { href: '#/loans', label: admin ? 'Loans' : 'My gear', icon: 'clock', match: /^\/loan/ },
    (admin || app.canBook) && { href: '#/bookings', label: 'Bookings', icon: 'calendar', match: /^\/bookings/ },
  ].filter(Boolean);
  const manage = admin ? [
    { href: '#/kits', label: 'Kits', icon: 'kit', match: /^\/kits?/ },
    { href: '#/audit', label: 'Shelf audit', icon: 'audit', match: /^\/audit/ },
    { href: '#/reports', label: 'Loss & damage', icon: 'chart', match: /^\/reports/ },
    { href: '#/people', label: 'People', icon: 'users', match: /^\/people/ },
    { href: '#/labels', label: 'Print labels', icon: 'tag', match: /^\/labels/ },
    { href: '#/settings', label: 'Settings', icon: 'settings', match: /^\/settings/ },
  ] : [];
  return { items, manage };
}

function openMoreMenu() {
  const { items, manage } = navItems();
  const link = (it) => h('a', { class: 'list-item', href: it.href, onclick: () => menu.close() },
    h('span', { class: 'icon-btn', style: { pointerEvents: 'none' } }, icon(it.icon)), h('div', { class: 'main' }, h('div', { class: 'title' }, it.label)), icon('chevron-right'));
  const menu = openModal({
    title: 'Menu',
    body: h('div', { class: 'list' },
      [...items, ...manage].map(link),
      link({ href: '#/account', label: 'Account & password', icon: 'key' }),
      h('button', {
        class: 'list-item', type: 'button', style: { width: '100%', background: 'none', border: 0, cursor: 'pointer', font: 'inherit', color: 'var(--out)' },
        onclick: () => { menu.close(); logout(); },
      }, h('span', { class: 'icon-btn', style: { color: 'inherit' } }, icon('logout')), h('div', { class: 'main' }, h('div', { class: 'title' }, 'Sign out')))),
  });
}

function buildShell() {
  const view = h('main', { class: 'view', id: 'view' });
  const sidebar = h('aside', { class: 'sidebar' });
  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' });
  const userChip = h('a', { class: 'user-chip', href: '#/account' });
  const brandName = h('span');
  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('camera')), brandName),
    h('div', { class: 'spacer' }),
    userChip);
  const root = h('div', { class: 'shell' }, topbar, sidebar, view, bottom);
  clear(document.getElementById('app'), root);
  shell = { root, view, sidebar, bottom, userChip, brandName };
  updateShell();
}

function updateShell() {
  const { items, manage } = navItems();
  shell.brandName.textContent = state.settings?.school_name || 'Equipment Checkout';
  document.title = `${state.settings?.school_name || 'Equipment'} · Checkout`;
  clear(shell.userChip, h('span', { class: 'avatar' }, initials(state.user.name)), h('span', { class: 'truncate', style: { maxWidth: '140px' } }, state.user.name));
  const link = (it) => h('a', { href: it.href, dataset: { match: it.match.source } }, icon(it.icon), it.label);
  clear(shell.sidebar, h('nav', null,
    items.map(link),
    manage.length ? h('div', { class: 'nav-section' }, 'Manage') : null,
    manage.map(link),
    h('div', { class: 'nav-section' }, 'Account'),
    link({ href: '#/account', label: 'Account', icon: 'user', match: /^\/account/ }),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, icon('logout'), 'Sign out')));

  // Phone tab bar: the centre button is the most common action.
  const admin = app.isAdmin;
  const center = app.canSelfServe ? { href: '#/checkout', label: 'Check out', icon: 'scan', match: /^\/checkout/ } : null;
  const tabsList = admin
    ? [items[0], items.find((i) => i.href === '#/loans'), center, items.find((i) => i.href === '#/return')]
    : [items[0], items.find((i) => i.href === '#/bookings'), center, items.find((i) => i.href === '#/loans')];
  clear(shell.bottom,
    tabsList.filter(Boolean).map((it) => h('a', { href: it.href, class: it === center ? 'scan-tab' : '', dataset: { match: it.match.source } },
      it === center ? h('span', { class: 'icon-wrap' }, icon(it.icon)) : icon(it.icon), it.label)),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); openMoreMenu(); } }, icon('menu'), 'More'));
  highlightNav(parseHash().path);
}

function highlightNav(path) {
  if (!shell) return;
  for (const a of shell.root.querySelectorAll('[data-match]')) {
    a.classList.toggle('active', new RegExp(a.dataset.match).test(path));
  }
}

// ---------------------------------------------------------------------------
// Rendering

async function render() {
  closeActiveScanner();
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  const { path, query } = parseHash();
  if (!state.user) return renderLogin();
  if (!shell) buildShell();
  if (state.user.must_change_password && path !== '/account') {
    location.hash = '#/account';
    return;
  }
  highlightNav(path);
  const matched = matchRoute(path);
  const token = ++renderToken;
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;
  if (!matched) {
    clear(shell.view, h('div', { class: 'page' }, banner('warning', 'That page does not exist.'), h('p', { style: { marginTop: '12px' } }, h('a', { href: '#/' }, 'Back to equipment'))));
    return;
  }
  if (matched.route.admin && !app.isAdmin) {
    clear(shell.view, h('div', { class: 'page' }, banner('danger', 'Only teachers and admins can open this page.')));
    return;
  }
  clear(shell.view, loading());
  try {
    const node = await matched.route.view({ params: matched.params, query, app });
    if (token !== renderToken) return;
    clear(shell.view, node);
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    clear(shell.view, h('div', { class: 'page' }, banner('danger', err.message || 'Something went wrong'),
      h('div', { style: { marginTop: '12px' } }, btn('Try again', { iconName: 'history', onClick: () => render() }))));
  }
}

function renderLogin(message) {
  shell = null;
  const username = h('input', { class: 'input', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { class: 'input', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('div');
  const submit = btn('Sign in', { type: 'submit', variant: 'primary', size: 'lg', block: true });
  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      clear(error);
      try {
        await api.post('/auth/login', { username: username.value.trim(), password: password.value });
        await boot();
      } catch (err) {
        clear(error, banner('danger', err.message));
        submit.disabled = false;
        password.select();
      }
    },
  }, error, message ? banner('info', message) : null, field('Username or student ID', username), field('Password', password), submit);
  clear(document.getElementById('app'), h('div', { class: 'login-wrap' },
    h('div', { class: 'card login-card' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('camera')), 'Equipment Checkout'),
      form,
      h('p', { class: 'small muted', style: { marginTop: '16px', textAlign: 'center' } }, 'Forgot your password? Ask your teacher to reset it.'))));
  setTimeout(() => username.focus(), 30);
}

async function logout() {
  try {
    await api.post('/auth/logout');
  } finally {
    state.user = null;
    shell = null;
    location.hash = '#/';
    renderLogin();
  }
}

async function boot() {
  try {
    await app.refreshMe();
    await app.loadCategories();
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      return renderLogin();
    }
    clear(document.getElementById('app'), h('div', { class: 'page' }, banner('danger', `Could not reach the server: ${err.message}`)));
    return;
  }
  buildShell();
  render();
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  state.user = null;
  shell = null;
  toast('Your session ended. Please sign in again.', 'warning');
  renderLogin();
});

window.addEventListener('hashchange', () => {
  if (state.user) render();
});

boot();
