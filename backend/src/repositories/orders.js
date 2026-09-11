/** SQL по заказам. Никакой бизнес-логики, только запросы. */
import { inTransaction, nowIso } from '../db/index.js';
import { TRANSITIONS } from '../domain/statuses.js';

/** Поля, которые можно менять вместе со статусом. */
const PATCHABLE = new Set(['key_code', 'supplier', 'last_error', 'attempts']);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ordersRepo(db) {
  const stmt = {
    insert: db.prepare(`
      INSERT OR IGNORE INTO orders
        (id, sku, base_amount, discount, amount, promo_code, status,
         request_id_a, request_id_b, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)
    `),
    byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?'),
    listByStatus: db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC'),
    insertEvent: db.prepare(`
      INSERT INTO order_events (order_id, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?)
    `),
    events: db.prepare('SELECT from_status, to_status, reason, at FROM order_events WHERE order_id = ? ORDER BY id'),
  };

  return {
    /**
     * Вставка идемпотентна по id: повтор ничего не меняет.
     * @returns {boolean} true, если заказ создан этим вызовом
     */
    insert(order) {
      const now = nowIso();
      const res = stmt.insert.run(
        order.id, order.sku, order.base_amount, order.discount, order.amount,
        order.promo_code ?? null, order.request_id_a, order.request_id_b, now, now,
      );
      if (res.changes === 1) stmt.insertEvent.run(order.id, null, 'created', order.reason ?? 'order_created', now);
      return res.changes === 1;
    },

    byId: (id) => stmt.byId.get(id) ?? null,
    listAll: (limit = 200) => stmt.listAll.all(limit),
    listByStatuses: (statuses) => statuses.flatMap((s) => stmt.listByStatus.all(s)),
    events: (id) => stmt.events.all(id),

    /**
     * Атомарный compare-and-set перехода статуса. Возвращает true только тому вызову,
     * который реально изменил строку: под гонкой это ровно один из конкурентов.
     *
     * @param {string} id
     * @param {string} to целевой статус; допустимые исходные берутся из TRANSITIONS
     * @param {{ patch?: Record<string, unknown>, reason?: string, from?: string[] }} [opts]
     * @returns {boolean}
     */
    transition(id, to, { patch = {}, reason, from } = {}) {
      const allowedFrom = from ?? TRANSITIONS[to];
      if (!allowedFrom?.length) throw new Error(`no transitions into status "${to}"`);

      const sets = ['status = ?', 'updated_at = ?'];
      const params = [to, nowIso()];
      for (const [key, value] of Object.entries(patch)) {
        if (!PATCHABLE.has(key)) throw new Error(`field "${key}" is not patchable`);
        sets.push(`${key} = ?`);
        params.push(value);
      }
      const placeholders = allowedFrom.map(() => '?').join(', ');

      return inTransaction(db, () => {
        const before = stmt.byId.get(id);
        if (!before) return false;
        const res = db
          .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
          .run(...params, id, ...allowedFrom);
        if (res.changes !== 1) return false;
        stmt.insertEvent.run(id, before.status, to, reason ?? null, nowIso());
        return true;
      });
    },
  };
}
