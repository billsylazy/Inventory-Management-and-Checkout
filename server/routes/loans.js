import express from 'express';
import { isAdmin, requireAdmin } from '../auth.js';
import {
  commitCheckout, extendLoan, listLoans, loanDetail, lookupForReturn, markLoanItemLost, planCheckout, processReturn,
} from '../services/loans.js';
import { forbidden, int, notFound } from '../util.js';

export function loanRoutes(ctx) {
  const router = express.Router();

  router.post('/checkout/preview', (req, res) => {
    res.json(planCheckout(ctx, req.user, req.body ?? {}));
  });

  router.post('/checkout', (req, res) => {
    res.status(201).json({ loan: commitCheckout(ctx, req.user, req.body ?? {}) });
  });

  router.get('/returns/lookup', (req, res) => {
    res.json(lookupForReturn(ctx, req.user, req.query.code));
  });

  router.post('/returns', (req, res) => {
    res.json(processReturn(ctx, req.user, req.body ?? {}));
  });

  router.get('/loans', (req, res) => {
    const scope = ['open', 'overdue', 'closed', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
    const userId = req.query.user_id ? int(req.query.user_id, 'user_id', { min: 1 }) : null;
    res.json({ loans: listLoans(ctx, req.user, { scope, userId }) });
  });

  router.get('/loans/:id', (req, res) => {
    const loan = loanDetail(ctx, req.user, int(req.params.id, 'id', { required: true }));
    if (!loan) throw notFound('Loan not found');
    if (!isAdmin(req.user) && loan.borrower.id !== req.user.id) throw forbidden();
    res.json({ loan });
  });

  router.post('/loans/:id/extend', requireAdmin, (req, res) => {
    res.json({ loan: extendLoan(ctx, req.user, Number(req.params.id), req.body ?? {}) });
  });

  router.post('/loan-items/:id/lost', requireAdmin, (req, res) => {
    res.json({ loan: markLoanItemLost(ctx, req.user, Number(req.params.id), req.body ?? {}) });
  });

  return router;
}
