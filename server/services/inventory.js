import { isAdmin } from '../auth.js';
import { addHours, badRequest, conflict, fileUrl } from '../util.js';

export const STATE_LABELS = { active: 'Active', repair: 'In repair', lost: 'Lost', retired: 'Retired' };
export const CONDITIONS = ['excellent', 'fair', 'damaged'];

// A booking holds its items while it is "booked", has not ended, and was
// picked up (or is still within the pickup window after it started).
export const ACTIVE_RESERVATION_SQL = `r.status = 'booked' AND r.end_at > :now AND r.start_at > :pickupCutoff`;

export function reservationWindowParams(ctx) {
  const now = ctx.now().toISOString();
  return { now, pickupCutoff: addHours(now, -ctx.settings().reservation_pickup_hours) };
}

export function logEvent(db, { assetId, type, actorId = null, loanId = null, message, photo = null, at }) {
  db.run(
    `INSERT INTO asset_events (asset_id, type, actor_id, loan_id, message, photo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [assetId, type, actorId, loanId, message, photo, at],
  );
}

export function categoryMap(db) {
  const map = new Map();
  for (const c of db.all('SELECT * FROM categories ORDER BY sort, name')) map.set(c.name.toLowerCase(), c);
  return map;
}

export function categoryKind(categories, name) {
  return categories.get(String(name).toLowerCase())?.kind ?? 'accessory';
}

export function compatTagsFor(db, assetIds) {
  const map = new Map();
  if (assetIds && assetIds.length === 0) return map;
  const rows = assetIds
    ? db.all(`SELECT asset_id, tag FROM asset_compat WHERE asset_id IN (${assetIds.map(() => '?').join(',')}) ORDER BY tag`, assetIds)
    : db.all('SELECT asset_id, tag FROM asset_compat ORDER BY tag');
  for (const r of rows) {
    if (!map.has(r.asset_id)) map.set(r.asset_id, []);
    map.get(r.asset_id).push(r.tag);
  }
  return map;
}

/** Normalises "Mount : EF " into "mount:EF"; returns null for blanks. */
export function normalizeCompatTag(tag) {
  const s = String(tag ?? '').trim().replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length > 60) throw badRequest('Compatibility tags must be 60 characters or fewer');
  return s;
}

export function setCompatTags(db, assetId, tags) {
  if (!Array.isArray(tags)) throw badRequest('Compatibility tags must be a list');
  const unique = new Map();
  for (const t of tags) {
    const n = normalizeCompatTag(t);
    if (n) unique.set(n.toLowerCase(), n);
  }
  db.run('DELETE FROM asset_compat WHERE asset_id = ?', [assetId]);
  for (const tag of unique.values()) db.run('INSERT INTO asset_compat (asset_id, tag) VALUES (?, ?)', [assetId, tag]);
}

/** Barcodes must be unique across assets and kits so a scan is never ambiguous. */
export function assertTagFree(db, tag, { assetId = null, kitId = null } = {}) {
  const asset = db.get('SELECT id FROM assets WHERE tag = ?', [tag]);
  if (asset && asset.id !== assetId) throw conflict(`Tag ${tag} is already used by another item`);
  const kit = db.get('SELECT id FROM kits WHERE tag = ?', [tag]);
  if (kit && kit.id !== kitId) throw conflict(`Tag ${tag} is already used by a kit`);
}

/** All assets attached below `assetId` (children, grandchildren...). */
export function descendants(db, assetId) {
  return db.all(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 1 FROM assets WHERE parent_id = ?
       UNION ALL
       SELECT a.id, tree.depth + 1 FROM assets a JOIN tree ON a.parent_id = tree.id WHERE tree.depth < 20
     )
     SELECT a.* FROM tree JOIN assets a ON a.id = tree.id ORDER BY tree.depth, a.tag`,
    [assetId],
  );
}

