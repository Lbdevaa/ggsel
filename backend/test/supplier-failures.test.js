/** Поведение выдачи при сбоях поставщика: таймаут не равен отказу, пустой пул не роняет заказ. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStack } from './helpers/stack.js';

describe('supplier failures', () => {
  let stack;
  before(async () => {
    // У B пул пустой: сценарии этого файла проверяют поведение с одним реальным ключом на всех.
    stack = await startStack({ keys: ['ONLY-ONE-KEY'], keysB: [], timeoutMs: 100, maxRetries: 3 });
  });
  after(() => stack.stop());

  it('timeout trap: supplier issued but hung, retry with same request_id recovers the same key', async () => {
    stack.supplier.setChaos({ timeoutRate: 1, hangMs: 400 });
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);

    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered', 5000);
    assert.equal(order.status, 'delivered');
    assert.equal(order.key_code, 'ONLY-ONE-KEY');
    // Первая попытка оборвалась по таймауту, вторая получила тот же код без нового списания.
    assert.equal(order.attempts, 2);
    assert.equal(stack.supplier.stats().issued, 1);

    stack.supplier.setChaos({ timeoutRate: 0 });
    const res = await stack.post(`${stack.supplierUrl}/issue`, { request_id: `req_${id}_A`, sku: 'KEY-GTA5', order_id: id });
    assert.equal(res.body.code, 'ONLY-ONE-KEY');
    assert.equal(stack.supplier.stats().issued, 1);
  });

  it('empty pool moves the order to out_of_stock without crashing', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const { order } = await stack.waitFor(id, (o) => o.status === 'out_of_stock');
    assert.equal(order.status, 'out_of_stock');
    assert.equal(order.key_code, null);
    assert.match(order.last_error, /supplier A: out_of_stock; supplier B: out_of_stock/);
    assert.equal(stack.supplier.stats().issued, 1);
    assert.equal(stack.supplierB.stats().issued, 0);
  });

  it('supplier A 5xx and B out of stock move the order to delivery_failed', async () => {
    stack.supplier.addKeys(['SECOND-KEY']);
    stack.supplier.setChaos({ failRate: 1 });
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivery_failed');
    assert.equal(order.status, 'delivery_failed');
    assert.match(order.last_error, /supplier A: supplier_error; supplier B: out_of_stock/);
    assert.equal(stack.supplier.stats().issued, 1);
    stack.supplier.setChaos({ failRate: 0 });
  });
});

describe('supplier unreachable', () => {
  let stack;
  before(async () => {
    // Порт 9 закрыт: каждая попытка заканчивается сетевой ошибкой.
    stack = await startStack({ supplierUrl: 'http://127.0.0.1:9', timeoutMs: 200, maxRetries: 2 });
  });
  after(() => stack.stop());

  it('network errors exhaust retries, keep the order bound to A and do not fall back to B', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivery_failed', 5000);
    assert.equal(order.status, 'delivery_failed');
    assert.equal(order.attempts, 2);
    assert.match(order.last_error, /network|timeout/);
    // Исход у A неопределённый, поэтому к B не ходили: у него ничего не списано.
    assert.equal(order.supplier, 'A');
    assert.equal(stack.supplierB.stats().issued, 0);
    assert.deepEqual(history.map((e) => e.to_status), ['created', 'paid', 'delivering', 'delivery_failed']);
  });
});
