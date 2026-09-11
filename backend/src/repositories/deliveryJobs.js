/** Очередь выдачи в БД. UNIQUE(order_id) исключает две задачи на один заказ. */
import { nowIso } from '../db/index.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function deliveryJobsRepo(db) {
  const stmt = {
    enqueue: db.prepare(`
      INSERT OR IGNORE INTO delivery_jobs (order_id, state, run_after, created_at, updated_at)
      VALUES (?, 'queued', ?, ?, ?)
    `),
    // Захват задачи через CAS: строка переходит queued -> running ровно один раз.
    claim: db.prepare(`
      UPDATE delivery_jobs
         SET state = 'running', attempts = attempts + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM delivery_jobs
          WHERE state = 'queued' AND run_after <= ?
          ORDER BY id LIMIT 1
       )
      RETURNING *
    `),
    finish: db.prepare('UPDATE delivery_jobs SET state = ?, updated_at = ? WHERE id = ?'),
    // Повторная постановка уже завершённой задачи (ручная повторная выдача).
    requeue: db.prepare(`
      UPDATE delivery_jobs SET state = 'queued', run_after = ?, updated_at = ?
       WHERE order_id = ? AND state IN ('done', 'failed')
    `),
    resetRunning: db.prepare(`UPDATE delivery_jobs SET state = 'queued', updated_at = ? WHERE state = 'running'`),
    byOrder: db.prepare('SELECT * FROM delivery_jobs WHERE order_id = ?'),
  };

  return {
    /** @returns {boolean} true, если задача поставлена этим вызовом */
    enqueue(orderId) {
      const now = nowIso();
      return stmt.enqueue.run(orderId, now, now, now).changes === 1;
    },
    /** Ставит задачу заново: новая строка, если её не было, иначе перевод done/failed -> queued. */
    enqueueOrRequeue(orderId) {
      if (this.enqueue(orderId)) return true;
      const now = nowIso();
      return stmt.requeue.run(now, now, orderId).changes === 1;
    },
    claim: () => stmt.claim.get(nowIso(), nowIso()) ?? null,
    finish: (id, state) => stmt.finish.run(state, nowIso(), id),
    /** После рестарта незавершённые задачи возвращаются в очередь: выдача идемпотентна по request_id. */
    resetRunning: () => stmt.resetRunning.run(nowIso()).changes,
    byOrder: (orderId) => stmt.byOrder.get(orderId) ?? null,
  };
}
