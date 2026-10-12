import { isAdmin } from '../auth.js';
import { addDays, badRequest, conflict, forbidden, isoDate, notFound, str } from '../util.js';
import { ACTIVE_RESERVATION_SQL, STATE_LABELS, descendants, reservationWindowParams, serializeAssets, statusContext } from './inventory.js';
import { restrictionFor } from './restrictions.js';

/**
 * Turns scanned/selected entries into the list of physical assets involved.
 * A kit expands to its items; any asset brings along the accessories
 * attached to it (e.g. the lens mounted on a camera body).
 *
 * Each line records how it got there:
 *   source "scan"     – picked explicitly
 *          "kit"      – part of a scanned kit
 *          "attached" – attached to another line's asset
 */
export function expandEntries(ctx, entries) {
  const { db } = ctx;
  if (!Array.isArray(entries)) throw badRequest('Items must be a list');
  if (entries.length > 200) throw badRequest('Too many items at once');
  const lines = [];
  const seen = new Map();

  const add = (asset, source, kit, parent) => {
    const existing = seen.get(asset.id);
    if (existing) {
      // An explicit scan wins over an implicit inclusion.
      if (source === 'scan' && existing.source !== 'scan') existing.source = 'scan';
      return;
    }
    const line = { asset, source, kit, parent };
    seen.set(asset.id, line);
    lines.push(line);
    for (const child of descendants(db, asset.id)) {
      if (seen.has(child.id)) continue;
      const parentRow = child.parent_id === asset.id ? asset : db.get('SELECT * FROM assets WHERE id = ?', [child.parent_id]);
      const childLine = { asset: child, source: 'attached', kit, parent: parentRow };
      seen.set(child.id, childLine);
      lines.push(childLine);
    }
  };

  for (const entry of entries) {
    const id = Number(entry?.id);
    if (!Number.isInteger(id)) throw badRequest('Each item needs an id');
    if (entry.type === 'kit') {
      const kit = db.get('SELECT * FROM kits WHERE id = ?', [id]);
      if (!kit) throw notFound('Kit not found');
      const items = db.all(
        `SELECT a.* FROM assets a LEFT JOIN categories c ON c.name = a.category
         WHERE a.kit_id = ? ORDER BY COALESCE(c.sort, 999), a.tag`,
        [kit.id],
      );
      if (items.length === 0) throw badRequest(`Kit ${kit.tag} has no items`);
      for (const asset of items) add(asset, 'kit', kit, null);
    } else if (entry.type === 'asset') {
      const asset = db.get('SELECT * FROM assets WHERE id = ?', [id]);
      if (!asset) throw notFound('Item not found');
      add(asset, 'scan', null, null);
    } else {
      throw badRequest('Item type must be "asset" or "kit"');
    }
  }
  return lines;
}

/**
 * Returns a Map assetId -> reason for every asset that cannot be used in the
 * window [start, end]. Bookings held by `forUserId` (and the booking being
 * edited) don't count as conflicts.
 */
export function windowConflicts(ctx, assetIds, start, end, { forUserId = null, ignoreReservationId = null, ignoreLoans = false } = {}) {
  const { db } = ctx;
  const conflicts = new Map();
  if (assetIds.length === 0) return conflicts;
  const { now, pickupCutoff } = reservationWindowParams(ctx);
  const placeholders = assetIds.map(() => '?').join(',');

  const assets = db.all(`SELECT id, state FROM assets WHERE id IN (${placeholders})`, assetIds);
  for (const a of assets) {
    if (a.state !== 'active') conflicts.set(a.id, { code: 'state', message: STATE_LABELS[a.state] });
  }

  if (!ignoreLoans) {
    const loans = db.all(
      `SELECT li.asset_id, l.due_at, l.borrower_id FROM loan_items li JOIN loans l ON l.id = li.loan_id
       WHERE li.outcome IS NULL AND li.asset_id IN (${placeholders})`,
      assetIds,
    );
    for (const l of loans) {
      // Checked-out gear blocks the window if it's due back after the window
      // starts, or if it's already overdue (we don't know when it'll be back).
      if (l.due_at > start || l.due_at < now) {
        if (!conflicts.has(l.asset_id)) conflicts.set(l.asset_id, { code: 'checked_out', message: 'Checked out', due_at: l.due_at });
      }
    }
  }

  const reservations = db.all(
    `SELECT ri.asset_id, r.id, r.user_id, r.start_at, r.end_at FROM reservation_items ri
     JOIN reservations r ON r.id = ri.reservation_id
     WHERE ${ACTIVE_RESERVATION_SQL} AND r.start_at < :end AND r.end_at > :start
       AND ri.asset_id IN (${assetIds.map((_, i) => `:a${i}`).join(',')})`,
    { now, pickupCutoff, start, end, ...Object.fromEntries(assetIds.map((id, i) => [`a${i}`, id])) },
  );
  for (const r of reservations) {
    if (r.id === ignoreReservationId || (forUserId && r.user_id === forUserId)) continue;
    if (!conflicts.has(r.asset_id)) {
      conflicts.set(r.asset_id, { code: 'reserved', message: 'Booked by someone else', start_at: r.start_at, end_at: r.end_at, reservation_id: r.id });
    }
  }
  return conflicts;
}

