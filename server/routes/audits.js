import express from 'express';
import { requireAdmin } from '../auth.js';
import { STATE_LABELS, logEvent, serializeAssets, statusContext } from '../services/inventory.js';
import { badRequest, bool, conflict, notFound, str } from '../util.js';

/**
 * Quick inventory audit: a teacher scans everything on a shelf; the app
 * compares what was scanned with what the database says should be there.
 *
 *  expected   – active, not checked out, and (if the audit has a location)
 *               assigned to that location
 *  found      – expected and scanned
 *  missing    – expected but not scanned (yet)
 *  unexpected – scanned but not expected: checked out on paper, marked lost,
 *               or belongs to a different location
 */
export function auditRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;
  router.use('/audits', requireAdmin);

  const getAudit = (id) => {
    const audit = db.get(
      'SELECT a.*, u.name AS started_by_name FROM audits a LEFT JOIN users u ON u.id = a.started_by WHERE a.id = ?',
      [Number(id)],
    );
    if (!audit) throw notFound('Audit not found');
    return audit;
  };

  function classify(audit, viewer) {
    const sc = statusContext(ctx, viewer);
    const scope = audit.location ? 'location = :location COLLATE NOCASE' : '1 = 1';
    const scopeParams = audit.location ? { location: audit.location } : {};
    const expectedRows = db.all(
      `SELECT * FROM assets WHERE state = 'active' AND ${scope}
         AND id NOT IN (SELECT asset_id FROM loan_items WHERE outcome IS NULL)
       ORDER BY tag`,
      scopeParams,
    );
    const scans = db.all('SELECT asset_id, scanned_at FROM audit_scans WHERE audit_id = ? ORDER BY scanned_at DESC', [audit.id]);
    const scannedAt = new Map(scans.map((s) => [s.asset_id, s.scanned_at]));
    const expectedIds = new Set(expectedRows.map((r) => r.id));
    const scannedRows = scans.length
      ? db.all(`SELECT * FROM assets WHERE id IN (${scans.map(() => '?').join(',')})`, scans.map((s) => s.asset_id))
      : [];

    const expected = serializeAssets(ctx, viewer, expectedRows, sc);
    const scanned = serializeAssets(ctx, viewer, scannedRows, sc);
    const found = expected.filter((a) => scannedAt.has(a.id)).map((a) => ({ ...a, scanned_at: scannedAt.get(a.id) }));
    const missing = expected.filter((a) => !scannedAt.has(a.id));
    const unexpected = scanned
      .filter((a) => !expectedIds.has(a.id))
      .map((a) => ({ ...a, scanned_at: scannedAt.get(a.id), reason: unexpectedReason(a, audit) }));
    found.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
    unexpected.sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
    return { expected_count: expected.length, found, missing, unexpected };
  }

  function unexpectedReason(asset, audit) {
    if (asset.status.code === 'checked_out') {
      return { code: 'checked_out', message: `Records say it's checked out${asset.status.borrower ? ` to ${asset.status.borrower.name}` : ''}` };
    }
    if (asset.state !== 'active') return { code: asset.state, message: `Records say it's ${STATE_LABELS[asset.state].toLowerCase()}` };
    if (audit.location && (asset.location ?? '').toLowerCase() !== audit.location.toLowerCase()) {
      return { code: 'location', message: asset.location ? `Belongs in ${asset.location}` : 'Has no location set' };
    }
    return { code: 'other', message: 'Not expected here' };
  }

  function auditPayload(audit, viewer) {
    const base = {
      id: audit.id,
      location: audit.location,
      started_by: audit.started_by_name,
      started_at: audit.started_at,
      finished_at: audit.finished_at,
    };
    if (audit.finished_at) return { ...base, summary: JSON.parse(audit.summary) };
    return { ...base, ...classify(audit, viewer) };
  }

  router.get('/audits', (_req, res) => {
    const audits = db.all(
      `SELECT a.*, u.name AS started_by_name,
         (SELECT COUNT(*) FROM audit_scans s WHERE s.audit_id = a.id) AS scan_count
       FROM audits a LEFT JOIN users u ON u.id = a.started_by ORDER BY a.started_at DESC LIMIT 100`,
    ).map((a) => {
      const summary = a.summary ? JSON.parse(a.summary) : null;
      return {
        id: a.id, location: a.location, started_by: a.started_by_name, started_at: a.started_at,
        finished_at: a.finished_at, scan_count: a.scan_count,
        counts: summary ? { expected: summary.expected_count, found: summary.found.length, missing: summary.missing.length, unexpected: summary.unexpected.length } : null,
      };
    });
    res.json({ audits });
  });

  router.post('/audits', (req, res) => {
    const location = str(req.body?.location, 'Location', { max: 80 });
    const { id } = db.run('INSERT INTO audits (location, started_by, started_at) VALUES (?, ?, ?)', [location, req.user.id, ctx.now().toISOString()]);
    res.status(201).json({ audit: auditPayload(getAudit(id), req.user) });
  });

  router.get('/audits/:id', (req, res) => {
    res.json({ audit: auditPayload(getAudit(req.params.id), req.user) });
  });

  router.post('/audits/:id/scan', (req, res) => {
    const audit = getAudit(req.params.id);
    if (audit.finished_at) throw conflict('This audit is finished');
    const code = str(req.body?.code, 'Code', { required: true, max: 64 });
    const row = db.get('SELECT * FROM assets WHERE tag = ?', [code]);
    if (!row) {
      if (db.get('SELECT id FROM kits WHERE tag = ?', [code])) throw badRequest(`${code} is a kit label — scan each item in the kit`);
      throw notFound(`Unknown tag "${code}" — it isn't in the inventory`);
    }
    const already = db.get('SELECT 1 FROM audit_scans WHERE audit_id = ? AND asset_id = ?', [audit.id, row.id]);
    if (!already) db.run('INSERT INTO audit_scans (audit_id, asset_id, scanned_at) VALUES (?, ?, ?)', [audit.id, row.id, ctx.now().toISOString()]);
    const result = classify(audit, req.user);
    const found = result.found.find((a) => a.id === row.id);
    const unexpected = result.unexpected.find((a) => a.id === row.id);
    res.json({
      result: found ? 'found' : 'unexpected',
      duplicate: !!already,
      asset: found ?? unexpected,
      audit: { ...auditPayload(audit, req.user), ...result },
    });
  });

  router.delete('/audits/:id/scan/:assetId', (req, res) => {
    const audit = getAudit(req.params.id);
    if (audit.finished_at) throw conflict('This audit is finished');
    db.run('DELETE FROM audit_scans WHERE audit_id = ? AND asset_id = ?', [audit.id, Number(req.params.assetId)]);
    res.json({ audit: auditPayload(audit, req.user) });
  });

  router.post('/audits/:id/finish', (req, res) => {
    const audit = getAudit(req.params.id);
    if (audit.finished_at) throw conflict('This audit is already finished');
    const markMissingLost = bool(req.body?.mark_missing_lost);
    const relocate = bool(req.body?.relocate_unexpected);
    const restoreLost = bool(req.body?.restore_found_lost);
    const result = classify(audit, req.user);
    const now = ctx.now().toISOString();
    const where = audit.location ? ` in ${audit.location}` : '';
    const actions = [];

    db.transaction(() => {
      for (const a of result.found) {
        logEvent(db, { assetId: a.id, type: 'audit', actorId: req.user.id, message: `Seen in audit #${audit.id}${where}`, at: now });
      }
      for (const a of result.missing) {
        if (markMissingLost) {
          db.run("UPDATE assets SET state = 'lost', updated_at = ? WHERE id = ?", [now, a.id]);
          db.run(
            "INSERT INTO incidents (asset_id, type, reported_by, notes, cost_cents, created_at) VALUES (?, 'lost', ?, ?, ?, ?)",
            [a.id, req.user.id, `Missing in audit #${audit.id}${where}`, a.value_cents, now],
          );
          logEvent(db, { assetId: a.id, type: 'lost', actorId: req.user.id, message: `Missing in audit #${audit.id}${where} — marked lost`, at: now });
        } else {
          logEvent(db, { assetId: a.id, type: 'audit', actorId: req.user.id, message: `Not found in audit #${audit.id}${where}`, at: now });
        }
      }
      if (markMissingLost && result.missing.length) actions.push(`${result.missing.length} missing item(s) marked lost`);
      for (const a of result.unexpected) {
        let message = `Scanned in audit #${audit.id}${where} — ${a.reason.message.charAt(0).toLowerCase()}${a.reason.message.slice(1)}`;
        if (relocate && audit.location && a.reason.code === 'location') {
          db.run('UPDATE assets SET location = ?, updated_at = ? WHERE id = ?', [audit.location, now, a.id]);
          message += `; moved to ${audit.location}`;
          actions.push(`${a.tag} moved to ${audit.location}`);
        }
        if (restoreLost && a.reason.code === 'lost') {
          db.run("UPDATE assets SET state = 'active', updated_at = ? WHERE id = ?", [now, a.id]);
          db.run("UPDATE incidents SET resolved_at = ?, resolution = 'found' WHERE asset_id = ? AND type = 'lost' AND resolved_at IS NULL", [now, a.id]);
          message += '; found and returned to service';
          actions.push(`${a.tag} found and returned to service`);
        }
        logEvent(db, { assetId: a.id, type: 'audit', actorId: req.user.id, message, at: now });
      }
      const slim = (a) => ({ id: a.id, tag: a.tag, name: a.name, category: a.category, location: a.location, reason: a.reason });
      const summary = {
        expected_count: result.expected_count,
        found: result.found.map(slim),
        missing: result.missing.map(slim),
        unexpected: result.unexpected.map(slim),
        actions,
      };
      db.run('UPDATE audits SET finished_at = ?, summary = ? WHERE id = ?', [now, JSON.stringify(summary), audit.id]);
    });
    res.json({ audit: auditPayload(getAudit(audit.id), req.user) });
  });

  router.delete('/audits/:id', (req, res) => {
    const audit = getAudit(req.params.id);
    if (audit.finished_at) throw conflict('Finished audits are kept for the record');
    db.run('DELETE FROM audits WHERE id = ?', [audit.id]);
    res.json({ ok: true });
  });

  return router;
}
