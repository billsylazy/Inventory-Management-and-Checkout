import express from 'express';
import {
  clearSession, createLoginLimiter, createSession, hashPassword, publicUser, requireUser, setSessionCookie,
  validatePassword, verifyPassword,
} from '../auth.js';
import { restrictionFor } from '../services/restrictions.js';
import { HttpError, str } from '../util.js';

export function authRoutes(ctx) {
  const router = express.Router();
  const limiter = createLoginLimiter();

  router.post('/login', (req, res) => {
    const username = str(req.body?.username, 'Username', { required: true, max: 100 });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const key = `${req.ip}|${username.toLowerCase()}`;
    limiter.check(key);
    // Students can sign in with their username or the ID on their card.
    const user = ctx.db.get('SELECT * FROM users WHERE username = ? AND active = 1', [username])
      ?? ctx.db.get('SELECT * FROM users WHERE student_id = ? AND active = 1', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Wrong username or password');
    }
    limiter.reset(key);
    setSessionCookie(req, res, createSession(ctx, user.id));
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    clearSession(ctx, req, res);
    res.json({ ok: true });
  });

  router.get('/me', requireUser, (req, res) => {
    res.json({
      user: publicUser(req.user),
      restriction: restrictionFor(ctx, req.user.id),
      settings: ctx.publicSettings(),
    });
  });

  router.post('/password', requireUser, (req, res) => {
    const { current_password: current, new_password: next } = req.body ?? {};
    if (!verifyPassword(String(current ?? ''), req.user.password_hash)) throw new HttpError(400, 'Your current password is not correct');
    validatePassword(next);
    ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(next), req.user.id]);
    res.json({ ok: true });
  });

  return router;
}
