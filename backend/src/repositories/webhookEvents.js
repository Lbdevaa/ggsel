/** Журнал входящих вебхуков. PRIMARY KEY по event_id даёт идемпотентность приёма. */
import { nowIso } from '../db/index.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function webhookEventsRepo(db) {
  const stmt = {
    insert: db.prepare(`
      INSERT OR IGNORE INTO webhook_events (event_id, order_id, status, amount, payload, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    markApplied: db.prepare('UPDATE webhook_events SET applied = 1 WHERE event_id = ?'),
    pendingForOrder: db.prepare(`
      SELECT * FROM webhook_events WHERE order_id = ? AND applied = 0 ORDER BY received_at, rowid
    `),
    byOrder: db.prepare('SELECT * FROM webhook_events WHERE order_id = ? ORDER BY received_at, rowid'),
  };

  return {
    /** @returns {boolean} true, если событие новое; false, если такой event_id уже был */
    insert(event) {
      const res = stmt.insert.run(
        event.event_id, event.order_id, event.status,
        event.amount ?? null, JSON.stringify(event), nowIso(),
      );
      return res.changes === 1;
    },
    markApplied: (eventId) => stmt.markApplied.run(eventId),
    pendingForOrder: (orderId) => stmt.pendingForOrder.all(orderId),
    byOrder: (orderId) => stmt.byOrder.all(orderId),
  };
}
