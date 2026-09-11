import { Router } from 'express';

import { RECOVERABLE_STATUSES } from '../domain/statuses.js';
import { ordersRepo } from '../repositories/orders.js';

/**
 * Админка: список заказов, «оплачен, но не выдан», повторная выдача, управление поставщиками.
 * Авторизация упрощённая: заголовок x-admin-token или Authorization: Bearer <token>.
 */
export function adminRouter({ db, config, orders, delivery, worker }) {
  const router = Router();
  const repo = ordersRepo(db);

  router.use('/api/admin', (req, res, next) => {
    const header = req.get('x-admin-token') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (header !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  // ?status=out_of_stock,delivery_failed  или ?recoverable=1 для «оплачен, но не выдан».
  router.get('/api/admin/orders', (req, res) => {
    let rows;
    if (req.query.recoverable) rows = repo.listByStatuses(RECOVERABLE_STATUSES);
    else if (req.query.status) rows = repo.listByStatuses(String(req.query.status).split(','));
    else rows = repo.listAll(Number(req.query.limit ?? 200));
    res.json({
      orders: rows.map((o) => ({ ...orders.serialize(o), key_code: o.key_code, job: delivery.jobFor(o.id)?.state ?? null })),
      recoverable_statuses: RECOVERABLE_STATUSES,
    });
  });

  router.post('/api/admin/orders/:id/reissue', (req, res) => {
    const outcome = delivery.reissue(req.params.id);
    if (outcome.result === 'not_found') return res.status(404).json({ error: 'order_not_found' });
    if (outcome.result === 'not_recoverable') return res.status(409).json({ error: 'not_recoverable', status: outcome.status });
    worker?.kick();
    res.json(outcome);
  });

  const supplierUrl = (name) => ({ a: config.suppliers.a, b: config.suppliers.b })[String(name).toLowerCase()];

  router.get('/api/admin/suppliers', async (_req, res) => {
    const entries = await Promise.all(
      ['A', 'B'].map(async (name) => {
        try {
          const stats = await fetch(`${supplierUrl(name)}/stats`).then((r) => r.json());
          return [name, { url: supplierUrl(name), ok: true, ...stats }];
        } catch (err) {
          return [name, { url: supplierUrl(name), ok: false, error: err.message }];
        }
      }),
    );
    res.json({ suppliers: Object.fromEntries(entries) });
  });

  // Прокси к заглушке поставщика: пополнить пул или поменять режим сбоев.
  for (const action of ['restock', 'chaos']) {
    router.post(`/api/admin/suppliers/:name/${action}`, async (req, res) => {
      const url = supplierUrl(req.params.name);
      if (!url) return res.status(404).json({ error: 'unknown_supplier' });
      try {
        const upstream = await fetch(`${url}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req.body ?? {}),
        });
        res.status(upstream.status).json(await upstream.json());
      } catch (err) {
        res.status(502).json({ error: 'supplier_unreachable', message: err.message });
      }
    });
  }

  return router;
}
