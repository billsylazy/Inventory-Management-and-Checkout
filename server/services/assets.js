import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAdmin } from '../auth.js';
import { parseCsvObjects } from '../csv.js';
import {
  HttpError, badRequest, bool, conflict, fileUrl, int, notFound, oneOf, saveImage, str, tagValue,
} from '../util.js';
import {
  ACTIVE_RESERVATION_SQL, CONDITIONS, STATE_LABELS, ancestors, assertTagFree, categoryMap, compatTagsFor, compatibleAssets,
  descendants, logEvent, reservationWindowParams, serializeAsset, serializeAssets, setCompatTags, statusContext,
} from './inventory.js';

const STATES = Object.keys(STATE_LABELS);

function dollarsToCents(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw badRequest(`${field} must be a dollar amount`);
  return Math.round(n * 100);
}

/** Validates create/update input. With `partial`, only provided keys are returned. */
function readAssetInput(ctx, input, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has('tag')) out.tag = tagValue(input.tag);
  if (!partial || has('name')) out.name = str(input.name, 'Name', { required: true, max: 120 });
  if (!partial || has('category')) {
    out.category = str(input.category, 'Category', { required: true, max: 60 });
    const known = categoryMap(ctx.db).get(out.category.toLowerCase());
    if (!known) throw badRequest(`Unknown category "${out.category}". Add it in Settings first.`);
    out.category = known.name;
  }
  for (const [key, label, max] of [
    ['brand', 'Brand', 60], ['model', 'Model', 80], ['serial_number', 'Serial number', 80],
    ['description', 'Description', 2000], ['location', 'Location', 80], ['notes', 'Notes', 2000],
  ]) {
    if (!partial || has(key)) out[key] = str(input[key], label, { max });
  }
  if (has('value_cents')) out.value_cents = int(input.value_cents, 'Value', { min: 0, max: 1_000_000_000 }) ?? 0;
  else if (has('value')) out.value_cents = dollarsToCents(input.value, 'Value') ?? 0;
  else if (!partial) out.value_cents = 0;
  if (!partial || has('requires_signature')) out.requires_signature = bool(input.requires_signature);
  if (has('condition')) out.condition = oneOf(input.condition, 'Condition', CONDITIONS);
  if (has('compat')) {
    if (!Array.isArray(input.compat)) throw badRequest('Compatibility tags must be a list');
    out.compat = input.compat;
  }
  return out;
}

export function createAsset(ctx, actor, input) {
  const { db } = ctx;
  const data = readAssetInput(ctx, input, { partial: false });
  assertTagFree(db, data.tag);
  const kitId = input.kit_id ? int(input.kit_id, 'Kit', { min: 1 }) : null;
  if (kitId && !db.get('SELECT id FROM kits WHERE id = ?', [kitId])) throw notFound('Kit not found');
  const now = ctx.now().toISOString();
  return db.transaction(() => {
    const { id } = db.run(
      `INSERT INTO assets (tag, name, category, brand, model, serial_number, description, value_cents, requires_signature,
         location, condition, notes, kit_id, created_at, updated_at)
       VALUES (:tag, :name, :category, :brand, :model, :serial_number, :description, :value_cents, :requires_signature,
         :location, :condition, :notes, :kit_id, :now, :now)`,
      {
        tag: data.tag, name: data.name, category: data.category, brand: data.brand, model: data.model,
        serial_number: data.serial_number, description: data.description, value_cents: data.value_cents,
        requires_signature: data.requires_signature, location: data.location, condition: data.condition ?? 'excellent',
        notes: data.notes, kit_id: kitId, now,
      },
    );
    if (data.compat) setCompatTags(db, id, data.compat);
    logEvent(db, { assetId: id, type: 'created', actorId: actor.id, message: 'Added to inventory', at: now });
    if (input.parent_tag || input.parent_id) attachAsset(ctx, actor, id, { parent_tag: input.parent_tag, parent_id: input.parent_id });
    return id;
  });
}

