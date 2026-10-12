import crypto from 'node:crypto';
import express from 'express';
import { hashPassword, publicUser, requireAdmin, validatePassword } from '../auth.js';
import { parseCsvObjects } from '../csv.js';
import { listLoans } from '../services/loans.js';
import { restrictionFor } from '../services/restrictions.js';
import {
  HttpError, badRequest, conflict, isoDate, notFound, oneOf, str,
} from '../util.js';

/** Readable temporary password, e.g. "kite-4821-moss". */
function tempPassword() {
  const words = ['kite', 'moss', 'lens', 'film', 'reel', 'zoom', 'flash', 'frame', 'pixel', 'focus', 'light', 'shade', 'track', 'scene'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${crypto.randomInt(1000, 10000)}-${pick()}`;
}

export function userRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;
  router.use(requireAdmin);

  const getUser = (id) => {
    const user = db.get('SELECT * FROM users WHERE id = ?', [Number(id)]);
    if (!user) throw notFound('User not found');
    return user;
  };

  function assertUnique(username, studentId, exceptId = 0) {
    if (db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, exceptId])) throw conflict(`Username ${username} is taken`);
    if (studentId && db.get('SELECT id FROM users WHERE student_id = ? AND id != ?', [studentId, exceptId])) {
      throw conflict(`Student ID ${studentId} is already assigned`);
    }
    if (studentId && (db.get('SELECT id FROM assets WHERE tag = ?', [studentId]) || db.get('SELECT id FROM kits WHERE tag = ?', [studentId]))) {
      throw conflict(`Student ID ${studentId} matches an equipment tag; scans would be ambiguous`);
    }
  }

  function createUser(input) {
    const username = str(input.username, 'Username', { required: true, max: 60 });
    if (!/^[A-Za-z0-9._@-]+$/.test(username)) throw badRequest('Usernames may only use letters, numbers, dots, dashes, underscores and @');
    const name = str(input.name, 'Name', { required: true, max: 100 });
    const email = str(input.email, 'Email', { max: 200 });
    const studentId = str(input.student_id, 'Student ID', { max: 64 });
    const role = oneOf(input.role || 'student', 'Role', ['admin', 'student']);
    assertUnique(username, studentId);
    const generated = !input.password;
    const password = generated ? tempPassword() : validatePassword(input.password);
    const { id } = db.run(
      `INSERT INTO users (username, name, email, student_id, role, password_hash, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [username, name, email, studentId, role, hashPassword(password), ctx.now().toISOString()],
    );
    return { id, password: generated ? password : null };
  }

  function summary(user) {
    const now = ctx.now().toISOString();
    const stats = db.get(
      `SELECT COUNT(*) AS open_items,
         SUM(CASE WHEN l.due_at < ? THEN 1 ELSE 0 END) AS overdue_items
       FROM loan_items li JOIN loans l ON l.id = li.loan_id
       WHERE l.borrower_id = ? AND li.outcome IS NULL`,
      [now, user.id],
    );
    const fines = db.get("SELECT COALESCE(SUM(amount_cents), 0) AS unpaid FROM fines WHERE user_id = ? AND status = 'unpaid'", [user.id]);
    return {
      ...publicUser(user),
      open_items: stats.open_items ?? 0,
      overdue_items: stats.overdue_items ?? 0,
      unpaid_fines_cents: fines.unpaid,
      restriction: restrictionFor(ctx, user.id),
    };
  }

  router.get('/users', (req, res) => {
    const where = [];
    const params = {};
    if (req.query.q) {
      where.push("(name LIKE :q ESCAPE '\\' OR username LIKE :q ESCAPE '\\' OR student_id LIKE :q ESCAPE '\\' OR email LIKE :q ESCAPE '\\')");
      params.q = `%${String(req.query.q).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    }
    if (req.query.role) {
      where.push('role = :role');
      params.role = String(req.query.role);
    }
    if (req.query.include_inactive !== '1') where.push('active = 1');
    const users = db.all(`SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY role, name LIMIT 1000`, params);
    res.json({ users: users.map(summary) });
  });

  router.get('/users/:id', (req, res) => {
    const user = getUser(req.params.id);
    const fines = db.all(
      `SELECT f.*, r.name AS resolved_by_name FROM fines f LEFT JOIN users r ON r.id = f.resolved_by
       WHERE f.user_id = ? ORDER BY f.created_at DESC`,
      [user.id],
    );
    res.json({
      user: summary(user),
      loans: listLoans(ctx, req.user, { scope: 'all', userId: user.id, limit: 50 }),
      fines: fines.map((f) => ({
        id: f.id, amount_cents: f.amount_cents, reason: f.reason, status: f.status, created_at: f.created_at,
        resolved_at: f.resolved_at, resolved_by: f.resolved_by_name,
      })),
    });
  });

  router.post('/users', (req, res) => {
    const { id, password } = createUser(req.body ?? {});
    res.status(201).json({ user: summary(getUser(id)), temporary_password: password });
  });

  // CSV columns: name, username, student_id, email, role, password
  router.post('/users/import', (req, res) => {
    const rows = parseCsvObjects(str(req.body?.csv, 'CSV', { required: true, max: 2_000_000, trim: false }));
    if (!rows.length) throw badRequest('The CSV file is empty. The first row must be a header.');
    if (rows.length > 3000) throw badRequest('Please import at most 3,000 people at a time');
    const created = [];
    const errors = [];
    db.transaction(() => {
      for (const row of rows) {
        try {
          const username = row.username || row.student_id;
          const { id, password } = createUser({ ...row, username });
          created.push({ id, username, name: row.name, temporary_password: password });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          errors.push({ line: row._line, name: row.name, error: err.message });
        }
      }
    });
    res.json({ created, errors });
  });

  router.patch('/users/:id', (req, res) => {
    const user = getUser(req.params.id);
    const body = req.body ?? {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const next = {
      username: has('username') ? str(body.username, 'Username', { required: true, max: 60 }) : user.username,
      name: has('name') ? str(body.name, 'Name', { required: true, max: 100 }) : user.name,
      email: has('email') ? str(body.email, 'Email', { max: 200 }) : user.email,
      student_id: has('student_id') ? str(body.student_id, 'Student ID', { max: 64 }) : user.student_id,
      role: has('role') ? oneOf(body.role, 'Role', ['admin', 'student']) : user.role,
      active: has('active') ? (body.active ? 1 : 0) : user.active,
      restricted_until: has('restricted_until') ? isoDate(body.restricted_until, 'Restricted until', { required: false }) : user.restricted_until,
      restriction_note: has('restriction_note') ? str(body.restriction_note, 'Restriction note', { max: 300 }) : user.restriction_note,
    };
    if (user.id === req.user.id && (next.role !== 'admin' || !next.active)) {
      throw badRequest("You can't remove your own admin access or deactivate yourself");
    }
    assertUnique(next.username, next.student_id, user.id);
    db.transaction(() => {
      db.run(
        `UPDATE users SET username = :username, name = :name, email = :email, student_id = :student_id, role = :role,
           active = :active, restricted_until = :restricted_until, restriction_note = :restriction_note WHERE id = :id`,
        { ...next, id: user.id },
      );
      if (!next.active) db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    });
    let password = null;
    if (body.reset_password) {
      password = body.new_password ? validatePassword(body.new_password) : tempPassword();
      db.transaction(() => {
        db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(password), user.id]);
        db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      });
    }
    res.json({ user: summary(getUser(user.id)), temporary_password: password });
  });

  router.get('/fines', (req, res) => {
    const status = ['unpaid', 'paid', 'waived'].includes(req.query.status) ? req.query.status : null;
    const rows = db.all(
      `SELECT f.*, u.name AS user_name FROM fines f JOIN users u ON u.id = f.user_id
       ${status ? 'WHERE f.status = ?' : ''} ORDER BY f.created_at DESC LIMIT 500`,
      status ? [status] : [],
    );
    res.json({ fines: rows.map((f) => ({ id: f.id, user: { id: f.user_id, name: f.user_name }, amount_cents: f.amount_cents, reason: f.reason, status: f.status, created_at: f.created_at, resolved_at: f.resolved_at })) });
  });

  router.post('/fines/:id', (req, res) => {
    const fine = db.get('SELECT * FROM fines WHERE id = ?', [Number(req.params.id)]);
    if (!fine) throw notFound('Fine not found');
    const status = oneOf(req.body?.status, 'Status', ['unpaid', 'paid', 'waived']);
    db.run(
      'UPDATE fines SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?',
      status === 'unpaid' ? [status, null, null, fine.id] : [status, ctx.now().toISOString(), req.user.id, fine.id],
    );
    res.json({ ok: true });
  });

  return router;
}
