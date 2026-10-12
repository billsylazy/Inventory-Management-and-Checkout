import fs from 'node:fs';
import path from 'node:path';
import { isAdmin } from '../auth.js';
import {
  addDays, addHours, badRequest, conflict, fileUrl, forbidden, formatMoney, int, isoDate, notFound, oneOf, saveImage, str,
} from '../util.js';
import {
  CONDITIONS, STATE_LABELS, categoryKind, categoryMap, compatibleAssets, logEvent, serializeAssets, statusContext,
} from './inventory.js';
import { restrictionFor } from './restrictions.js';
import { expandEntries, ownReservations, windowConflicts } from './reservations.js';

const SIGNER_ROLES = ['student', 'parent', 'teacher'];
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function signatureNeeded(asset, settings) {
  if (asset.requires_signature) return true;
  return settings.signature_threshold_cents > 0 && asset.value_cents >= settings.signature_threshold_cents;
}

function borrowerSummary(user) {
  return { id: user.id, name: user.name, username: user.username, student_id: user.student_id, role: user.role };
}

// ---------------------------------------------------------------------------
// Check-out

/**
 * Validates a prospective check-out without changing anything. The UI calls
 * this after every scan to show the cart, problems, compatible accessories
 * and whether a signature is needed.
 */
export function planCheckout(ctx, actor, input) {
  const { db } = ctx;
  const s = ctx.settings();
  const admin = isAdmin(actor);
  const now = ctx.now().toISOString();
  const errors = [];

  if (!admin && !s.allow_student_self_checkout) throw forbidden('Self check-out is turned off. Please see a teacher.');
  let borrowerId = actor.id;
  if (admin) borrowerId = int(input.borrower_id, 'Borrower', { required: true, min: 1 });
  else if (input.borrower_id && Number(input.borrower_id) !== actor.id) throw forbidden('You can only check out gear for yourself');
  const borrower = db.get('SELECT * FROM users WHERE id = ? AND active = 1', [borrowerId]);
  if (!borrower) throw notFound('Borrower not found');

  const dueAt = input.due_at ? isoDate(input.due_at, 'Due date') : addDays(now, s.loan_days_default);
  if (dueAt <= now) errors.push({ code: 'due_past', message: 'The due date must be in the future' });
  // A little slack so "7 days from now" picked in the browser isn't rejected.
  if (!admin && dueAt > addHours(addDays(now, s.max_loan_days), 1)) {
    errors.push({ code: 'due_too_far', message: `Loans can be at most ${s.max_loan_days} day${s.max_loan_days === 1 ? '' : 's'}` });
  }

  const restriction = restrictionFor(ctx, borrower.id);
  const overrideReason = admin ? str(input.override_reason, 'Override reason', { max: 300 }) : null;
  if (restriction.restricted && !overrideReason) {
    errors.push({
      code: 'restricted',
      message: `${borrower.id === actor.id ? 'You are' : `${borrower.name} is`} restricted from checking out new gear`,
    });
  }

  const lines = expandEntries(ctx, input.entries ?? []);
  const assetIds = lines.map((l) => l.asset.id);
  const conflicts = windowConflicts(ctx, assetIds, now, dueAt > now ? dueAt : addHours(now, 1), { forUserId: borrower.id, ignoreLoans: true });
  const fulfils = ownReservations(ctx, borrower.id, assetIds, now, dueAt > now ? dueAt : addHours(now, 1));
  const openLoans = new Map(
    assetIds.length
      ? db.all(
        `SELECT li.asset_id, l.borrower_id, l.due_at FROM loan_items li JOIN loans l ON l.id = li.loan_id
         WHERE li.outcome IS NULL AND li.asset_id IN (${assetIds.map(() => '?').join(',')})`,
        assetIds,
      ).map((r) => [r.asset_id, r])
      : [],
  );

  const sc = statusContext(ctx, actor);
  const serialized = serializeAssets(ctx, actor, lines.map((l) => l.asset), sc);
  const outLines = lines.map((line, i) => {
    const { asset } = line;
    const issues = [];
    let include = true;
    const explicit = line.source === 'scan';
    // Something you scanned on purpose blocks the check-out if it can't go;
    // kit members and attached accessories are simply left behind.
    const unavailable = (message) => {
      if (explicit) issues.push({ level: 'error', message });
      else {
        issues.push({ level: 'warning', message: `${message} — will be left out` });
        include = false;
      }
    };

    const loan = openLoans.get(asset.id);
    if (asset.state !== 'active') unavailable(STATE_LABELS[asset.state]);
    else if (loan) unavailable(loan.borrower_id === borrower.id ? 'Already checked out to this borrower' : 'Checked out to someone else');
    else if (conflicts.has(asset.id)) {
      const c = conflicts.get(asset.id);
      if (overrideReason) issues.push({ level: 'warning', message: `${c.message} (overridden)` });
      else unavailable(`${c.message} for part of this loan`);
    }
    if (include && fulfils.has(asset.id)) issues.push({ level: 'info', message: 'Picks up your booking' });
    if (include && asset.condition === 'damaged') issues.push({ level: 'warning', message: 'Last returned as damaged' });

    return {
      asset: serialized[i],
      source: line.source,
      kit: line.kit ? { id: line.kit.id, tag: line.kit.tag, name: line.kit.name } : null,
      parent: line.parent ? { id: line.parent.id, tag: line.parent.tag, name: line.parent.name } : null,
      include,
      signature_required: signatureNeeded(asset, s),
      issues,
    };
  });

  const included = outLines.filter((l) => l.include);
  if (outLines.length > 0 && included.length === 0) errors.push({ code: 'empty', message: 'None of these items can be checked out' });
  const blocked = outLines.some((l) => l.issues.some((i) => i.level === 'error'));

  // Compatible accessory suggestions for main items (camera bodies etc.).
  const categories = categoryMap(db);
  const inCart = new Set(assetIds);
  const suggestions = [];
  for (const line of included) {
    if (categoryKind(categories, line.asset.category) !== 'main') continue;
    const matches = compatibleAssets(ctx, line.asset).filter((m) => !inCart.has(m.row.id) && m.row.state === 'active');
    if (!matches.length) continue;
    const blockedIds = windowConflicts(ctx, matches.map((m) => m.row.id), now, dueAt > now ? dueAt : addHours(now, 1), { forUserId: borrower.id });
    const available = matches.filter((m) => !blockedIds.has(m.row.id)).slice(0, 24);
    if (!available.length) continue;
    const assets = serializeAssets(ctx, actor, available.map((m) => m.row), sc);
    suggestions.push({
      for: { id: line.asset.id, tag: line.asset.tag, name: line.asset.name },
      items: assets.map((a, i) => ({ ...a, match: available[i].reason })),
    });
  }

  const signatureItems = included.filter((l) => l.signature_required);
  return {
    borrower: borrowerSummary(borrower),
    restriction,
    override_reason: overrideReason,
    due_at: dueAt,
    lines: outLines,
    item_count: included.length,
    total_value_cents: included.reduce((sum, l) => sum + l.asset.value_cents, 0),
    signature_required: signatureItems.length > 0,
    signature_items: signatureItems.map((l) => ({ tag: l.asset.tag, name: l.asset.name, value_cents: l.asset.value_cents })),
    reservations: [...new Set(included.map((l) => fulfils.get(l.asset.id)).filter(Boolean))],
    suggestions,
    errors,
    can_checkout: errors.length === 0 && !blocked && included.length > 0,
  };
}

