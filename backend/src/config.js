/**
 * Конфигурация API из переменных окружения.
 * Все значения имеют дефолты, чтобы `npm run dev` работал без .env.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(backendRoot, '..');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const port = num(process.env.PORT, 3300);

export const config = Object.freeze({
  port,
  // Адрес, по которому эмулятор платёжки шлёт вебхук самому API.
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  dbPath: path.resolve(repoRoot, process.env.DB_PATH ?? 'backend/data/app.sqlite'),
  frontendDir: path.resolve(repoRoot, 'frontend'),
  dataDir: path.resolve(backendRoot, 'data'),
  adminToken: process.env.ADMIN_TOKEN ?? 'admin-dev-token',
  suppliers: {
    a: process.env.SUPPLIER_A_URL ?? 'http://localhost:4001',
    b: process.env.SUPPLIER_B_URL ?? 'http://localhost:4002',
    timeoutMs: num(process.env.SUPPLIER_TIMEOUT_MS, 3000),
    maxRetries: num(process.env.SUPPLIER_MAX_RETRIES, 3),
  },
});
