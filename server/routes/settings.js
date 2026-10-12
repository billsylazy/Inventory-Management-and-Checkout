import express from 'express';
import { requireAdmin } from '../auth.js';
import { SETTINGS, updateSettings } from '../settings.js';
import { badRequest, conflict, int, notFound, oneOf, str } from '../util.js';

export const ICONS = ['camera', 'video', 'lens', 'battery', 'charger', 'sdcard', 'tripod', 'mic', 'light', 'bag', 'cable', 'drone', 'audio', 'box'];

export function settingsRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;

  router.get('/settings', (_req, res) => {
    res.json({
      settings: ctx.settings(),
      fields: Object.entries(SETTINGS).map(([key, def]) => ({ key, ...def })),
      icons: ICONS,
    });
  });

  router.patch('/settings', requireAdmin, (req, res) => {
    res.json({ settings: updateSettings(db, req.body ?? {}) });
  });

  router.post('/categories', requireAdmin, (req, res) => {
    const name = str(req.body?.name, 'Name', { required: true, max: 60 });
    if (db.get('SELECT name FROM categories WHERE name = ?', [name])) throw conflict(`Category ${name} already exists`);
    db.run(
      'INSERT INTO categories (name, kind, icon, sort) VALUES (?, ?, ?, ?)',
      [name, oneOf(req.body?.kind ?? 'accessory', 'Kind', ['main', 'accessory']), oneOf(req.body?.icon ?? 'box', 'Icon', ICONS), int(req.body?.sort, 'Sort', { min: 0, max: 10000 }) ?? 500],
    );
    res.status(201).json({ ok: true });
  });

  router.patch('/categories/:name', requireAdmin, (req, res) => {
    const cat = db.get('SELECT * FROM categories WHERE name = ?', [req.params.name]);
    if (!cat) throw notFound('Category not found');
    const body = req.body ?? {};
    db.run('UPDATE categories SET kind = ?, icon = ?, sort = ? WHERE name = ?', [
      body.kind !== undefined ? oneOf(body.kind, 'Kind', ['main', 'accessory']) : cat.kind,
      body.icon !== undefined ? oneOf(body.icon, 'Icon', ICONS) : cat.icon,
      body.sort !== undefined ? int(body.sort, 'Sort', { required: true, min: 0, max: 10000 }) : cat.sort,
      cat.name,
    ]);
    res.json({ ok: true });
  });

  router.delete('/categories/:name', requireAdmin, (req, res) => {
    const cat = db.get('SELECT * FROM categories WHERE name = ?', [req.params.name]);
    if (!cat) throw notFound('Category not found');
    const used = db.get('SELECT COUNT(*) AS n FROM assets WHERE category = ? COLLATE NOCASE', [cat.name]).n;
    if (used) throw badRequest(`${used} item${used === 1 ? ' uses' : 's use'} this category. Move them to another category first.`);
    db.run('DELETE FROM categories WHERE name = ?', [cat.name]);
    res.json({ ok: true });
  });

  return router;
}
