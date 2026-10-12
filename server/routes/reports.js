import express from 'express';
import { requireAdmin } from '../auth.js';
import { toCsv } from '../csv.js';
import { statusContext, assetStatus } from '../services/inventory.js';
import { addDays, badRequest, fileUrl, isoDate } from '../util.js';

function monthsBetween(fromIso, toIso) {
  const months = [];
  const d = new Date(fromIso);
  const end = new Date(toIso);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
    if (months.length > 60) break;
  }
  return months;
}

export function reportRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;
  router.use('/reports', requireAdmin);

  function range(query) {
    const now = ctx.now().toISOString();
    const to = query.to ? isoDate(query.to, 'To') : now;
    const from = query.from ? isoDate(query.from, 'From') : addDays(to, -365);
    if (from >= to) throw badRequest('"From" must be before "To"');
    return { from, to };
  }

  function incidents({ from, to }, limit = 100000) {
    return db.all(
      `SELECT i.*, a.tag, a.name, a.category, a.state AS asset_state, b.name AS borrower_name, r.name AS reported_by_name
       FROM incidents i JOIN assets a ON a.id = i.asset_id
       LEFT JOIN users b ON b.id = i.borrower_id LEFT JOIN users r ON r.id = i.reported_by
       WHERE i.created_at >= ? AND i.created_at <= ?
       ORDER BY i.created_at DESC LIMIT ?`,
      [from, to, limit],
    );
  }

  router.get('/reports/loss-damage', (req, res) => {
    const r = range(req.query);
    const rows = incidents(r);
    const returns = db.all(
      `SELECT a.category, COUNT(*) AS returns, SUM(CASE WHEN li.condition_in = 'damaged' THEN 1 ELSE 0 END) AS damaged_returns
       FROM loan_items li JOIN assets a ON a.id = li.asset_id
       WHERE li.outcome = 'returned' AND li.closed_at >= ? AND li.closed_at <= ?
       GROUP BY a.category`,
      [r.from, r.to],
    );

    const byCategory = new Map();
    const cat = (name) => {
      if (!byCategory.has(name)) byCategory.set(name, { category: name, lost: 0, damaged: 0, lost_value_cents: 0, returns: 0, damaged_returns: 0 });
      return byCategory.get(name);
    };
    for (const row of returns) Object.assign(cat(row.category), { returns: row.returns, damaged_returns: row.damaged_returns });

    const months = monthsBetween(r.from, r.to);
    const byMonth = new Map(months.map((m) => [m, { month: m, lost: 0, damaged: 0 }]));
    const byAsset = new Map();
    let lostValue = 0;
    for (const i of rows) {
      const c = cat(i.category);
      c[i.type] += 1;
      if (i.type === 'lost') {
        c.lost_value_cents += i.cost_cents;
        lostValue += i.cost_cents;
      }
      const month = byMonth.get(i.created_at.slice(0, 7));
      if (month) month[i.type] += 1;
      if (!byAsset.has(i.asset_id)) {
        byAsset.set(i.asset_id, { id: i.asset_id, tag: i.tag, name: i.name, category: i.category, state: i.asset_state, lost: 0, damaged: 0, last_at: i.created_at });
      }
      byAsset.get(i.asset_id)[i.type] += 1;
    }

    const totalReturns = returns.reduce((s, x) => s + x.returns, 0);
    const damagedReturns = returns.reduce((s, x) => s + x.damaged_returns, 0);
    const lostCount = rows.filter((i) => i.type === 'lost').length;
    const damagedCount = rows.filter((i) => i.type === 'damaged').length;
    const current = db.get(
      `SELECT SUM(CASE WHEN state = 'lost' THEN 1 ELSE 0 END) AS lost_now,
              SUM(CASE WHEN state = 'repair' THEN 1 ELSE 0 END) AS repair_now,
              SUM(CASE WHEN state = 'lost' THEN value_cents ELSE 0 END) AS lost_now_value_cents
       FROM assets`,
    );

    res.json({
      from: r.from,
      to: r.to,
      totals: {
        lost: lostCount,
        damaged: damagedCount,
        lost_value_cents: lostValue,
        returns: totalReturns,
        damaged_returns: damagedReturns,
        damage_rate: totalReturns ? damagedReturns / totalReturns : 0,
        unresolved: rows.filter((i) => !i.resolved_at).length,
        lost_now: current.lost_now ?? 0,
        lost_now_value_cents: current.lost_now_value_cents ?? 0,
        repair_now: current.repair_now ?? 0,
      },
      by_category: [...byCategory.values()]
        .map((c) => ({ ...c, damage_rate: c.returns ? c.damaged_returns / c.returns : 0 }))
        .filter((c) => c.lost || c.damaged || c.returns)
        .sort((a, b) => (b.lost + b.damaged) - (a.lost + a.damaged) || b.returns - a.returns),
      by_month: [...byMonth.values()],
      top_assets: [...byAsset.values()]
        .sort((a, b) => (b.lost + b.damaged) - (a.lost + a.damaged) || b.last_at.localeCompare(a.last_at))
        .slice(0, 15),
      incidents: rows.slice(0, 200).map((i) => ({
        id: i.id,
        type: i.type,
        asset: { id: i.asset_id, tag: i.tag, name: i.name, category: i.category },
        borrower: i.borrower_id ? { id: i.borrower_id, name: i.borrower_name } : null,
        reported_by: i.reported_by_name,
        notes: i.notes,
        photo_url: fileUrl(i.photo),
        cost_cents: i.cost_cents,
        created_at: i.created_at,
        resolved_at: i.resolved_at,
        resolution: i.resolution,
      })),
    });
  });

  router.get('/reports/loss-damage.csv', (req, res) => {
    const rows = incidents(range(req.query));
    const csv = toCsv(rows, [
      { label: 'Date', value: 'created_at' },
      { label: 'Type', value: 'type' },
      { label: 'Tag', value: 'tag' },
      { label: 'Item', value: 'name' },
      { label: 'Category', value: 'category' },
      { label: 'Borrower', value: 'borrower_name' },
      { label: 'Reported by', value: 'reported_by_name' },
      { label: 'Notes', value: 'notes' },
      { label: 'Value ($)', value: (r) => (r.cost_cents ? (r.cost_cents / 100).toFixed(2) : '') },
      { label: 'Resolved', value: (r) => (r.resolved_at ? `${r.resolution} ${r.resolved_at}` : '') },
    ]);
    res.type('text/csv').attachment('loss-damage-report.csv').send(csv);
  });

  // Small dashboard for the staff home screen.
  router.get('/reports/overview', (req, res) => {
    const sc = statusContext(ctx, req.user);
    const counts = { available: 0, checked_out: 0, reserved: 0, unavailable: 0, overdue: 0, total: 0 };
    for (const a of db.all("SELECT id, state FROM assets WHERE state != 'retired'")) {
      const s = assetStatus(a, sc);
      counts[s.code] += 1;
      counts.total += 1;
      if (s.overdue) counts.overdue += 1;
    }
    const now = sc.now;
    const overdueLoans = db.get('SELECT COUNT(*) AS n FROM loans WHERE closed_at IS NULL AND due_at < ?', [now]).n;
    const dueToday = db.get('SELECT COUNT(*) AS n FROM loans WHERE closed_at IS NULL AND due_at >= ? AND due_at < ?', [now, addDays(now, 1)]).n;
    const openIncidents = db.get('SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NULL').n;
    res.json({ counts, overdue_loans: overdueLoans, due_today: dueToday, open_incidents: openIncidents });
  });

  return router;
}
