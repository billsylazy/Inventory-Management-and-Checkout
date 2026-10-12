import { api, qs } from '../api.js';
import {
  banner, btn, clear, debounce, emptyState, field, fmtDate, fmtDateTime, fmtMoney, fromLocalInput, h, icon, initials,
  listItem, openModal, plural, toLocalInput, toast,
} from '../ui.js';
import { loanListItem } from './loans.js';
import { backLink, restrictionContent } from './shared.js';

function flags(u) {
  const out = [];
  if (u.restriction.restricted) out.push(h('span', { class: 'badge checked_out' }, 'Restricted'));
  else if (u.overdue_items) out.push(h('span', { class: 'badge reserved' }, 'Overdue'));
  if (u.unpaid_fines_cents) out.push(h('span', { class: 'badge plain reserved' }, fmtMoney(u.unpaid_fines_cents)));
  if (!u.active) out.push(h('span', { class: 'badge' }, 'Inactive'));
  return out;
}

export async function peopleView({ query, app }) {
  const filter = query.filter ?? '';
  const { users } = await api.get(`/users${qs({ include_inactive: filter === 'inactive' ? 1 : '' })}`);
  const page = h('div', { class: 'page page-narrow' });
  const listBox = h('div', { class: 'card card-tight' });
  let q = query.q ?? '';

  const render = () => {
    const needle = q.toLowerCase();
    const shown = users.filter((u) => {
      if (filter === 'restricted' && !u.restriction.restricted) return false;
      if (filter === 'overdue' && !u.overdue_items) return false;
      if (filter === 'fines' && !u.unpaid_fines_cents) return false;
      if (filter === 'staff' && u.role !== 'admin') return false;
      if (filter === 'inactive' && u.active) return false;
      return !needle || [u.name, u.username, u.student_id, u.email].some((v) => v && v.toLowerCase().includes(needle));
    });
    clear(listBox, shown.length ? h('div', { class: 'list' }, shown.map((u) => listItem({
      href: `#/people/${u.id}`,
      leading: h('span', { class: 'avatar' }, initials(u.name)),
      title: [u.name, u.role === 'admin' ? h('span', { class: 'badge plain', style: { marginLeft: '4px' } }, 'Staff') : null],
      sub: [u.student_id ? `ID ${u.student_id}` : u.username, u.open_items ? `${plural(u.open_items, 'item')} out` : null].filter(Boolean).join(' · '),
      trailing: h('div', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } }, flags(u)),
    }))) : emptyState('users', 'No one matches', null));
  };

  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search by name or ID', value: q,
    oninput: debounce(() => { q = search.value.trim(); app.replaceQuery({ q, filter }); render(); }, 120),
  });
  const chip = (value, label) => h('a', { class: `chip${filter === value ? ' on' : ''}`, href: `#/people${qs({ filter: value })}` }, label);
  render();
  return clear(page,
    h('div', { class: 'page-header' },
      h('div', { class: 'grow' }, h('h1', null, 'People'), h('p', { class: 'sub' }, `${plural(users.length, 'person', 'people')}`)),
      btn('Import CSV', { iconName: 'upload', onClick: () => importDialog(app) }),
      btn('Add person', { variant: 'primary', iconName: 'plus', onClick: () => personDialog(app) })),
    h('div', { class: 'stack', style: { marginBottom: '12px' } },
      h('div', { class: 'search' }, icon('search'), search),
      h('div', { class: 'chips scroll' }, chip('', 'Everyone'), chip('restricted', 'Restricted'), chip('overdue', 'Overdue'), chip('fines', 'Unpaid fines'), chip('staff', 'Staff'), chip('inactive', 'Inactive'))),
    listBox);
}

function passwordNotice(username, password) {
  return banner('success', h('div', null,
    h('div', { class: 'bold' }, 'Temporary password'),
    h('div', null, 'Give this to ', h('strong', null, username), ': ', h('code', { class: 'mono', style: { fontSize: '1.05rem', userSelect: 'all' } }, password)),
    h('div', { class: 'small' }, 'They will be asked to choose a new one when they first sign in.')), 'key');
}

