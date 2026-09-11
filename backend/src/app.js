/**
 * Сборка express-приложения и сервисов. Только композиция: middleware, роуты, обработка ошибок.
 * Вынесено из server.js, чтобы тесты могли поднять приложение на случайном порту.
 */
import express from 'express';

import { ordersRouter } from './routes/orders.js';
import { productsRouter } from './routes/products.js';
import { webhookRouter } from './routes/webhook.js';
import { deliveryService } from './services/delivery.js';
import { ordersService } from './services/orders.js';
import { paymentsService } from './services/payments.js';
import { startDeliveryWorker } from './workers/deliveryWorker.js';

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: object, log?: Function, worker?: boolean }} deps
 * @returns {{ app: import('express').Express, services: object, worker: { kick: Function, stop: Function } | null }}
 */
export function createApp({ db, config, log = console.log, worker: withWorker = true }) {
  const delivery = deliveryService({ db, config, log });
  const payments = paymentsService({ db, config, enqueueDelivery: delivery.enqueue, log });
  const orders = ordersService({
    db,
    // Вебхук мог прийти раньше заказа: применяем отложенные события в транзакции создания.
    hooks: { onOrderCreated: (order) => payments.applyPending(order) },
  });
  const services = { delivery, payments, orders };

  const worker = withWorker ? startDeliveryWorker({ delivery, log }) : null;

  const app = express();
  app.locals.services = services;
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(productsRouter);
  app.use(ordersRouter(services));
  app.use(webhookRouter({ payments, onAccepted: () => worker?.kick() }));

  // Витрина, страница заказа и админка отдаются как статика из frontend/.
  app.use(express.static(config.frontendDir, { extensions: ['html'] }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    log(`[api] unhandled error: ${err?.stack ?? err}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, services, worker };
}
