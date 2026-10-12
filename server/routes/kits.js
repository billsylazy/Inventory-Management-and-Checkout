import express from 'express';
import { requireAdmin } from '../auth.js';
import { assertTagFree, kitWithItems, logEvent, statusContext } from '../services/inventory.js';
import { badRequest, int, notFound, str, tagValue } from '../util.js';

export function kitRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;

  const getKit = (id) => {
    const kit = db.get('SELECT * FROM kits WHERE id = ?', [Number(id)]);
    if (!kit) throw notFound('Kit not found');
    return kit;
  };

  router.get('/kits', (req, res) => {
    const sc = statusContext(ctx, req.user);
    const kits = db.all('SELECT * FROM kits ORDER BY name, tag').map((k) => kitWithItems(ctx, req.user, k, sc));
    res.json({ kits });
  });

  router.get('/kits/:id', (req, res) => {
    res.json({ kit: kitWithItems(ctx, req.user, getKit(req.params.id)) });
  });

  router.post('/kits', requireAdmin, (req, res) => {
    const tag = tagValue(req.body?.tag);
    const name = str(req.body?.name, 'Name', { required: true, max: 120 });
    const description = str(req.body?.description, 'Description', { max: 2000 });
    assertTagFree(db, tag);
    const { id } = db.run('INSERT INTO kits (tag, name, description, created_at) VALUES (?, ?, ?, ?)', [tag, name, description, ctx.now().toISOString()]);
    res.status(201).json({ kit: kitWithItems(ctx, req.user, getKit(id)) });
  });

  router.patch('/kits/:id', requireAdmin, (req, res) => {
    const kit = getKit(req.params.id);
    const body = req.body ?? {};
    const tag = body.tag !== undefined ? tagValue(body.tag) : kit.tag;
    const name = body.name !== undefined ? str(body.name, 'Name', { required: true, max: 120 }) : kit.name;
    const description = body.description !== undefined ? str(body.description, 'Description', { max: 2000 }) : kit.description;
    assertTagFree(db, tag, { kitId: kit.id });
    db.run('UPDATE kits SET tag = ?, name = ?, description = ? WHERE id = ?', [tag, name, description, kit.id]);
    res.json({ kit: kitWithItems(ctx, req.user, getKit(kit.id)) });
  });

  router.delete('/kits/:id', requireAdmin, (req, res) => {
    const kit = getKit(req.params.id);
    const now = ctx.now().toISOString();
    db.transaction(() => {
      for (const a of db.all('SELECT id FROM assets WHERE kit_id = ?', [kit.id])) {
        logEvent(db, { assetId: a.id, type: 'kit', actorId: req.user.id, message: `Kit ${kit.tag} was deleted`, at: now });
      }
      db.run('UPDATE assets SET kit_id = NULL WHERE kit_id = ?', [kit.id]);
      db.run('DELETE FROM kits WHERE id = ?', [kit.id]);
    });
    res.json({ ok: true });
  });

  // Add an item to a kit by id or by scanning its tag.
  router.post('/kits/:id/items', requireAdmin, (req, res) => {
    const kit = getKit(req.params.id);
    const asset = req.body?.asset_id
      ? db.get('SELECT * FROM assets WHERE id = ?', [int(req.body.asset_id, 'Item', { min: 1 })])
      : db.get('SELECT * FROM assets WHERE tag = ?', [str(req.body?.tag, 'Tag', { required: true, max: 64 })]);
    if (!asset) {
      if (req.body?.tag && db.get('SELECT id FROM kits WHERE tag = ?', [req.body.tag])) throw badRequest('That is a kit tag — scan an individual item');
      throw notFound('Item not found');
    }
    if (asset.kit_id === kit.id) return res.json({ kit: kitWithItems(ctx, req.user, kit) });
    const now = ctx.now().toISOString();
    db.transaction(() => {
      if (asset.kit_id) {
        const old = db.get('SELECT tag FROM kits WHERE id = ?', [asset.kit_id]);
        logEvent(db, { assetId: asset.id, type: 'kit', actorId: req.user.id, message: `Moved out of kit ${old?.tag ?? ''}`.trim(), at: now });
      }
      db.run('UPDATE assets SET kit_id = ?, updated_at = ? WHERE id = ?', [kit.id, now, asset.id]);
      logEvent(db, { assetId: asset.id, type: 'kit', actorId: req.user.id, message: `Added to kit ${kit.tag} (${kit.name})`, at: now });
    });
    res.json({ kit: kitWithItems(ctx, req.user, kit), moved_from: asset.kit_id || null });
  });

  router.delete('/kits/:id/items/:assetId', requireAdmin, (req, res) => {
    const kit = getKit(req.params.id);
    const asset = db.get('SELECT * FROM assets WHERE id = ? AND kit_id = ?', [Number(req.params.assetId), kit.id]);
    if (!asset) throw notFound('That item is not in this kit');
    const now = ctx.now().toISOString();
    db.transaction(() => {
      db.run('UPDATE assets SET kit_id = NULL, updated_at = ? WHERE id = ?', [now, asset.id]);
      logEvent(db, { assetId: asset.id, type: 'kit', actorId: req.user.id, message: `Removed from kit ${kit.tag}`, at: now });
    });
    res.json({ kit: kitWithItems(ctx, req.user, kit) });
  });

  return router;
}
