/** Базовый флоу заказа: создание, оплата, выдача, ветки отказов. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStack } from './helpers/stack.js';

describe('order flow', () => {
  let stack;
  before(async () => {
    stack = await startStack();
  });
  after(() => stack.stop());

  it('creates an order and returns 201, repeat with same id returns 200 and same order', async () => {
    const id = stack.newOrderId();
    const first = await stack.createOrder(id, 'KEY-GTA5');
    const second = await stack.createOrder(id, 'KEY-GTA5');

    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);
    assert.equal(first.body.order.status, 'created');
    assert.equal(first.body.order.amount, 1990);
    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.order.id, id);
  });

  it('rejects malformed order_id and unknown sku', async () => {
    assert.equal((await stack.createOrder('bad-id')).status, 400);
    assert.equal((await stack.createOrder(stack.newOrderId(), 'NOPE')).status, 400);
  });

  it('paid webhook drives the order to delivered with a key', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const issuedBefore = stack.supplier.stats().issued;

    const res = await stack.webhook(id, 'paid', undefined, 1990);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'applied');

    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
    assert.match(order.key_code, /^TEST-KEY-\d{4}$/);
    assert.equal(order.supplier, 'A');
    assert.deepEqual(history.map((e) => e.to_status), ['created', 'paid', 'delivering', 'delivered']);
    assert.equal(stack.supplier.stats().issued - issuedBefore, 1);
  });

  it('payment emulator sends a webhook to the API itself', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id, 'SUB-DISCORD-1M');
    const res = await stack.post(`${stack.api}/api/orders/${id}/pay?result=success`);
    assert.equal(res.status, 200);
    assert.equal(res.body.webhook.result, 'applied');
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
  });

  it('failed webhook finalizes the order and later paid is ignored', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const failed = await stack.webhook(id, 'failed');
    assert.equal(failed.body.result, 'applied');
    const paid = await stack.webhook(id, 'paid', undefined, 1990);
    assert.equal(paid.body.result, 'ignored');
    const { order } = await stack.order(id);
    assert.equal(order.status, 'payment_failed');
    assert.equal(order.key_code, null);
  });

  it('hides key_code until delivered and returns 404 for unknown order', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const { order } = await stack.order(id);
    assert.equal(order.key_code, null);
    const res = await fetch(`${stack.api}/api/orders/ord_missing-0000-0000`);
    assert.equal(res.status, 404);
  });

  it('webhook with wrong amount is stored but not applied', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const res = await stack.webhook(id, 'paid', undefined, 1);
    assert.equal(res.body.result, 'amount_mismatch');
    const { order } = await stack.order(id);
    assert.equal(order.status, 'created');
  });

  it('rejects invalid webhook body with 400 and accepts it without amount', async () => {
    const bad = await stack.post(`${stack.api}/webhook/payment`, { event_id: 'e', order_id: 'o', status: 'weird' });
    assert.equal(bad.status, 400);
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const ok = await stack.webhook(id, 'paid');
    assert.equal(ok.body.result, 'applied');
  });
});
