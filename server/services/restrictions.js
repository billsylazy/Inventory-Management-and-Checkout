import { addDays, addHours, formatMoney } from '../util.js';

/**
 * Works out whether a student may book or check out new gear.
 *
 * Rules (all configurable in Settings):
 *  - Overdue items inside the grace period only produce a warning.
 *  - Once any item is overdue past the grace period, the student is
 *    restricted until it comes back.
 *  - Optionally, a late return keeps the restriction for N extra days.
 *  - Optionally, unpaid fines restrict the student.
 *  - Staff can restrict a student manually until a chosen date.
 */
export function restrictionFor(ctx, userId) {
  const { db } = ctx;
  const s = ctx.settings();
  const now = ctx.now().toISOString();
  const reasons = [];
  const warnings = [];

  const overdue = db.all(
    `SELECT li.id AS loan_item_id, a.id AS asset_id, a.tag, a.name, l.due_at
     FROM loan_items li JOIN loans l ON l.id = li.loan_id JOIN assets a ON a.id = li.asset_id
     WHERE l.borrower_id = ? AND li.outcome IS NULL AND l.due_at < ?
     ORDER BY l.due_at`,
    [userId, now],
  );
  const graceCutoff = addHours(now, -s.grace_period_hours);
  const pastGrace = overdue.filter((o) => o.due_at < graceCutoff);
  const inGrace = overdue.filter((o) => o.due_at >= graceCutoff);
  if (pastGrace.length) {
    reasons.push({
      code: 'overdue',
      message: `${pastGrace.length} overdue item${pastGrace.length === 1 ? '' : 's'} must be returned first: ${pastGrace.map((o) => o.tag).join(', ')}`,
      items: pastGrace,
    });
  }
  if (inGrace.length) {
    warnings.push({
      code: 'grace',
      message: `${inGrace.length} item${inGrace.length === 1 ? ' is' : 's are'} overdue. Booking will be restricted if not returned by the end of the grace period.`,
      until: addHours(inGrace[0].due_at, s.grace_period_hours),
      items: inGrace,
    });
  }

  const user = db.get('SELECT restricted_until, restriction_note FROM users WHERE id = ?', [userId]);
  if (user?.restricted_until && user.restricted_until > now) {
    reasons.push({ code: 'manual', message: user.restriction_note || 'Restricted by staff', until: user.restricted_until });
  }

  if (s.late_return_penalty_days > 0) {
    const since = addDays(now, -s.late_return_penalty_days);
    const lateReturns = db.all(
      `SELECT li.closed_at, l.due_at, a.tag FROM loan_items li
       JOIN loans l ON l.id = li.loan_id JOIN assets a ON a.id = li.asset_id
       WHERE l.borrower_id = ? AND li.outcome = 'returned' AND li.closed_at > ?`,
      [userId, since],
    ).filter((r) => r.closed_at > addHours(r.due_at, s.grace_period_hours));
    if (lateReturns.length) {
      const latest = lateReturns.reduce((a, b) => (a.closed_at > b.closed_at ? a : b));
      reasons.push({
        code: 'late_return',
        message: `${latest.tag} was returned late; booking is paused for ${s.late_return_penalty_days} day${s.late_return_penalty_days === 1 ? '' : 's'}`,
        until: addDays(latest.closed_at, s.late_return_penalty_days),
      });
    }
  }

  const { unpaid } = db.get(
    "SELECT COALESCE(SUM(amount_cents), 0) AS unpaid FROM fines WHERE user_id = ? AND status = 'unpaid'",
    [userId],
  );
  if (unpaid > 0) {
    const entry = { code: 'fines', message: `Unpaid fines: ${formatMoney(unpaid)}`, amount_cents: unpaid };
    if (s.block_on_unpaid_fines) reasons.push(entry);
    else warnings.push(entry);
  }

  return { restricted: reasons.length > 0, reasons, warnings };
}