export function ancestors(db, assetId) {
  const chain = [];
  let current = db.get('SELECT * FROM assets WHERE id = ?', [assetId]);
  const seen = new Set();
  while (current?.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    current = db.get('SELECT * FROM assets WHERE id = ?', [current.parent_id]);
    if (current) chain.push(current);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Availability status (the colour-coded badge on every card).

export function statusContext(ctx, viewer) {
  const { db } = ctx;
  const { now, pickupCutoff } = reservationWindowParams(ctx);
  const horizon = addHours(now, ctx.settings().reserved_badge_hours);

  const loans = new Map();
  for (const row of db.all(
    `SELECT li.asset_id, li.id AS loan_item_id, l.id AS loan_id, l.due_at, l.borrower_id, u.name AS borrower_name
     FROM loan_items li JOIN loans l ON l.id = li.loan_id JOIN users u ON u.id = l.borrower_id
     WHERE li.outcome IS NULL`,
  )) loans.set(row.asset_id, row);

  const reservations = new Map();
  for (const row of db.all(
    `SELECT ri.asset_id, r.id AS reservation_id, r.user_id, r.start_at, r.end_at, u.name AS user_name
     FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id JOIN users u ON u.id = r.user_id
     WHERE ${ACTIVE_RESERVATION_SQL} AND r.start_at <= :horizon
     ORDER BY r.start_at`,
    { now, pickupCutoff, horizon },
  )) {
    if (!reservations.has(row.asset_id)) reservations.set(row.asset_id, row);
  }

  return { now, loans, reservations, viewer, admin: isAdmin(viewer) };
}

export function assetStatus(asset, sc) {
  if (asset.state !== 'active') {
    return { code: 'unavailable', label: STATE_LABELS[asset.state] };
  }
  const loan = sc.loans.get(asset.id);
  if (loan) {
    const mine = sc.viewer?.id === loan.borrower_id;
    const overdue = loan.due_at < sc.now;
    const status = { code: 'checked_out', label: overdue ? 'Overdue' : 'Checked out', overdue, due_at: loan.due_at, mine };
    if (sc.admin || mine) {
      status.loan_id = loan.loan_id;
      status.loan_item_id = loan.loan_item_id;
      status.borrower = { id: loan.borrower_id, name: loan.borrower_name };
    }
    return status;
  }
  const res = sc.reservations.get(asset.id);
  if (res) {
    const mine = sc.viewer?.id === res.user_id;
    const status = { code: 'reserved', label: mine ? 'Reserved for you' : 'Reserved', start_at: res.start_at, end_at: res.end_at, mine };
    if (sc.admin || mine) {
      status.reservation_id = res.reservation_id;
      status.reserved_by = { id: res.user_id, name: res.user_name };
    }
    return status;
  }
  return { code: 'available', label: 'Available' };
}

export function serializeAsset(asset, sc, { compat, categories } = {}) {
  const out = {
    id: asset.id,
    tag: asset.tag,
    name: asset.name,
    category: asset.category,
    category_kind: categories ? categoryKind(categories, asset.category) : undefined,
    icon: categories?.get(String(asset.category).toLowerCase())?.icon ?? 'box',
    brand: asset.brand,
    model: asset.model,
    photo_url: fileUrl(asset.photo),
    value_cents: asset.value_cents,
    requires_signature: !!asset.requires_signature,
    location: asset.location,
    condition: asset.condition,
    state: asset.state,
    parent_id: asset.parent_id,
    kit_id: asset.kit_id,
    status: assetStatus(asset, sc),
  };
  if (compat) out.compat = compat.get(asset.id) ?? [];
  return out;
}

/** Serialises many rows at once, sharing one status snapshot. */
export function serializeAssets(ctx, viewer, rows, sc = statusContext(ctx, viewer)) {
  const categories = categoryMap(ctx.db);
  const compat = compatTagsFor(ctx.db, rows.map((r) => r.id));
  return rows.map((row) => serializeAsset(row, sc, { compat, categories }));
}

export function kitStatus(items) {
  if (items.length === 0) return { code: 'unavailable', label: 'Empty kit' };
  const out = items.filter((i) => i.status.code === 'checked_out').length;
  if (out > 0) {
    const overdue = items.some((i) => i.status.overdue);
    return { code: 'checked_out', label: out === items.length ? (overdue ? 'Overdue' : 'Checked out') : `${out} of ${items.length} out`, overdue };
  }
  if (items.some((i) => i.status.code === 'reserved')) {
    const r = items.find((i) => i.status.code === 'reserved').status;
    return { code: 'reserved', label: r.mine ? 'Reserved for you' : 'Reserved', start_at: r.start_at, end_at: r.end_at, mine: r.mine };
  }
  const missing = items.filter((i) => i.status.code === 'unavailable').length;
  if (missing === items.length) return { code: 'unavailable', label: 'Unavailable' };
  if (missing > 0) return { code: 'available', label: `Available (${missing} item${missing === 1 ? '' : 's'} missing)`, incomplete: missing };
  return { code: 'available', label: 'Available' };
}

export function kitWithItems(ctx, viewer, kit, sc = statusContext(ctx, viewer)) {
  const rows = ctx.db.all(
    `SELECT a.* FROM assets a LEFT JOIN categories c ON c.name = a.category
     WHERE a.kit_id = ? ORDER BY COALESCE(c.sort, 999), a.tag`,
    [kit.id],
  );
  const items = serializeAssets(ctx, viewer, rows, sc);
  return {
    id: kit.id,
    tag: kit.tag,
    name: kit.name,
    description: kit.description,
    item_count: items.length,
    total_value_cents: items.reduce((sum, i) => sum + i.value_cents, 0),
    status: kitStatus(items),
    items,
  };
}

// ---------------------------------------------------------------------------
// Compatible accessory matching.

/** Map of lower-cased tag -> tag as entered, for case-insensitive matching. */
function tagSet(tags) {
  return new Map((tags ?? []).map((t) => [t.toLowerCase(), t]));
}

/**
 * Finds assets that work with `asset`:
 *  - share at least one compatibility tag (e.g. "mount:EF"), or
 *  - are tagged "universal" (only suggested for main items such as cameras).
 * For a main item only accessories are suggested; for an accessory we list
 * everything else it shares a tag with (bodies, chargers...).
 */
export function compatibleAssets(ctx, asset, { includeInactive = false } = {}) {
  const { db } = ctx;
  const categories = categoryMap(db);
  const compat = compatTagsFor(db);
  const sourceTags = tagSet(compat.get(asset.id));
  const sourceKind = categoryKind(categories, asset.category);
  const rows = db.all(
    `SELECT * FROM assets WHERE id != ? AND category != ? ${includeInactive ? '' : "AND state NOT IN ('retired', 'lost')"}`,
    [asset.id, asset.category],
  );
  const matches = [];
  for (const row of rows) {
    const kind = categoryKind(categories, row.category);
    if (sourceKind === 'main' && kind === 'main') continue;
    const tags = tagSet(compat.get(row.id));
    const shared = [...tags.keys()].filter((t) => t !== 'universal' && sourceTags.has(t)).map((t) => sourceTags.get(t));
    const universal = sourceKind === 'main' && tags.has('universal');
    if (shared.length || universal) {
      matches.push({ row, reason: shared.length ? shared : ['universal'] });
    }
  }
  // Specific matches (a lens for this mount) before universal ones (tripods),
  // then in category order, usable items first.
  const sortOf = (row) => categories.get(row.category.toLowerCase())?.sort ?? 999;
  matches.sort((a, b) => (a.reason[0] === 'universal') - (b.reason[0] === 'universal')
    || sortOf(a.row) - sortOf(b.row)
    || (a.row.state !== 'active') - (b.row.state !== 'active')
    || a.row.name.localeCompare(b.row.name)
    || a.row.tag.localeCompare(b.row.tag));
  return matches;
}
