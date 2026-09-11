/** Этап 3: fallback на поставщика B, восстановимые статусы, идемпотентная повторная выдача, админка. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startStack } from './helpers/stack.js';

describe('recovery', () => {
  let stack;
  before(async () => {
    stack = await startStack({ keys: ['A-1', 'A-2', 'A-3'], keysB: ['B-1', 'B-2'], timeoutMs: 100, maxRetries: 2 });
  });
  after(() => stack.stop());

  it('falls back to supplier B after an explicit 5xx from A', async () => {
    stack.supplier.setChaos({ failRate: 1 });
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered');
    stack.supplier.setChaos({ failRate: 0 });

    assert.equal(order.supplier, 'B');
    assert.equal(order.key_code, 'B-1');
    assert.equal(stack.supplier.stats().issued, 0);
    assert.equal(stack.supplierB.stats().issued, 1);
  });

  it('out_of_stock at both suppliers, restock, then 10 parallel reissues deliver exactly one key', async () => {
    stack.supplier.setChaos({ outOfStock: true });
    stack.supplierB.setChaos({ outOfStock: true });
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const stuck = await stack.waitFor(id, (o) => o.status === 'out_of_stock');
    assert.equal(stuck.order.status, 'out_of_stock');
    assert.equal(stuck.order.key_code, null);

    // В админке заказ виден в списке «оплачен, но не выдан».
    const list = await stack.admin.get('/orders?recoverable=1');
    assert.ok(list.orders.some((o) => o.id === id));

    // «Пополнение»: остаток снова есть.
    stack.supplier.setChaos({ outOfStock: false });
    stack.supplierB.setChaos({ outOfStock: false });
    const issuedBefore = stack.supplier.stats().issued + stack.supplierB.stats().issued;

    const responses = await Promise.all(Array.from({ length: 10 }, () => stack.admin.post(`/orders/${id}/reissue`)));
    const queued = responses.filter((r) => r.body.result === 'queued').length;
    const already = responses.filter((r) => r.body.result === 'already_queued').length;
    const rejected = responses.filter((r) => r.status === 409).length;
    assert.equal(queued, 1);
    assert.equal(queued + already + rejected, 10);

    const { order, history } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.status, 'delivered');
    assert.equal(order.supplier, 'A');
    assert.equal(history.filter((e) => e.to_status === 'delivered').length, 1);
    assert.equal(stack.supplier.stats().issued + stack.supplierB.stats().issued - issuedBefore, 1);

    // Повторная выдача уже выданного заказа отклоняется и ничего не меняет.
    const again = await stack.admin.post(`/orders/${id}/reissue`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'not_recoverable');
    assert.equal(stack.supplier.stats().issued + stack.supplierB.stats().issued - issuedBefore, 1);
  });

  it('stays bound to the supplier with an undetermined outcome and resumes there on reissue', async () => {
    // A честно отвечает «нет остатка», B выдаёт ключ, но ответ зависает дольше таймаута.
    stack.supplier.setChaos({ outOfStock: true });
    stack.supplierB.setChaos({ timeoutRate: 1, hangMs: 5000 });
    const id = stack.newOrderId();
    await stack.createOrder(id);
    await stack.webhook(id, 'paid', undefined, 1990);
    const failed = await stack.waitFor(id, (o) => o.status === 'delivered' || o.status === 'delivery_failed');
    stack.supplierB.setChaos({ timeoutRate: 0 });

    // Повтор внутри той же попытки уже возвращает ключ (repeat идёт до «хаоса»), поэтому
    // заказ мог дойти до delivered сам. В обоих случаях он привязан к B и ключ один.
    assert.equal(failed.order.supplier, 'B');
    const issuedB = stack.supplierB.stats().issued;

    // «Пополнили» A: соблазн начать заново с A и получить второй ключ. Привязка не даёт.
    stack.supplier.setChaos({ outOfStock: false });
    const issuedABefore = stack.supplier.stats().issued;
    if (failed.order.status !== 'delivered') {
      const res = await stack.admin.post(`/orders/${id}/reissue`);
      assert.equal(res.body.result, 'queued');
    }
    const { order } = await stack.waitFor(id, (o) => o.status === 'delivered');
    assert.equal(order.supplier, 'B');
    assert.match(order.key_code, /^B-/);
    assert.equal(stack.supplier.stats().issued, issuedABefore);
    assert.equal(stack.supplierB.stats().issued, issuedB);
  });

  it('admin endpoints require the token and report supplier stats', async () => {
    const anon = await fetch(`${stack.api}/api/admin/orders`);
    assert.equal(anon.status, 401);
    const missing = await stack.admin.post('/orders/ord_missing-0000-0000/reissue');
    assert.equal(missing.status, 404);
    const { suppliers } = await stack.admin.get('/suppliers');
    assert.equal(suppliers.A.ok, true);
    assert.equal(suppliers.B.ok, true);
    assert.equal(typeof suppliers.A.available, 'number');
  });

  it('restock through admin adds keys to the supplier pool', async () => {
    const before = stack.supplierB.stats().total;
    const res = await stack.admin.post('/suppliers/b/restock', { count: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.added, 3);
    assert.equal(stack.supplierB.stats().total, before + 3);
  });

  it('invariant: keys issued across both suppliers equal delivered orders', async () => {
    const delivered = stack.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered'`).get().n;
    assert.equal(stack.supplier.stats().issued + stack.supplierB.stats().issued, delivered);
  });
});