/** Active bookings held by `userId` that overlap the window, keyed by asset. */
export function ownReservations(ctx, userId, assetIds, start, end) {
  const out = new Map();
  if (assetIds.length === 0) return out;
  const { now, pickupCutoff } = reservationWindowParams(ctx);
  const rows = ctx.db.all(
    `SELECT ri.asset_id, r.id FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id
     WHERE ${ACTIVE_RESERVATION_SQL} AND r.user_id = :userId AND r.start_at < :end AND r.end_at > :start
       AND ri.asset_id IN (${assetIds.map((_, i) => `:a${i}`).join(',')})`,
    { now, pickupCutoff, userId, start, end, ...Object.fromEntries(assetIds.map((id, i) => [`a${i}`, id])) },
  );
  for (const r of rows) if (!out.has(r.asset_id)) out.set(r.asset_id, r.id);
  return out;
}

export function reservationDetail(ctx, viewer, reservationId, sc = statusContext(ctx, viewer)) {
  const { db } = ctx;
  const r = db.get(
    `SELECT r.*, u.name AS user_name, u.student_id, c.name AS created_by_name
     FROM reservations r JOIN users u ON u.id = r.user_id LEFT JOIN users c ON c.id = r.created_by
     WHERE r.id = ?`,
    [reservationId],
  );
  if (!r) return null;
  const rows = db.all(
    `SELECT a.*, ri.kit_id AS reserved_kit_id, k.tag AS kit_tag, k.name AS kit_name
     FROM reservation_items ri JOIN assets a ON a.id = ri.asset_id LEFT JOIN kits k ON k.id = ri.kit_id
     WHERE ri.reservation_id = ? ORDER BY k.tag, a.tag`,
    [reservationId],
  );
  const assets = serializeAssets(ctx, viewer, rows, sc);
  const { now, pickupCutoff } = reservationWindowParams(ctx);
  let state = r.status;
  if (r.status === 'booked' && (r.end_at <= now || r.start_at <= pickupCutoff)) state = 'expired';
  else if (r.status === 'booked' && r.start_at <= now) state = 'ready';
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name, student_id: r.student_id },
    created_by: r.created_by_name,
    start_at: r.start_at,
    end_at: r.end_at,
    status: r.status,
    state, // booked | ready (pickup window open) | fulfilled | cancelled | expired
    note: r.note,
    created_at: r.created_at,
    items: assets.map((a, i) => ({
      ...a,
      kit: rows[i].reserved_kit_id ? { id: rows[i].reserved_kit_id, tag: rows[i].kit_tag, name: rows[i].kit_name } : null,
    })),
  };
}

export function createReservation(ctx, actor, input) {
  const { db } = ctx;
  const s = ctx.settings();
  const admin = isAdmin(actor);
  const now = ctx.now().toISOString();

  if (!admin && !s.allow_student_reservations) throw forbidden('Booking is turned off. Please see a teacher.');
  const userId = admin && input.user_id ? Number(input.user_id) : actor.id;
  if (!admin && input.user_id && Number(input.user_id) !== actor.id) throw forbidden('You can only book gear for yourself');
  const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', [userId]);
  if (!user) throw notFound('Student not found');

  const start = isoDate(input.start_at, 'Start');
  const end = isoDate(input.end_at, 'End');
  if (end <= start) throw badRequest('The booking must end after it starts');
  if (end <= now) throw badRequest('The booking must end in the future');
  if (!admin && end > addDays(start, s.max_reservation_days)) {
    throw badRequest(`Bookings can be at most ${s.max_reservation_days} day${s.max_reservation_days === 1 ? '' : 's'} long`);
  }
  const note = str(input.note, 'Note', { max: 500 });

  const restriction = restrictionFor(ctx, userId);
  const overrideReason = admin ? str(input.override_reason, 'Override reason', { max: 300 }) : null;
  if (restriction.restricted && !overrideReason) {
    throw forbidden(`${admin ? `${user.name} is` : 'You are'} restricted from booking new gear: ${restriction.reasons.map((r) => r.message).join('; ')}`);
  }

  const lines = expandEntries(ctx, input.entries ?? []);
  if (lines.length === 0) throw badRequest('Pick at least one item to book');
  const conflicts = windowConflicts(ctx, lines.map((l) => l.asset.id), start, end, { forUserId: userId });
  const problems = lines
    .filter((l) => conflicts.has(l.asset.id))
    .map((l) => ({ asset_id: l.asset.id, tag: l.asset.tag, name: l.asset.name, ...conflicts.get(l.asset.id) }));
  if (problems.length) {
    throw conflict(`Not available for those dates: ${problems.map((p) => `${p.tag} (${p.message.toLowerCase()})`).join(', ')}`, { problems });
  }

  const id = db.transaction(() => {
    const { id: reservationId } = db.run(
      `INSERT INTO reservations (user_id, created_by, start_at, end_at, status, note, created_at)
       VALUES (?, ?, ?, ?, 'booked', ?, ?)`,
      [userId, actor.id, start, end, [note, overrideReason && `Override: ${overrideReason}`].filter(Boolean).join(' — ') || null, now],
    );
    for (const line of lines) {
      db.run('INSERT INTO reservation_items (reservation_id, asset_id, kit_id) VALUES (?, ?, ?)', [reservationId, line.asset.id, line.kit?.id ?? null]);
    }
    return reservationId;
  });
  return reservationDetail(ctx, actor, id);
}

export function cancelReservation(ctx, actor, reservationId) {
  const r = ctx.db.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
  if (!r) throw notFound('Booking not found');
  if (!isAdmin(actor) && r.user_id !== actor.id) throw forbidden();
  if (r.status !== 'booked') throw conflict(`This booking is already ${r.status}`);
  ctx.db.run("UPDATE reservations SET status = 'cancelled' WHERE id = ?", [reservationId]);
  return reservationDetail(ctx, actor, reservationId);
}
