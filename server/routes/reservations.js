import express from 'express';
import { isAdmin } from '../auth.js';
import { ACTIVE_RESERVATION_SQL, reservationWindowParams, statusContext } from '../services/inventory.js';
import {
  cancelReservation, createReservation, reservationDetail, windowConflicts,
} from '../services/reservations.js';
import { badRequest, forbidden, int, isoDate, notFound } from '../util.js';

export function reservationRoutes(ctx) {
  const router = express.Router();
  const { db } = ctx;

  router.get('/reservations', (req, res) => {
    const admin = isAdmin(req.user);
    const where = [];
    const params = { ...reservationWindowParams(ctx) };
    if (!admin || req.query.scope === 'mine') {
      where.push('r.user_id = :userId');
      params.userId = req.user.id;
    } else if (req.query.user_id) {
      where.push('r.user_id = :userId');
      params.userId = int(req.query.user_id, 'user_id', { min: 1 });
    }
    if (req.query.active === '1') where.push(ACTIVE_RESERVATION_SQL);
    else if (req.query.past !== '1') where.push("(r.end_at > :now OR r.status = 'booked')");
    const rows = db.all(
      `SELECT r.id FROM reservations r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.start_at ${req.query.past === '1' ? 'DESC' : 'ASC'} LIMIT 300`,
      Object.fromEntries(Object.entries(params).filter(([k]) => where.join(' ').includes(`:${k}`))),
    );
    const sc = statusContext(ctx, req.user);
    res.json({ reservations: rows.map((r) => reservationDetail(ctx, req.user, r.id, sc)) });
  });

  router.get('/reservations/:id', (req, res) => {
    const r = reservationDetail(ctx, req.user, int(req.params.id, 'id', { required: true }));
    if (!r) throw notFound('Booking not found');
    if (!isAdmin(req.user) && r.user.id !== req.user.id) throw forbidden();
    res.json({ reservation: r });
  });

  router.post('/reservations', (req, res) => {
    res.status(201).json({ reservation: createReservation(ctx, req.user, req.body ?? {}) });
  });

  router.post('/reservations/:id/cancel', (req, res) => {
    res.json({ reservation: cancelReservation(ctx, req.user, Number(req.params.id)) });
  });

  // Which items can't be booked for a window — powers the booking picker.
  router.get('/availability', (req, res) => {
    const start = isoDate(req.query.start, 'Start');
    const end = isoDate(req.query.end, 'End');
    if (end <= start) throw badRequest('End must be after start');
    const userId = isAdmin(req.user) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    const ids = db.all("SELECT id FROM assets WHERE state != 'retired'").map((r) => r.id);
    const conflicts = windowConflicts(ctx, ids, start, end, { forUserId: userId });
    res.json({ unavailable: Object.fromEntries(conflicts) });
  });

  return router;
}
