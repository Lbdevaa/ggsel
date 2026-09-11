/** Точка входа API: открывает БД, собирает приложение, слушает порт. */
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/index.js';

const db = openDb();
const app = createApp({ db });

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}, db=${config.dbPath}`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