export function commitCheckout(ctx, actor, input) {
  const { db } = ctx;
  const plan = planCheckout(ctx, actor, input);
  if (!plan.can_checkout) {
    const reasons = [...plan.errors.map((e) => e.message), ...plan.lines.flatMap((l) => l.issues.filter((i) => i.level === 'error').map((i) => `${l.asset.tag}: ${i.message}`))];
    throw conflict(reasons.length ? reasons.join('. ') : 'Nothing to check out', { plan });
  }
  const notes = str(input.notes, 'Notes', { max: 1000 });

  let signature = null;
  if (plan.signature_required) {
    const sig = input.signature;
    if (!sig || !sig.image) throw badRequest('A signature is required before high-value gear leaves the room', { plan });
    signature = {
      signer_name: str(sig.signer_name, 'Signer name', { required: true, max: 100 }),
      signer_role: oneOf(sig.signer_role, 'Signer role', SIGNER_ROLES),
      image: saveImage(ctx.uploadsDir, 'signatures', sig.image, { field: 'Signature', types: ['image/png'], maxBytes: 1024 * 1024 }),
    };
  }

  const now = ctx.now().toISOString();
  const borrower = plan.borrower;
  try {
    const loanId = db.transaction(() => {
      const { id } = db.run(
        `INSERT INTO loans (borrower_id, issued_by, reservation_id, checked_out_at, due_at, override_reason, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [borrower.id, actor.id, plan.reservations[0] ?? null, now, plan.due_at, plan.override_reason, notes],
      );
      for (const line of plan.lines.filter((l) => l.include)) {
        db.run(
          'INSERT INTO loan_items (loan_id, asset_id, kit_id, condition_out) VALUES (?, ?, ?, ?)',
          [id, line.asset.id, line.kit?.id ?? null, line.asset.condition],
        );
        let message = `Checked out to ${borrower.name}`;
        if (line.kit) message += ` with kit ${line.kit.tag}`;
        if (line.source === 'attached' && line.parent) message += ` (attached to ${line.parent.tag})`;
        logEvent(db, { assetId: line.asset.id, type: 'checked_out', actorId: actor.id, loanId: id, message, at: now });
      }
      if (signature) {
        db.run(
          'INSERT INTO signatures (loan_id, signer_name, signer_role, image, signed_at) VALUES (?, ?, ?, ?, ?)',
          [id, signature.signer_name, signature.signer_role, signature.image, now],
        );
      }
      for (const reservationId of plan.reservations) {
        db.run("UPDATE reservations SET status = 'fulfilled' WHERE id = ? AND status = 'booked'", [reservationId]);
      }
      return id;
    });
    return loanDetail(ctx, actor, loanId);
  } catch (err) {
    if (signature) fs.rmSync(path.join(ctx.uploadsDir, signature.image), { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Loans

export function loanDetail(ctx, viewer, loanId, sc = statusContext(ctx, viewer)) {
  const { db } = ctx;
  const loan = db.get(
    `SELECT l.*, b.name AS borrower_name, b.username AS borrower_username, b.student_id, i.name AS issued_by_name
     FROM loans l JOIN users b ON b.id = l.borrower_id LEFT JOIN users i ON i.id = l.issued_by
     WHERE l.id = ?`,
    [loanId],
  );
  if (!loan) return null;
  const admin = isAdmin(viewer);
  const rows = db.all(
    `SELECT li.*, k.tag AS kit_tag, k.name AS kit_name, c.name AS closed_by_name
     FROM loan_items li LEFT JOIN kits k ON k.id = li.kit_id LEFT JOIN users c ON c.id = li.closed_by
     WHERE li.loan_id = ? ORDER BY li.id`,
    [loanId],
  );
  const assets = db.all(
    `SELECT a.* FROM loan_items li JOIN assets a ON a.id = li.asset_id WHERE li.loan_id = ? ORDER BY li.id`,
    [loanId],
  );
  const serialized = serializeAssets(ctx, viewer, assets, sc);
  const now = ctx.now().toISOString();
  const open = rows.filter((r) => !r.outcome).length;
  const signatures = db.all('SELECT * FROM signatures WHERE loan_id = ? ORDER BY id', [loanId]).map((sig) => ({
    id: sig.id,
    signer_name: sig.signer_name,
    signer_role: sig.signer_role,
    signed_at: sig.signed_at,
    image_url: admin ? fileUrl(sig.image) : null,
  }));
  return {
    id: loan.id,
    borrower: { id: loan.borrower_id, name: loan.borrower_name, username: loan.borrower_username, student_id: loan.student_id },
    issued_by: loan.issued_by_name,
    checked_out_at: loan.checked_out_at,
    due_at: loan.due_at,
    closed_at: loan.closed_at,
    overdue: open > 0 && loan.due_at < now,
    open_count: open,
    override_reason: admin ? loan.override_reason : null,
    notes: loan.notes,
    items: rows.map((r, i) => ({
      id: r.id,
      asset: serialized[i],
      kit: r.kit_id ? { id: r.kit_id, tag: r.kit_tag, name: r.kit_name } : null,
      condition_out: r.condition_out,
      outcome: r.outcome,
      closed_at: r.closed_at,
      closed_by: r.closed_by_name,
      condition_in: r.condition_in,
      return_notes: r.return_notes,
      return_photo_url: admin ? fileUrl(r.return_photo) : null,
      confirmation: r.confirmation,
    })),
    signatures,
  };
}

export function listLoans(ctx, viewer, { scope = 'open', userId = null, limit = 200 } = {}) {
  const admin = isAdmin(viewer);
  const where = [];
  const params = [];
  if (!admin) {
    where.push('l.borrower_id = ?');
    params.push(viewer.id);
  } else if (userId) {
    where.push('l.borrower_id = ?');
    params.push(userId);
  }
  if (scope === 'open') where.push('l.closed_at IS NULL');
  else if (scope === 'overdue') {
    where.push('l.closed_at IS NULL AND l.due_at < ?');
    params.push(ctx.now().toISOString());
  } else if (scope === 'closed') where.push('l.closed_at IS NOT NULL');
  const ids = ctx.db.all(
    `SELECT l.id FROM loans l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY (l.closed_at IS NULL) DESC, CASE WHEN l.closed_at IS NULL THEN l.due_at END ASC, l.checked_out_at DESC LIMIT ?`,
    [...params, limit],
  );
  const sc = statusContext(ctx, viewer);
  return ids.map(({ id }) => loanDetail(ctx, viewer, id, sc));
}

// ---------------------------------------------------------------------------
// Returns

/**
 * Finds the open loans a scanned code belongs to. Scanning a kit or a student
 * ID loads the loan(s) but never confirms items by itself — every item has
 * to be confirmed individually.
 */
export function lookupForReturn(ctx, viewer, code) {
  const { db } = ctx;
  const admin = isAdmin(viewer);
  const value = str(code, 'Code', { required: true, max: 64 });
  let loanIds = [];
  let matched;

  const asset = db.get('SELECT * FROM assets WHERE tag = ?', [value]);
  const kit = asset ? null : db.get('SELECT * FROM kits WHERE tag = ?', [value]);
  if (asset) {
    matched = { type: 'asset', id: asset.id, tag: asset.tag, name: asset.name };
    const row = db.get('SELECT loan_id FROM loan_items WHERE asset_id = ? AND outcome IS NULL', [asset.id]);
    if (!row) throw conflict(`${asset.tag} (${asset.name}) is not checked out`);
    loanIds = [row.loan_id];
  } else if (kit) {
    matched = { type: 'kit', id: kit.id, tag: kit.tag, name: kit.name };
    loanIds = db.all(
      `SELECT DISTINCT li.loan_id FROM loan_items li LEFT JOIN assets a ON a.id = li.asset_id
       WHERE li.outcome IS NULL AND (li.kit_id = ? OR a.kit_id = ?)`,
      [kit.id, kit.id],
    ).map((r) => r.loan_id);
    if (!loanIds.length) throw conflict(`No items from kit ${kit.tag} are checked out`);
  } else if (admin) {
    const user = db.get('SELECT * FROM users WHERE student_id = ? OR username = ?', [value, value]);
    if (!user) throw notFound(`No item, kit or student matches "${value}"`);
    matched = { type: 'user', id: user.id, name: user.name };
    loanIds = db.all('SELECT id FROM loans WHERE borrower_id = ? AND closed_at IS NULL ORDER BY due_at', [user.id]).map((r) => r.id);
    if (!loanIds.length) throw conflict(`${user.name} has nothing checked out`);
  } else {
    throw notFound(`No item or kit matches "${value}"`);
  }

  const sc = statusContext(ctx, viewer);
  const loans = loanIds.map((id) => loanDetail(ctx, viewer, id, sc));
  if (!admin && loans.some((l) => l.borrower.id !== viewer.id)) {
    throw forbidden('That item is checked out to someone else. Please bring it to a teacher.');
  }
  return { matched, loans };
}

export function processReturn(ctx, actor, input) {
  const { db } = ctx;
  const s = ctx.settings();
  const admin = isAdmin(actor);
  if (!admin && !s.allow_student_self_checkout) throw forbidden('Self returns are turned off. Please bring the gear to a teacher.');
  if (!Array.isArray(input.items) || input.items.length === 0) throw badRequest('Confirm at least one item to return');
  if (input.items.length > 200) throw badRequest('Too many items at once');

  const seen = new Set();
  const items = input.items.map((raw) => {
    const loanItemId = int(raw?.loan_item_id, 'Loan item', { required: true, min: 1 });
    if (seen.has(loanItemId)) throw badRequest('An item was listed twice');
    seen.add(loanItemId);
    const row = db.get(
      `SELECT li.*, l.borrower_id, l.due_at, u.name AS borrower_name, a.tag, a.name AS asset_name, a.value_cents
       FROM loan_items li JOIN loans l ON l.id = li.loan_id JOIN users u ON u.id = l.borrower_id JOIN assets a ON a.id = li.asset_id
       WHERE li.id = ?`,
      [loanItemId],
    );
    if (!row) throw notFound('Loan item not found');
    if (row.outcome) throw conflict(`${row.tag} has already been ${row.outcome === 'lost' ? 'marked lost' : 'returned'}`);
    if (!admin && row.borrower_id !== actor.id) throw forbidden(`${row.tag} is checked out to someone else`);
    return {
      row,
      condition: oneOf(raw.condition, `Condition for ${row.tag}`, CONDITIONS),
      notes: str(raw.notes, 'Notes', { max: 1000 }),
      photoData: raw.photo || null,
      confirmation: oneOf(raw.confirmation ?? 'manual', 'Confirmation', ['scan', 'manual']),
    };
  });

  const saved = [];
  try {
    for (const item of items) {
      if (item.photoData) {
        item.photo = saveImage(ctx.uploadsDir, 'photos', item.photoData, { field: `Photo for ${item.row.tag}` });
        saved.push(item.photo);
      }
    }
    const now = ctx.now().toISOString();
    const result = db.transaction(() => {
      const fines = [];
      let incidents = 0;
      const loanIds = new Set();
      for (const item of items) {
        const { row } = item;
        loanIds.add(row.loan_id);
        db.run(
          `UPDATE loan_items SET outcome = 'returned', closed_at = ?, closed_by = ?, condition_in = ?, return_notes = ?,
             return_photo = ?, confirmation = ? WHERE id = ? AND outcome IS NULL`,
          [now, actor.id, item.condition, item.notes, item.photo ?? null, item.confirmation, row.id],
        );
        const toRepair = item.condition === 'damaged' && s.damaged_to_repair;
        db.run(
          `UPDATE assets SET condition = ?, state = CASE WHEN ? THEN 'repair' ELSE state END, updated_at = ? WHERE id = ?`,
          [item.condition, toRepair, now, row.asset_id],
        );
        const lateBy = new Date(now) - new Date(row.due_at);
        const pastGrace = now > addHours(row.due_at, s.grace_period_hours);
        let message = `Returned from ${row.borrower_name} — ${capitalize(item.condition)} condition`;
        if (lateBy > 0) message += ' (late)';
        if (item.confirmation === 'manual') message += ' · confirmed by hand';
        if (item.notes) message += ` · "${item.notes}"`;
        logEvent(db, { assetId: row.asset_id, type: 'returned', actorId: actor.id, loanId: row.loan_id, message, photo: item.photo, at: now });

        if (item.condition === 'damaged') {
          incidents += 1;
          db.run(
            `INSERT INTO incidents (asset_id, type, loan_item_id, borrower_id, reported_by, notes, photo, created_at)
             VALUES (?, 'damaged', ?, ?, ?, ?, ?, ?)`,
            [row.asset_id, row.id, row.borrower_id, actor.id, item.notes, item.photo ?? null, now],
          );
          if (toRepair) {
            logEvent(db, { assetId: row.asset_id, type: 'repair', actorId: actor.id, message: 'Moved to repair after a damaged return', at: now });
          }
        }

        if (pastGrace && s.fine_per_day_cents > 0) {
          const days = Math.ceil(lateBy / 86400_000);
          const amount = days * s.fine_per_day_cents;
          const reason = `Late return of ${row.tag} (${days} day${days === 1 ? '' : 's'} late)`;
          const { id } = db.run(
            'INSERT INTO fines (user_id, loan_item_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)',
            [row.borrower_id, row.id, amount, reason, now],
          );
          fines.push({ id, amount_cents: amount, reason });
        }
      }
      for (const loanId of loanIds) closeLoanIfDone(db, loanId, now);
      return { fines, incidents, loanIds: [...loanIds] };
    });
    const sc = statusContext(ctx, actor);
    return {
      returned: items.length,
      fines: result.fines,
      incidents: result.incidents,
      loans: result.loanIds.map((id) => loanDetail(ctx, actor, id, sc)),
    };
  } catch (err) {
    for (const file of saved) fs.rmSync(path.join(ctx.uploadsDir, file), { force: true });
    throw err;
  }
}

function closeLoanIfDone(db, loanId, now) {
  const { open } = db.get('SELECT COUNT(*) AS open FROM loan_items WHERE loan_id = ? AND outcome IS NULL', [loanId]);
  if (open === 0) db.run('UPDATE loans SET closed_at = ? WHERE id = ? AND closed_at IS NULL', [now, loanId]);
}

/** Staff: an item never came back. Closes it on the loan and records a loss. */
export function markLoanItemLost(ctx, actor, loanItemId, input = {}) {
  const { db } = ctx;
  const notes = str(input.notes, 'Notes', { max: 1000 });
  const charge = input.charge_replacement === true;
  const row = db.get(
    `SELECT li.*, l.borrower_id, u.name AS borrower_name, a.tag, a.value_cents
     FROM loan_items li JOIN loans l ON l.id = li.loan_id JOIN users u ON u.id = l.borrower_id JOIN assets a ON a.id = li.asset_id
     WHERE li.id = ?`,
    [loanItemId],
  );
  if (!row) throw notFound('Loan item not found');
  if (row.outcome) throw conflict(`${row.tag} is already closed on this loan`);
  const now = ctx.now().toISOString();
  db.transaction(() => {
    db.run("UPDATE loan_items SET outcome = 'lost', closed_at = ?, closed_by = ?, return_notes = ? WHERE id = ?", [now, actor.id, notes, row.id]);
    db.run("UPDATE assets SET state = 'lost', updated_at = ? WHERE id = ?", [now, row.asset_id]);
    db.run(
      `INSERT INTO incidents (asset_id, type, loan_item_id, borrower_id, reported_by, notes, cost_cents, created_at)
       VALUES (?, 'lost', ?, ?, ?, ?, ?, ?)`,
      [row.asset_id, row.id, row.borrower_id, actor.id, notes, row.value_cents, now],
    );
    logEvent(db, {
      assetId: row.asset_id, type: 'lost', actorId: actor.id, loanId: row.loan_id,
      message: `Marked lost while checked out to ${row.borrower_name}${notes ? ` · "${notes}"` : ''}`, at: now,
    });
    if (charge && row.value_cents > 0) {
      db.run(
        'INSERT INTO fines (user_id, loan_item_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?, ?)',
        [row.borrower_id, row.id, row.value_cents, `Replacement cost for lost ${row.tag} (${formatMoney(row.value_cents)})`, now],
      );
    }
    closeLoanIfDone(db, row.loan_id, now);
  });
  return loanDetail(ctx, actor, row.loan_id);
}

/** Staff: push a loan's due date out. */
export function extendLoan(ctx, actor, loanId, input) {
  const loan = ctx.db.get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (!loan) throw notFound('Loan not found');
  if (loan.closed_at) throw conflict('This loan is already closed');
  const dueAt = isoDate(input.due_at, 'Due date');
  if (dueAt <= ctx.now().toISOString()) throw badRequest('The new due date must be in the future');
  const now = ctx.now().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE loans SET due_at = ? WHERE id = ?', [dueAt, loanId]);
    for (const item of ctx.db.all('SELECT asset_id FROM loan_items WHERE loan_id = ? AND outcome IS NULL', [loanId])) {
      logEvent(ctx.db, { assetId: item.asset_id, type: 'extended', actorId: actor.id, loanId, message: 'Due date changed', at: now });
    }
  });
  return loanDetail(ctx, actor, loanId);
}
