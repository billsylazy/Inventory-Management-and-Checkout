import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hashPassword, requireUser, sessionMiddleware } from './auth.js';
import { openDatabase } from './db.js';
import { assetRoutes } from './routes/assets.js';
import { auditRoutes } from './routes/audits.js';
import { authRoutes } from './routes/auth.js';
import { kitRoutes } from './routes/kits.js';
import { loanRoutes } from './routes/loans.js';
import { reportRoutes } from './routes/reports.js';
import { reservationRoutes } from './routes/reservations.js';
import { settingsRoutes } from './routes/settings.js';
import { userRoutes } from './routes/users.js';
import { getSettings } from './settings.js';
import { FILE_KINDS, HttpError } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Shared context handed to every route and service.
 * `now` is injectable so tests can move the clock (overdue logic etc.).
 */
export function createContext({ dbPath, uploadsDir, now } = {}) {
  const db = openDatabase(dbPath ?? ':memory:');
  const ctx = {
    db,
    uploadsDir: uploadsDir ?? path.join(ROOT, 'data', 'uploads'),
    now: now ?? (() => new Date()),
    settings: () => getSettings(db),
    publicSettings: () => getSettings(db),
  };
  fs.mkdirSync(ctx.uploadsDir, { recursive: true });
  return ctx;
}

/** Creates the first admin account if there is none. Returns its password when generated. */
export function ensureAdmin(ctx, { username = 'admin', password } = {}) {
  const existing = ctx.db.get("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1");
  if (existing) return null;
  const pw = password || crypto.randomBytes(9).toString('base64url');
  ctx.db.run(
    `INSERT INTO users (username, name, role, password_hash, must_change_password, created_at)
     VALUES (?, 'Administrator', 'admin', ?, ?, ?)`,
    [username, hashPassword(pw), password ? 0 : 1, ctx.now().toISOString()],
  );
  return { username, password: pw };
}

export function createApp(ctx, { trustProxy = 'loopback' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  app.use('/api', express.json({ limit: '15mb' }));
  // CSRF defence: state-changing API calls must be JSON, which a cross-site
  // form cannot send without a CORS preflight (and we never allow CORS).
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Requests must be sent as JSON'));
    }
    next();
  });
  app.use(sessionMiddleware(ctx));

  app.use('/api/auth', authRoutes(ctx));
  app.use('/api', requireUser);
  app.use('/api', settingsRoutes(ctx));
  app.use('/api', assetRoutes(ctx));
  app.use('/api', kitRoutes(ctx));
  app.use('/api', loanRoutes(ctx));
  app.use('/api', reservationRoutes(ctx));
  app.use('/api', auditRoutes(ctx));
  app.use('/api', reportRoutes(ctx));
  app.use('/api', userRoutes(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint')));

  // Uploaded images. Item photos are visible to everyone signed in; return
  // photos and signatures only to staff.
  app.get('/files/:kind/:name', requireUser, (req, res, next) => {
    const { kind, name } = req.params;
    if (!FILE_KINDS.includes(kind) || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) return next(new HttpError(404, 'Not found'));
    if (kind !== 'assets' && req.user.role !== 'admin') return next(new HttpError(403, 'Not allowed'));
    res.set('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(path.join(ctx.uploadsDir, kind, name), (err) => {
      if (err && !res.headersSent) next(new HttpError(404, 'Not found'));
    });
  });

  // Barcode scanning library, served locally so scanning works offline.
  app.get('/vendor/html5-qrcode.min.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(ROOT, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js'));
  });

  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h' }));

  // Single-page app: any other GET serves the shell.
  app.get(/^\/(?!api\/|files\/).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
      return res.status(409).json({ error: 'That conflicts with an existing record' });
    }
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}