function personDialog(app) {
  const name = h('input', { class: 'input', placeholder: 'Full name' });
  const username = h('input', { class: 'input', autocapitalize: 'none', placeholder: 'e.g. mpatel' });
  const studentId = h('input', { class: 'input', placeholder: 'Number on their ID card' });
  const email = h('input', { class: 'input', type: 'email' });
  const role = h('select', { class: 'select' }, h('option', { value: 'student' }, 'Student'), h('option', { value: 'admin' }, 'Teacher / admin'));
  const out = h('div');
  const modal = openModal({
    title: 'Add a person',
    body: h('div', { class: 'stack' }, out, h('div', { class: 'form-grid cols-2' },
      field('Name', name), field('Username', username, 'Used to sign in.'), field('Student ID', studentId, 'Optional — lets staff scan their ID card.'),
      field('Email', email), field('Role', role))),
    actions: [
      { label: 'Close', variant: 'ghost' },
      {
        label: 'Add', variant: 'primary', icon: 'plus',
        onClick: async () => {
          const res = await api.post('/users', { name: name.value, username: username.value, student_id: studentId.value, email: email.value, role: role.value });
          clear(out, passwordNotice(res.user.username, res.temporary_password));
          for (const el of [name, username, studentId, email]) el.value = '';
          toast(`${res.user.name} added`, 'success');
          return false;
        },
      },
    ],
    onClose: () => app.refresh(),
  });
  return modal;
}

function importDialog(app) {
  const textarea = h('textarea', { class: 'textarea mono', rows: 7, placeholder: 'name,username,student_id,email,role\nMaya Patel,mpatel,S10234,,student' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv', onchange: async () => { const f = file.files?.[0]; if (f) textarea.value = await f.text(); } });
  const out = h('div');
  openModal({
    title: 'Import people from CSV',
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, 'Columns: name (required), username, student_id, email, role (student or admin), password. If username is blank the student ID is used. Missing passwords are generated.'),
      file, textarea, out),
    actions: [
      { label: 'Close', variant: 'ghost' },
      {
        label: 'Import', variant: 'primary', icon: 'upload',
        onClick: async () => {
          const res = await api.post('/users/import', { csv: textarea.value });
          const generated = res.created.filter((c) => c.temporary_password);
          clear(out, banner(res.errors.length ? 'warning' : 'success', h('div', null,
            h('div', { class: 'bold' }, `Added ${plural(res.created.length, 'person', 'people')}.`),
            res.errors.length ? h('ul', null, res.errors.slice(0, 20).map((e) => h('li', null, `Line ${e.line}: ${e.error}`))) : null)),
          generated.length ? h('div', { class: 'stack-sm', style: { marginTop: '10px' } },
            h('div', { class: 'small bold' }, 'Temporary passwords (copy these now — they are not shown again):'),
            h('textarea', { class: 'textarea mono', rows: Math.min(10, generated.length + 1), readOnly: true },
              ['username,temporary_password', ...generated.map((g) => `${g.username},${g.temporary_password}`)].join('\n'))) : null);
          return false;
        },
      },
    ],
    onClose: () => app.refresh(),
  });
}

