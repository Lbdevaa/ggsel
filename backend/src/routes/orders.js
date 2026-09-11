import { Router } from 'express';

import { OrderError } from '../services/orders.js';
import { WebhookError } from '../services/payments.js';
import { PromoError } from '../services/promo.js';
import { findProduct } from '../repositories/products.js';

/**
 * @param {{ orders: object, payments: object, promo: object }} services
 */
export function ordersRouter({ orders, payments, promo }) {
  const router = Router();

  const sendKnownError = (res, err) => {
    if (err instanceof OrderError || err instanceof PromoError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return true;
    }
    return false;
  };

  // Создание заказа. order_id генерирует клиент, повтор возвращает тот же заказ (200 вместо 201).
  // Необязательный promo_code занимает использование в той же транзакции.
  router.post('/api/orders', (req, res) => {
    try {
      const { order, created } = orders.create(req.body ?? {});
      res.status(created ? 201 : 200).json({ order: orders.serialize(order), created });
    } catch (err) {
      if (!sendKnownError(res, err)) throw err;
    }
  });

  // Расчёт скидки без списания: { sku, code } -> { discount, amount, remaining }.
  router.post('/api/promo/preview', (req, res) => {
    const product = findProduct(String(req.body?.sku ?? ''));
    if (!product) return res.status(400).json({ error: 'unknown_sku' });
    try {
      res.json({ quote: promo.quote(req.body?.code, product.price) });
    } catch (err) {
      if (!sendKnownError(res, err)) throw err;
    }
  });

  // Применить промокод к созданному, ещё не оплаченному заказу.
  router.post('/api/orders/:id/promo', (req, res) => {
    try {
      const order = promo.applyToOrder(req.params.id, req.body?.code);
      res.json({ order: orders.serialize(order) });
    } catch (err) {
      if (!sendKnownError(res, err)) throw err;
    }
  });

  router.get('/api/orders/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    res.json({ order: orders.serialize(order), history: orders.history(order.id) });
  });

  // Эмулятор платёжки: ?result=success|failed или { "result": "..." } в теле.
  router.post('/api/orders/:id/pay', async (req, res, next) => {
    const result = String(req.query.result ?? req.body?.result ?? 'success');
    if (!['success', 'failed'].includes(result)) {
      return res.status(400).json({ error: 'invalid_result', message: 'result must be success or failed' });
    }
    try {
      const outcome = await payments.emulatePayment(req.params.id, result);
      const order = orders.get(req.params.id);
      res.json({ ...outcome, order: orders.serialize(order) });
    } catch (err) {
      if (err instanceof WebhookError && err.code === 'order_not_found') {
        return res.status(404).json({ error: err.code });
      }
      next(err);
    }
  });

  return router;
}
