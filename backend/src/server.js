/** Точка входа API: открывает БД, собирает приложение и воркер, слушает порт. */
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/index.js';

const db = openDb();
const { app, worker } = createApp({ db, config });

const server = app.listen(config.port, () => {
  console.log(`[api] listening on ${config.publicUrl}, db=${config.dbPath}`);
});

const shutdown = () => {
  worker?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