export function updateAsset(ctx, actor, id, input) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const data = readAssetInput(ctx, input, { partial: true });
  if (data.tag) assertTagFree(db, data.tag, { assetId: id });
  const now = ctx.now().toISOString();
  db.transaction(() => {
    const { compat, ...fields } = data;
    const changed = Object.keys(fields).filter((k) => fields[k] !== asset[k] && !(k === 'requires_signature' && Number(fields[k]) === asset[k]));
    if (changed.length) {
      db.run(
        `UPDATE assets SET ${changed.map((k) => `${k} = :${k}`).join(', ')}, updated_at = :now WHERE id = :id`,
        { ...Object.fromEntries(changed.map((k) => [k, fields[k]])), now, id },
      );
    }
    if (compat) setCompatTags(db, id, compat);
    if (changed.length || compat) {
      const labels = [...changed, ...(compat ? ['compatibility tags'] : [])].map((k) => k.replace(/_cents$/, '').replace(/_/g, ' '));
      logEvent(db, { assetId: id, type: 'updated', actorId: actor.id, message: `Updated ${labels.join(', ')}`, at: now });
    }
  });
}

export function deleteAsset(ctx, id) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const used = db.get('SELECT COUNT(*) AS n FROM loan_items WHERE asset_id = ?', [id]).n;
  if (used > 0) throw conflict('This item has check-out history. Set it to "Retired" instead of deleting it.');
  db.transaction(() => {
    db.run('UPDATE assets SET parent_id = NULL WHERE parent_id = ?', [id]);
    db.run('DELETE FROM assets WHERE id = ?', [id]);
  });
  if (asset.photo) fs.rmSync(path.join(ctx.uploadsDir, asset.photo), { force: true });
}

function openLoanId(db, assetId) {
  return db.get('SELECT loan_id FROM loan_items WHERE asset_id = ? AND outcome IS NULL', [assetId])?.loan_id ?? null;
}

/** Links an accessory (child) to a main asset (parent), e.g. a lens to a camera body. */
export function attachAsset(ctx, actor, childId, { parent_tag: parentTag, parent_id: parentId }) {
  const { db } = ctx;
  const child = db.get('SELECT * FROM assets WHERE id = ?', [childId]);
  if (!child) throw notFound('Item not found');
  const parent = parentId
    ? db.get('SELECT * FROM assets WHERE id = ?', [Number(parentId)])
    : db.get('SELECT * FROM assets WHERE tag = ?', [str(parentTag, 'Parent tag', { required: true, max: 64 })]);
  if (!parent) throw notFound('The item to attach to was not found');
  if (parent.id === child.id) throw badRequest('An item cannot be attached to itself');
  if (ancestors(db, parent.id).some((a) => a.id === child.id)) {
    throw badRequest(`${parent.tag} is already attached under ${child.tag}`);
  }
  if (child.parent_id === parent.id) return;
  if (openLoanId(db, child.id) !== openLoanId(db, parent.id)) {
    throw conflict('Both items must be checked in (or on the same loan) before attaching them');
  }
  const now = ctx.now().toISOString();
  db.transaction(() => {
    if (child.parent_id) detachAsset(ctx, actor, child.id);
    db.run('UPDATE assets SET parent_id = ?, updated_at = ? WHERE id = ?', [parent.id, now, child.id]);
    logEvent(db, { assetId: child.id, type: 'attached', actorId: actor.id, message: `Attached to ${parent.tag} (${parent.name})`, at: now });
    logEvent(db, { assetId: parent.id, type: 'attached', actorId: actor.id, message: `${child.tag} (${child.name}) attached`, at: now });
  });
}

export function detachAsset(ctx, actor, childId) {
  const { db } = ctx;
  const child = db.get('SELECT * FROM assets WHERE id = ?', [childId]);
  if (!child) throw notFound('Item not found');
  if (!child.parent_id) return;
  const parent = db.get('SELECT * FROM assets WHERE id = ?', [child.parent_id]);
  const now = ctx.now().toISOString();
  db.transaction(() => {
    db.run('UPDATE assets SET parent_id = NULL, updated_at = ? WHERE id = ?', [now, child.id]);
    logEvent(db, { assetId: child.id, type: 'detached', actorId: actor.id, message: `Detached from ${parent?.tag ?? 'parent'}`, at: now });
    if (parent) logEvent(db, { assetId: parent.id, type: 'detached', actorId: actor.id, message: `${child.tag} (${child.name}) detached`, at: now });
  });
}

/**
 * Staff changes an item's lifecycle state. Marking lost records a loss
 * incident; bringing a lost/in-repair item back resolves open incidents.
 */
