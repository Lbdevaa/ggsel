/** Состязательные сценарии R1–R5 из docs/races.md, в процессе теста. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStack } from './helpers/stack.js';

const count = (responses, key) => responses.filter((r) => r.body.result === key).length;
const transitionsTo = (history, status) => history.filter((e) => e.to_status === status).length;

describe('races', () => {
  let stack;
  before(async () => {
    stack = await startStack({ keys: Array.from({ length: 50 }, (_, i) => `RACE-${i}`) });
  });
  after(() => stack.stop());

  it('R1: 50 parallel paid webhooks with distinct event_id issue exactly one key', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const before = stack.supplier.stats().issued;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => stack.webhook(id, 'paid', stack.newEventId(), 1990)),
    );
    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');

    assert.equal(count(responses, 'applied'), 1);
    assert.equal(count(responses, 'ignored'), 49);
    assert.equal(order.status, 'delivered');
    assert.equal(transitionsTo(history, 'paid'), 1);
    assert.equal(transitionsTo(history, 'delivered'), 1);
    assert.equal(stack.supplier.stats().issued - before, 1);
  });

  it('R2: repeated event_id changes nothing', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const before = stack.supplier.stats().issued;
    const eventId = stack.newEventId();

    const responses = await Promise.all(Array.from({ length: 20 }, () => stack.webhook(id, 'paid', eventId, 1990)));
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered');
    const late = await Promise.all(Array.from({ length: 10 }, () => stack.webhook(id, 'paid', eventId, 1990)));
    const after = await stack.order(id);

    assert.equal(count(responses, 'applied'), 1);
    assert.equal(count(responses, 'duplicate'), 19);
    assert.equal(count(late, 'duplicate'), 10);
    assert.equal(after.order.key_code, order.key_code);
    assert.equal(stack.supplier.stats().issued - before, 1);
  });

  it('R3: webhook arriving before the order is applied on creation', async () => {
    const id = stack.newOrderId();
    const before = stack.supplier.stats().issued;

    const early = await stack.webhook(id, 'paid', stack.newEventId(), 1990);
    assert.equal(early.body.result, 'pending_order');

    const created = await stack.createOrder(id);
    assert.equal(created.status, 201);

    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
    assert.equal(transitionsTo(history, 'paid'), 1);
    assert.equal(stack.supplier.stats().issued - before, 1);
  });

  it('R3b: several early webhooks (paid and failed) for one order apply exactly one', async () => {
    const id = stack.newOrderId();
    const before = stack.supplier.stats().issued;
    await Promise.all([
      stack.webhook(id, 'paid', stack.newEventId(), 1990),
      stack.webhook(id, 'paid', stack.newEventId(), 1990),
      stack.webhook(id, 'failed', stack.newEventId()),
    ]);
    await stack.createOrder(id);
    const { order, history } = await stack.waitFor(id, (o) => o.status !== 'created' && o.status !== 'paid' && o.status !== 'delivering');

    // Порядок применения отложенных событий: по времени приёма, поэтому итог один из финальных.
    assert.ok(['delivered', 'payment_failed'].includes(order.status), order.status);
    assert.equal(transitionsTo(history, 'paid') + transitionsTo(history, 'payment_failed'), 1);
    assert.equal(stack.supplier.stats().issued - before, order.status === 'delivered' ? 1 : 0);
  });

  it('R4: failed after paid is ignored, storm of mixed events does not double-issue', async () => {
    const id = stack.newOrderId();
    await stack.createOrder(id);
    const before = stack.supplier.stats().issued;

    const first = await stack.webhook(id, 'paid', stack.newEventId(), 1990);
    assert.equal(first.body.result, 'applied');
    const storm = await Promise.all(
      Array.from({ length: 40 }, (_, i) => stack.webhook(id, i % 2 ? 'failed' : 'paid', stack.newEventId(), 1990)),
    );
    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');

    assert.equal(count(storm, 'ignored'), 40);
    assert.equal(order.status, 'delivered');
    assert.equal(transitionsTo(history, 'payment_failed'), 0);
    assert.equal(stack.supplier.stats().issued - before, 1);
  });

  it('R5: 30 parallel creates with one order_id produce one order', async () => {
    const id = stack.newOrderId();
    const responses = await Promise.all(Array.from({ length: 30 }, () => stack.createOrder(id)));
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.equal(responses.filter((r) => r.status === 200).length, 29);
    assert.equal(responses.filter((r) => r.body.created).length, 1);
    assert.equal(new Set(responses.map((r) => r.body.order.id)).size, 1);
  });

  it('R5b: creates and paid webhooks racing together still issue one key', async () => {
    const id = stack.newOrderId();
    const before = stack.supplier.stats().issued;
    await Promise.all([
      ...Array.from({ length: 10 }, () => stack.createOrder(id)),
      ...Array.from({ length: 10 }, () => stack.webhook(id, 'paid', stack.newEventId(), 1990)),
    ]);
    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
    assert.equal(transitionsTo(history, 'paid'), 1);
    assert.equal(stack.supplier.stats().issued - before, 1);
  });

  it('invariant: keys issued by the supplier equal delivered orders', async () => {
    const delivered = stack.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered'`).get().n;
    const distinctKeys = stack.db.prepare(`SELECT COUNT(DISTINCT key_code) AS n FROM orders WHERE key_code IS NOT NULL`).get().n;
    assert.equal(stack.supplier.stats().issued, delivered);
    assert.equal(distinctKeys, delivered);
  });
});
