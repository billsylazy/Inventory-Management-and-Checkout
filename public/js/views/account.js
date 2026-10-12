import { api } from '../api.js';
import {
  banner, btn, clear, field, h, toast,
} from '../ui.js';
import { personChip, restrictionBanner } from './shared.js';

export async function accountView({ app }) {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const error = h('div');
  const forced = app.user.must_change_password;
  const form = h('form', {
    class: 'card stack',
    onsubmit: async (e) => {
      e.preventDefault();
      clear(error);
      if (next.value !== again.value) return clear(error, banner('danger', 'The new passwords don’t match'));
      try {
        await api.post('/auth/password', { current_password: current.value, new_password: next.value });
        toast('Password changed', 'success');
        await app.refreshMe();
        app.navigate('#/');
      } catch (err) {
        clear(error, banner('danger', err.message));
      }
    },
  },
  h('h2', null, 'Change password'),
  forced ? banner('warning', 'Please choose your own password before continuing.') : null,
  error,
  field('Current password', current),
  field('New password', next, 'At least 8 characters.'),
  field('New password again', again),
  h('div', null, btn('Change password', { type: 'submit', variant: 'primary' })));

  return h('div', { class: 'page page-narrow' },
    h('div', { class: 'page-header' }, h('h1', null, 'Account')),
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, personChip(app.user)),
      restrictionBanner(app),
      form));
}