export function setAssetState(ctx, actor, id, input) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const state = oneOf(input.state, 'State', STATES);
  const notes = str(input.notes, 'Notes', { max: 1000 });
  const condition = input.condition ? oneOf(input.condition, 'Condition', CONDITIONS) : null;
  if (openLoanId(db, id)) {
    throw conflict('This item is checked out. Process the return (or mark it lost from the loan) first.');
  }
  const now = ctx.now().toISOString();
  db.transaction(() => {
    db.run(
      'UPDATE assets SET state = ?, condition = COALESCE(?, condition), updated_at = ? WHERE id = ?',
      [state, condition, now, id],
    );
    if (state === 'lost' && asset.state !== 'lost') {
      db.run(
        `INSERT INTO incidents (asset_id, type, reported_by, notes, cost_cents, created_at) VALUES (?, 'lost', ?, ?, ?, ?)`,
        [id, actor.id, notes, asset.value_cents, now],
      );
    }
    if (asset.state === 'lost' && state !== 'lost') {
      db.run("UPDATE incidents SET resolved_at = ?, resolution = 'found' WHERE asset_id = ? AND type = 'lost' AND resolved_at IS NULL", [now, id]);
    }
    if (asset.state === 'repair' && state === 'active') {
      db.run("UPDATE incidents SET resolved_at = ?, resolution = 'repaired' WHERE asset_id = ? AND type = 'damaged' AND resolved_at IS NULL", [now, id]);
    }
    if (state !== asset.state || condition) {
      let message = state === asset.state ? 'Condition updated' : `Status changed: ${STATE_LABELS[asset.state]} → ${STATE_LABELS[state]}`;
      if (asset.state === 'lost' && state === 'active') message = 'Found — back in service';
      if (condition) message += ` · condition ${condition}`;
      if (notes) message += ` · "${notes}"`;
      logEvent(db, { assetId: id, type: state === 'lost' ? 'lost' : 'state', actorId: actor.id, message, at: now });
    }
  });
}

/** Staff: record damage found outside a return (e.g. spotted on the shelf). */
export function reportDamage(ctx, actor, id, input) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const notes = str(input.notes, 'Description of the damage', { required: true, max: 1000 });
  const photo = input.photo ? saveImage(ctx.uploadsDir, 'photos', input.photo) : null;
  const toRepair = input.to_repair !== false && !openLoanId(db, id);
  const now = ctx.now().toISOString();
  db.transaction(() => {
    db.run(
      `UPDATE assets SET condition = 'damaged', state = CASE WHEN ? THEN 'repair' ELSE state END, updated_at = ? WHERE id = ?`,
      [toRepair && asset.state === 'active', now, id],
    );
    db.run(
      `INSERT INTO incidents (asset_id, type, reported_by, notes, photo, created_at) VALUES (?, 'damaged', ?, ?, ?, ?)`,
      [id, actor.id, notes, photo, now],
    );
    logEvent(db, { assetId: id, type: 'damage', actorId: actor.id, message: `Damage reported · "${notes}"`, photo, at: now });
  });
}

export function setAssetPhoto(ctx, actor, id, image) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const photo = image ? saveImage(ctx.uploadsDir, 'assets', image) : null;
  db.run('UPDATE assets SET photo = ?, updated_at = ? WHERE id = ?', [photo, ctx.now().toISOString(), id]);
  if (asset.photo) fs.rmSync(path.join(ctx.uploadsDir, asset.photo), { force: true });
  return fileUrl(photo);
}

export function duplicateAsset(ctx, actor, id, input) {
  const { db } = ctx;
  const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) throw notFound('Item not found');
  const tag = tagValue(input.tag);
  const compat = compatTagsFor(db, [id]).get(id) ?? [];
  const newId = createAsset(ctx, actor, {
    tag, name: asset.name, category: asset.category, brand: asset.brand, model: asset.model,
    description: asset.description, value_cents: asset.value_cents, requires_signature: !!asset.requires_signature,
    location: asset.location, compat,
  });
  if (asset.photo) {
    const copy = `assets/${crypto.randomBytes(16).toString('hex')}${path.extname(asset.photo)}`;
    fs.copyFileSync(path.join(ctx.uploadsDir, asset.photo), path.join(ctx.uploadsDir, copy));
    db.run('UPDATE assets SET photo = ? WHERE id = ?', [copy, newId]);
  }
  return newId;
}

// ---------------------------------------------------------------------------

