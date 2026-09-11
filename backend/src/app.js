/**
 * Сборка express-приложения. Только композиция: middleware, роуты, обработка ошибок.
 * Вынесено из server.js, чтобы тесты могли поднять приложение на случайном порту.
 */
import express from 'express';

import { config } from './config.js';
import { productsRouter } from './routes/products.js';

/**
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 */
export function createApp(deps) {
  const app = express();
  app.locals.db = deps.db;

  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(productsRouter);

  // Витрина, страница заказа и админка отдаются как статика из frontend/.
  app.use(express.static(config.frontendDir, { extensions: ['html'] }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
