import express from 'express';
import QRCode from 'qrcode';
import { isAdmin, publicUser, requireAdmin } from '../auth.js';
import {
  assetDetail, attachAsset, createAsset, deleteAsset, detachAsset, duplicateAsset, importAssets, reportDamage,
  setAssetPhoto, setAssetState, updateAsset,
} from '../services/assets.js';
import {
  categoryMap, compatibleAssets, kitWithItems, serializeAssets, statusContext,
} from '../services/inventory.js';
import { badRequest, int, notFound, str } from '../util.js';

const STATUS_CODES = ['available', 'checked_out', 'reserved', 'unavailable'];

export function assetRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;

  router.get('/categories', (_req, res) => {
    res.json({ categories: [...categoryMap(db).values()] });
  });

  router.get('/compat-tags', (_req, res) => {
    const rows = db.all('SELECT tag, COUNT(*) AS count FROM asset_compat GROUP BY tag COLLATE NOCASE ORDER BY tag COLLATE NOCASE');
    res.json({ tags: rows });
  });

  router.get('/locations', (_req, res) => {
    const rows = db.all(
      `SELECT location, COUNT(*) AS count FROM assets WHERE location IS NOT NULL AND state != 'retired'
       GROUP BY location ORDER BY location`,
    );
    res.json({ locations: rows });
  });

  // Resolves any scanned code: an item tag, a kit tag, or (staff only) a
  // student ID / username.
  router.get('/scan', (req, res) => {
    const code = str(req.query.code, 'Code', { required: true, max: 64 });
    const asset = db.get('SELECT * FROM assets WHERE tag = ?', [code]);
    if (asset) {
      const [item] = serializeAssets(ctx, req.user, [asset]);
      return res.json({ type: 'asset', asset: item });
    }
    const kit = db.get('SELECT * FROM kits WHERE tag = ?', [code]);
    if (kit) return res.json({ type: 'kit', kit: kitWithItems(ctx, req.user, kit) });
    if (isAdmin(req.user)) {
      const user = db.get('SELECT * FROM users WHERE (student_id = ? OR username = ?) AND active = 1', [code, code]);
      if (user) return res.json({ type: 'user', user: publicUser(user) });
    }
    throw notFound(`Nothing matches "${code}"`);
  });

  router.get('/assets', (req, res) => {
    const where = [];
    const params = {};
    if (req.query.include_retired !== '1') where.push("a.state != 'retired'");
    if (req.query.q) {
      where.push(`(a.tag LIKE :q ESCAPE '\\' OR a.name LIKE :q ESCAPE '\\' OR a.brand LIKE :q ESCAPE '\\'
        OR a.model LIKE :q ESCAPE '\\' OR a.serial_number LIKE :q ESCAPE '\\' OR a.category LIKE :q ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM asset_compat c WHERE c.asset_id = a.id AND c.tag LIKE :q ESCAPE '\\'))`);
      params.q = `%${String(req.query.q).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    }
    if (req.query.category) {
      where.push('a.category = :category COLLATE NOCASE');
      params.category = String(req.query.category);
    }
    if (req.query.location) {
      where.push('a.location = :location');
      params.location = String(req.query.location);
    }
    if (req.query.kit_id) {
      where.push('a.kit_id = :kit_id');
      params.kit_id = Number(req.query.kit_id);
    }
    let rows = db.all(
      `SELECT a.* FROM assets a LEFT JOIN categories c ON c.name = a.category
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(c.sort, 999), a.name, a.tag`,
      params,
    );
    let matchReasons = null;
    if (req.query.compatible_with) {
      const source = db.get('SELECT * FROM assets WHERE id = ?', [Number(req.query.compatible_with)]);
      if (!source) throw notFound('Item not found');
      const matches = compatibleAssets(ctx, source);
      matchReasons = new Map(matches.map((m) => [m.row.id, m.reason]));
      rows = rows.filter((r) => matchReasons.has(r.id));
    }
    let assets = serializeAssets(ctx, req.user, rows);
    if (matchReasons) assets = assets.map((a) => ({ ...a, match: matchReasons.get(a.id) }));
    if (req.query.status) {
      const wanted = String(req.query.status).split(',').filter((s) => STATUS_CODES.includes(s));
      assets = assets.filter((a) => wanted.includes(a.status.code));
    }
    res.json({ assets });
  });

  router.get('/assets/:id', (req, res) => {
    res.json(assetDetail(ctx, req.user, int(req.params.id, 'id', { required: true })));
  });

  router.get('/assets/:id/compatible', (req, res) => {
    const asset = db.get('SELECT * FROM assets WHERE id = ?', [Number(req.params.id)]);
    if (!asset) throw notFound('Item not found');
    const matches = compatibleAssets(ctx, asset);
    const sc = statusContext(ctx, req.user);
    const items = serializeAssets(ctx, req.user, matches.map((m) => m.row), sc).map((a, i) => ({ ...a, match: matches[i].reason }));
    res.json({ assets: items });
  });

  router.post('/assets', requireAdmin, (req, res) => {
    const id = createAsset(ctx, req.user, req.body ?? {});
    res.status(201).json(assetDetail(ctx, req.user, id));
  });

  router.post('/assets/import', requireAdmin, (req, res) => {
    res.json(importAssets(ctx, req.user, str(req.body?.csv, 'CSV', { required: true, max: 2_000_000, trim: false })));
  });

  router.patch('/assets/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    updateAsset(ctx, req.user, id, req.body ?? {});
    res.json(assetDetail(ctx, req.user, id));
  });

  router.delete('/assets/:id', requireAdmin, (req, res) => {
    deleteAsset(ctx, Number(req.params.id));
    res.json({ ok: true });
  });

  router.post('/assets/:id/duplicate', requireAdmin, (req, res) => {
    const id = duplicateAsset(ctx, req.user, Number(req.params.id), req.body ?? {});
    res.status(201).json(assetDetail(ctx, req.user, id));
  });

  router.post('/assets/:id/photo', requireAdmin, (req, res) => {
    const url = setAssetPhoto(ctx, req.user, Number(req.params.id), req.body?.image ?? null);
    res.json({ photo_url: url });
  });

  router.post('/assets/:id/attach', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!req.body?.parent_tag && !req.body?.parent_id) throw badRequest('Scan or enter the item to attach to');
    attachAsset(ctx, req.user, id, req.body);
    res.json(assetDetail(ctx, req.user, id));
  });

  router.post('/assets/:id/detach', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    detachAsset(ctx, req.user, id);
    res.json(assetDetail(ctx, req.user, id));
  });

  router.post('/assets/:id/state', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    setAssetState(ctx, req.user, id, req.body ?? {});
    res.json(assetDetail(ctx, req.user, id));
  });

  router.post('/assets/:id/damage', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    reportDamage(ctx, req.user, id, req.body ?? {});
    res.json(assetDetail(ctx, req.user, id));
  });

  // QR code for printing asset/kit labels.
  router.get('/qr.svg', async (req, res) => {
    const code = str(req.query.code, 'Code', { required: true, max: 64 });
    const svg = await QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'private, max-age=86400').send(svg);
  });

  return router;
}
