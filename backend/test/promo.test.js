/** Этап 4: промокоды с лимитом под гонками, серверный расчёт скидки, возврат при неуспешной оплате. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStack } from './helpers/stack.js';

describe('promocodes', () => {
  let stack;
  before(async () => {
    stack = await startStack({ keys: Array.from({ length: 30 }, (_, i) => `P-${i}`) });
  });
  after(() => stack.stop());

  const createWithPromo = (id, sku, code, extra = {}) =>
    stack.post(`${stack.api}/api/orders`, { order_id: id, sku, promo_code: code, ...extra });
  const usedOf = async (code) => (await stack.admin.get('/promocodes')).promocodes.find((p) => p.code === code).used;

  it('preview computes the discount on the server and rejects unknown or malformed codes', async () => {
    const percent = await stack.post(`${stack.api}/api/promo/preview`, { sku: 'KEY-GTA5', code: 'welcome10' });
    assert.equal(percent.status, 200);
    assert.deepEqual(
      { discount: percent.body.quote.discount, amount: percent.body.quote.amount, code: percent.body.quote.code },
      { discount: 199, amount: 1791, code: 'WELCOME10' },
    );

    const capped = await stack.post(`${stack.api}/api/promo/preview`, { sku: 'SUB-DISCORD-1M', code: 'GG500' });
    assert.deepEqual({ discount: capped.body.quote.discount, amount: capped.body.quote.amount }, { discount: 399, amount: 0 });

    assert.equal((await stack.post(`${stack.api}/api/promo/preview`, { sku: 'KEY-GTA5', code: 'NOPE' })).status, 404);
    assert.equal((await stack.post(`${stack.api}/api/promo/preview`, { sku: 'KEY-GTA5', code: 'bad code!' })).status, 400);
    assert.equal((await stack.post(`${stack.api}/api/promo/preview`, { sku: 'NOPE', code: 'WELCOME10' })).status, 400);
  });

  it('order created with a promo code carries the server-side amount, client amount is ignored', async () => {
    const id = stack.newOrderId();
    const res = await createWithPromo(id, 'KEY-GTA5', 'WELCOME10', { amount: 1, discount: 9999 });
    assert.equal(res.status, 201);
    assert.equal(res.body.order.promo_code, 'WELCOME10');
    assert.equal(res.body.order.discount, 199);
    assert.equal(res.body.order.amount, 1791);

    // Вебхук на старую (недисконтированную) сумму не применяется, на актуальную применяется.
    assert.equal((await stack.webhook(id, 'paid', undefined, 1990)).body.result, 'amount_mismatch');
    assert.equal((await stack.webhook(id, 'paid', undefined, 1791)).body.result, 'applied');
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
  });

  it('repeat create with the same order_id does not consume the promo twice', async () => {
    const id = stack.newOrderId();
    const before = await usedOf('WELCOME10');
    await createWithPromo(id, 'KEY-GTA5', 'WELCOME10');
    const again = await createWithPromo(id, 'KEY-GTA5', 'WELCOME10');
    assert.equal(again.status, 200);
    assert.equal(await usedOf('WELCOME10'), before + 1);
  });

  it('R8: 50 parallel orders with LIMIT3 apply the code exactly 3 times', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => createWithPromo(stack.newOrderId(), 'KEY-CS2-PRIME', 'LIMIT3')),
    );
    const ok = responses.filter((r) => r.status === 201);
    const exhausted = responses.filter((r) => r.status === 409 && r.body.error === 'promo_exhausted');
    assert.equal(ok.length, 3);
    assert.equal(exhausted.length, 47);
    assert.ok(ok.every((r) => r.body.order.discount === 322 && r.body.order.amount === 968));
    assert.equal(await usedOf('LIMIT3'), 3);
  });

  it('R9: ONCEONLY under 50 parallel orders is applied once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => createWithPromo(stack.newOrderId(), 'SUB-YT-3M', 'ONCEONLY')),
    );
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.equal(responses.filter((r) => r.status === 409).length, 49);
    assert.equal(await usedOf('ONCEONLY'), 1);
  });

  it('applying a code to an existing order is atomic: 10 parallel applies, one wins', async () => {
    const created = await stack.admin.post('/promocodes', { code: 'APPLY-ONCE', type: 'amount', value: 100, max_uses: 5 });
    assert.equal(created.status, 201);

    const id = stack.newOrderId();
    await stack.createOrder(id, 'GIFT-PSN-1000');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => stack.post(`${stack.api}/api/orders/${id}/promo`, { code: 'apply-once' })),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal(responses.filter((r) => r.body.error === 'promo_already_applied').length, 9);
    const { order } = await stack.order(id);
    assert.equal(order.amount, 900);
    assert.equal(await usedOf('APPLY-ONCE'), 1);

    // После оплаты код к заказу уже не применить.
    await stack.webhook(id, 'paid', undefined, 900);
    await stack.waitFor(id, (o) => o.status === 'delivered');
    const late = await stack.post(`${stack.api}/api/orders/${id}/promo`, { code: 'WELCOME10' });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'order_not_editable');
  });

  it('failed payment releases the usage exactly once, so the next order can take it', async () => {
    await stack.admin.post('/promocodes', { code: 'SINGLE', type: 'percent', value: 50, max_uses: 1 });

    const first = stack.newOrderId();
    assert.equal((await createWithPromo(first, 'KEY-EFT', 'SINGLE')).status, 201);
    assert.equal((await createWithPromo(stack.newOrderId(), 'KEY-EFT', 'SINGLE')).status, 409);

    assert.equal((await stack.webhook(first, 'failed')).body.result, 'applied');
    assert.equal(await usedOf('SINGLE'), 0);
    // Повторный failed и любой paid к финальному заказу ничего не возвращают второй раз.
    assert.equal((await stack.webhook(first, 'failed')).body.result, 'ignored');
    assert.equal(await usedOf('SINGLE'), 0);

    const second = stack.newOrderId();
    assert.equal((await createWithPromo(second, 'KEY-EFT', 'SINGLE')).status, 201);
    assert.equal(await usedOf('SINGLE'), 1);
  });

  it('admin promocode creation validates input and is idempotent by code', async () => {
    assert.equal((await stack.admin.post('/promocodes', { code: 'X', type: 'percent', value: 10, max_uses: 1 })).status, 400);
    assert.equal((await stack.admin.post('/promocodes', { code: 'BAD-TYPE', type: 'free', value: 10, max_uses: 1 })).status, 400);
    assert.equal((await stack.admin.post('/promocodes', { code: 'TOO-MUCH', type: 'percent', value: 150, max_uses: 1 })).status, 400);
    const again = await stack.admin.post('/promocodes', { code: 'SINGLE', type: 'percent', value: 99, max_uses: 99 });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.promo.value, 50);
  });
});
