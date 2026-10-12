import crypto from 'node:crypto';
import { HttpError, sha256 } from './util.js';

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 14;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, n, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: SCRYPT.r, p: SCRYPT.p,
  });
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  if (password.length > 200) throw new HttpError(400, 'Password is too long');
  return password;
}

export function createSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = ctx.now();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  ctx.db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [sha256(token), userId, now.toISOString(), expires.toISOString()],
  );
  return { token, expires };
}

export function setSessionCookie(req, res, session) {
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    expires: session.expires,
    path: '/',
  });
}

export function clearSession(ctx, req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Populates req.user from the session cookie (or leaves it null). */
export function sessionMiddleware(ctx) {
  return (req, _res, next) => {
    req.user = null;
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const row = ctx.db.get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
        [sha256(token), ctx.now().toISOString()],
      );
      if (row) req.user = row;
    }
    next();
  };
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Only teachers and admins can do that'));
  next();
}

export const isAdmin = (user) => user?.role === 'admin';

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    student_id: user.student_id,
    role: user.role,
    active: !!user.active,
    must_change_password: !!user.must_change_password,
    restricted_until: user.restricted_until,
    restriction_note: user.restriction_note,
    created_at: user.created_at,
  };
}

/**
 * Small in-memory limiter for login attempts: at most `limit` failures per
 * key within `windowMs`.
 */
export function createLoginLimiter({ limit = 10, windowMs = 15 * 60_000 } = {}) {
  const failures = new Map();
  return {
    check(key, now = Date.now()) {
      const entry = failures.get(key);
      if (entry && now - entry.first < windowMs && entry.count >= limit) {
        throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.');
      }
    },
    fail(key, now = Date.now()) {
      const entry = failures.get(key);
      if (!entry || now - entry.first >= windowMs) failures.set(key, { first: now, count: 1 });
      else entry.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