export async function personView({ params, app }) {
  const { user, loans, fines } = await api.get(`/users/${params.id}`);
  const page = h('div', { class: 'page page-narrow' });
  const notice = h('div');

  const save = async (body, message = 'Saved') => {
    const res = await api.patch(`/users/${user.id}`, body);
    toast(message, 'success');
    if (res.temporary_password) {
      clear(notice, passwordNotice(res.user.username, res.temporary_password));
      return;
    }
    app.refresh();
  };

  const edit = () => {
    const name = h('input', { class: 'input', value: user.name });
    const username = h('input', { class: 'input', value: user.username });
    const studentId = h('input', { class: 'input', value: user.student_id ?? '' });
    const email = h('input', { class: 'input', value: user.email ?? '' });
    const role = h('select', { class: 'select' }, h('option', { value: 'student', selected: user.role === 'student' }, 'Student'), h('option', { value: 'admin', selected: user.role === 'admin' }, 'Teacher / admin'));
    openModal({
      title: 'Edit person',
      body: h('div', { class: 'form-grid cols-2' }, field('Name', name), field('Username', username), field('Student ID', studentId), field('Email', email), field('Role', role)),
      actions: [{ label: 'Cancel', variant: 'ghost' }, {
        label: 'Save', variant: 'primary',
        onClick: () => save({ name: name.value, username: username.value, student_id: studentId.value, email: email.value, role: role.value }),
      }],
    });
  };

  const restrict = () => {
    const until = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(new Date(Date.now() + 7 * 86400_000)) });
    const note = h('input', { class: 'input', placeholder: 'Reason (shown to the student)', value: user.restriction_note ?? '' });
    openModal({
      title: `Restrict ${user.name}`,
      body: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'They won’t be able to book or check out new gear until this date. Overdue items restrict students automatically — this is for anything else.'),
        field('Restricted until', until), field('Reason', note)),
      actions: [{ label: 'Cancel', variant: 'ghost' }, {
        label: 'Restrict', variant: 'solid-danger',
        onClick: () => save({ restricted_until: fromLocalInput(until.value), restriction_note: note.value }, 'Restriction set'),
      }],
    });
  };

  const fineAction = (f, status, label) => btn(label, {
    size: 'sm',
    onClick: async () => {
      await api.post(`/fines/${f.id}`, { status });
      toast(`Fine marked ${status}`, 'success');
      app.refresh();
    },
  });

  const manual = user.restricted_until && new Date(user.restricted_until) > new Date();
  return clear(page,
    backLink('#/people', 'People'),
    h('div', { class: 'page-header' },
      h('span', { class: 'avatar', style: { width: '52px', height: '52px', fontSize: '1.1rem' } }, initials(user.name)),
      h('div', { class: 'grow' }, h('h1', null, user.name),
        h('p', { class: 'sub' }, [user.role === 'admin' ? 'Teacher / admin' : 'Student', user.username, user.student_id ? `ID ${user.student_id}` : null, user.email].filter(Boolean).join(' · '))),
      btn('Edit', { iconName: 'edit', onClick: edit })),
    notice,
    restrictionContent(user.restriction, { self: false, name: user.name }),
    h('div', { class: 'action-bar', style: { marginBottom: '16px' } },
      btn('Check out to them', { variant: 'primary', iconName: 'checkout', href: `#/checkout${qs({ borrower: user.id })}` }),
      manual ? btn('Lift restriction', { iconName: 'check', onClick: () => save({ restricted_until: null, restriction_note: null }, 'Restriction lifted') })
        : btn('Restrict', { iconName: 'ban', variant: 'danger', onClick: restrict }),
      btn('Reset password', { iconName: 'key', onClick: () => save({ reset_password: true }, 'Password reset') }),
      user.active ? btn('Deactivate', { iconName: 'x', variant: 'ghost', onClick: () => save({ active: false }, 'Deactivated') })
        : btn('Reactivate', { iconName: 'check', onClick: () => save({ active: true }, 'Reactivated') })),
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, icon('clock'), h('h2', null, 'Loans')),
      loans.length ? h('div', { class: 'list' }, loans.map((l) => loanListItem(l, { showBorrower: false }))) : h('p', { class: 'small muted' }, 'No loans yet.')),
    h('section', { class: 'section card' },
      h('div', { class: 'card-title' }, icon('alert'), h('h2', null, 'Fines')),
      fines.length ? h('div', { class: 'list' }, fines.map((f) => h('div', { class: 'list-item' },
        h('div', { class: 'main' }, h('div', { class: 'title' }, fmtMoney(f.amount_cents), ' ', h('span', { class: `badge plain ${f.status === 'unpaid' ? 'checked_out' : 'available'}` }, f.status)),
          h('div', { class: 'sub' }, `${f.reason} · ${fmtDate(f.created_at)}${f.resolved_at ? ` · ${f.status} ${fmtDateTime(f.resolved_at)}${f.resolved_by ? ` by ${f.resolved_by}` : ''}` : ''}`)),
        f.status === 'unpaid' ? h('div', { class: 'row', style: { gap: '4px' } }, fineAction(f, 'paid', 'Paid'), fineAction(f, 'waived', 'Waive')) : fineAction(f, 'unpaid', 'Undo')))) : h('p', { class: 'small muted' }, 'No fines.')));
}
