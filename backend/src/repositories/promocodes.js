/** SQL по промокодам. Лимит соблюдается атомарным UPDATE с условием used < max_uses. */
import { nowIso } from '../db/index.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function promocodesRepo(db) {
  const stmt = {
    byCode: db.prepare('SELECT * FROM promocodes WHERE code = ?'),
    list: db.prepare('SELECT * FROM promocodes ORDER BY code'),
    insert: db.prepare('INSERT OR IGNORE INTO promocodes (code, type, value, max_uses) VALUES (?, ?, ?, ?)'),
    // Единственная строка, от которой зависит лимит: инкремент и проверка в одном выражении.
    reserve: db.prepare('UPDATE promocodes SET used = used + 1 WHERE code = ? AND used < max_uses'),
    release: db.prepare('UPDATE promocodes SET used = used - 1 WHERE code = ? AND used > 0'),
    insertUsage: db.prepare('INSERT OR IGNORE INTO promo_usages (order_id, code, used_at) VALUES (?, ?, ?)'),
    deleteUsage: db.prepare('DELETE FROM promo_usages WHERE order_id = ? AND code = ?'),
    usageByOrder: db.prepare('SELECT * FROM promo_usages WHERE order_id = ?'),
  };

  return {
    byCode: (code) => stmt.byCode.get(code) ?? null,
    list: () => stmt.list.all(),
    /** @returns {boolean} true, если промокод создан этим вызовом */
    insert: (p) => stmt.insert.run(p.code, p.type, p.value, p.max_uses).changes === 1,

    /**
     * Занимает одно использование под заказ. Повтор для того же заказа ничего не списывает.
     * @returns {'reserved' | 'already' | 'exhausted'}
     */
    reserve(code, orderId) {
      if (stmt.usageByOrder.get(orderId)) return 'already';
      if (stmt.reserve.run(code).changes !== 1) return 'exhausted';
      stmt.insertUsage.run(orderId, code, nowIso());
      return 'reserved';
    },

    /** Возвращает использование, только если оно было занято этим заказом. */
    release(code, orderId) {
      if (stmt.deleteUsage.run(orderId, code).changes !== 1) return false;
      stmt.release.run(code);
      return true;
    },
  };
}
