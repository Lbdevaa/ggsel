/**
 * Поднимает полный стек в процессе теста: API на случайном порту с БД в памяти
 * и заглушки поставщиков A и B из suppliers/supplier.js на случайных портах.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp } from '../../src/app.js';
import { config as baseConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const supplierModule = path.resolve(here, '../../../suppliers/supplier.js');

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * @param {{ keys?: string[], keysB?: string[], supplier?: object, supplierB?: object,
 *           timeoutMs?: number, maxRetries?: number, supplierUrl?: string, supplierUrlB?: string }} [opts]
 */
export async function startStack(opts = {}) {
  const { createSupplier } = await import(pathToFileURL(supplierModule).href);
  const supplier = createSupplier({ name: 'A', keys: opts.keys ?? defaultKeys(20, 'A'), log: () => {}, ...opts.supplier });
  const supplierPort = await supplier.listen(0);
  const supplierB = createSupplier({ name: 'B', keys: opts.keysB ?? defaultKeys(5, 'B'), log: () => {}, ...opts.supplierB });
  const supplierBPort = await supplierB.listen(0);

  const db = openDb(':memory:');
  const config = {
    ...baseConfig,
    suppliers: {
      ...baseConfig.suppliers,
      a: opts.supplierUrl ?? `http://localhost:${supplierPort}`,
      b: opts.supplierUrlB ?? `http://localhost:${supplierBPort}`,
      timeoutMs: opts.timeoutMs ?? 1000,
      maxRetries: opts.maxRetries ?? 3,
    },
  };

  const { app, worker, services } = createApp({
    db,
    config,
    log: () => {},
    worker: { intervalMs: 20 },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  config.publicUrl = `http://localhost:${port}`;
  const api = config.publicUrl;

  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  return {
    api,
    supplier,
    supplierB,
    supplierUrl: `http://localhost:${supplierPort}`,
    supplierUrlB: `http://localhost:${supplierBPort}`,
    adminHeaders: { ...JSON_HEADERS, 'x-admin-token': config.adminToken },
    admin: {
      get: (p) => fetch(`${api}/api/admin${p}`, { headers: { 'x-admin-token': config.adminToken } }).then((r) => r.json()),
      post: async (p, body) => {
        const res = await fetch(`${api}/api/admin${p}`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, 'x-admin-token': config.adminToken },
          body: JSON.stringify(body ?? {}),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      },
    },
    services,
    db,
    post,
    get: (url) => fetch(url).then((r) => r.json()),
    newOrderId: () => `ord_${randomUUID()}`,
    newEventId: () => `evt_${randomUUID()}`,
    createOrder: (orderId, sku = 'KEY-GTA5') => post(`${api}/api/orders`, { order_id: orderId, sku }),
    webhook: (orderId, status, eventId = `evt_${randomUUID()}`, amount) =>
      post(`${api}/webhook/payment`, { event_id: eventId, order_id: orderId, status, amount, currency: 'RUB' }),
    order: (orderId) => fetch(`${api}/api/orders/${orderId}`).then((r) => r.json()),
    async waitFor(orderId, predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let info;
      while (Date.now() < deadline) {
        info = await this.order(orderId);
        if (predicate(info.order)) return info;
        await new Promise((r) => setTimeout(r, 25));
      }
      return info;
    },
    async stop() {
      worker?.stop();
      await new Promise((resolve) => server.close(resolve));
      await supplier.close();
      await supplierB.close();
      db.close();
    },
  };
}

function defaultKeys(count, prefix = 'A') {
  return Array.from({ length: count }, (_, i) => `TEST-${prefix}-${String(i + 1).padStart(4, '0')}`);
}