export function assetDetail(ctx, viewer, id) {
  const { db } = ctx;
  const admin = isAdmin(viewer);
  const row = db.get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!row) throw notFound('Item not found');
  const sc = statusContext(ctx, viewer);
  const categories = categoryMap(db);
  const compat = compatTagsFor(db, [id]);
  const asset = serializeAsset(row, sc, { compat, categories });
  Object.assign(asset, {
    serial_number: admin ? row.serial_number : null,
    description: row.description,
    notes: admin ? row.notes : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const parent = row.parent_id ? db.get('SELECT * FROM assets WHERE id = ?', [row.parent_id]) : null;
  const children = db.all('SELECT * FROM assets WHERE parent_id = ? ORDER BY tag', [id]);
  const kit = row.kit_id ? db.get('SELECT id, tag, name FROM kits WHERE id = ?', [row.kit_id]) : null;
  const matches = compatibleAssets(ctx, row);
  const compatible = serializeAssets(ctx, viewer, matches.map((m) => m.row), sc).map((a, i) => ({ ...a, match: matches[i].reason }));

  const { now, pickupCutoff } = reservationWindowParams(ctx);
  const reservations = db.all(
    `SELECT r.id, r.user_id, u.name AS user_name, r.start_at, r.end_at FROM reservation_items ri
     JOIN reservations r ON r.id = ri.reservation_id JOIN users u ON u.id = r.user_id
     WHERE ri.asset_id = :id AND ${ACTIVE_RESERVATION_SQL} ORDER BY r.start_at`,
    { id, now, pickupCutoff },
  ).map((r) => ({
    id: r.id, start_at: r.start_at, end_at: r.end_at, mine: r.user_id === viewer.id,
    user: admin || r.user_id === viewer.id ? { id: r.user_id, name: r.user_name } : null,
  }));

  const history = admin
    ? db.all(
      `SELECT e.id, e.type, e.message, e.photo, e.loan_id, e.created_at, u.name AS actor
       FROM asset_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.asset_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
      [id],
    ).map((e) => ({ ...e, photo_url: fileUrl(e.photo), photo: undefined }))
    : null;

  const stats = admin
    ? db.get(
      `SELECT COUNT(*) AS loans,
         SUM(CASE WHEN condition_in = 'damaged' THEN 1 ELSE 0 END) AS damaged_returns
       FROM loan_items WHERE asset_id = ?`,
      [id],
    )
    : null;

  return {
    asset,
    parent: parent ? serializeAsset(parent, sc, { categories }) : null,
    children: serializeAssets(ctx, viewer, children, sc),
    attached_tree: descendants(db, id).map((d) => ({ id: d.id, tag: d.tag, name: d.name, parent_id: d.parent_id })),
    kit,
    compatible,
    reservations,
    history,
    stats,
  };
}

// ---------------------------------------------------------------------------
// CSV import: tag,name,category,brand,model,serial_number,value,location,compat,parent_tag,kit_tag,requires_signature,description

export function importAssets(ctx, actor, csvText) {
  const { db } = ctx;
  const rows = parseCsvObjects(csvText);
  if (rows.length === 0) throw badRequest('The CSV file is empty. The first row must be a header.');
  if (rows.length > 2000) throw badRequest('Please import at most 2,000 rows at a time');
  const created = [];
  const errors = [];
  const pendingLinks = [];
  db.transaction(() => {
    for (const row of rows) {
      try {
        db.transaction(() => {
          let kitId = null;
          if (row.kit_tag) {
            const kit = db.get('SELECT id FROM kits WHERE tag = ?', [row.kit_tag]);
            if (kit) kitId = kit.id;
            else {
              assertTagFree(db, row.kit_tag);
              kitId = db.run('INSERT INTO kits (tag, name, created_at) VALUES (?, ?, ?)', [row.kit_tag, row.kit_name || row.kit_tag, ctx.now().toISOString()]).id;
            }
          }
          const id = createAsset(ctx, actor, {
            tag: row.tag, name: row.name, category: row.category || 'Other', brand: row.brand, model: row.model,
            serial_number: row.serial_number || row.serial, value: row.value || row.value_usd, location: row.location,
            description: row.description, notes: row.notes, requires_signature: bool(row.requires_signature),
            compat: (row.compat || row.compatibility || '').split(/[;|]/), kit_id: kitId,
          });
          created.push(id);
          if (row.parent_tag) pendingLinks.push({ id, parentTag: row.parent_tag, line: row._line });
        });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        errors.push({ line: row._line, tag: row.tag, error: err.message });
      }
    }
    // Parents may appear later in the file, so link after every row exists.
    for (const link of pendingLinks) {
      try {
        attachAsset(ctx, actor, link.id, { parent_tag: link.parentTag });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        errors.push({ line: link.line, error: `Could not attach to ${link.parentTag}: ${err.message}` });
      }
    }
  });
  return { created: created.length, errors };
}
