import { Router } from 'express';

import { WebhookError } from '../services/payments.js';

/**
 * POST /webhook/payment по контракту платёжки.
 * Ответ всегда быстрый: 200 «принято» для любого валидного события, включая дубли
 * и события к ещё не созданным заказам. 4xx только для битого тела: повторять его бессмысленно.
 * 5xx уходит только при реальном сбое БД, тогда платёжка повторит доставку.
 */
export function webhookRouter({ payments, onAccepted }) {
  const router = Router();

  router.post('/webhook/payment', (req, res) => {
    try {
      const outcome = payments.handleWebhook(req.body ?? {});
      if (outcome.result === 'applied') onAccepted?.();
      res.status(200).json({ received: true, ...outcome });
    } catch (err) {
      if (err instanceof WebhookError) return res.status(400).json({ received: false, error: err.code });
      throw err;
    }
  });

  return router;
}
