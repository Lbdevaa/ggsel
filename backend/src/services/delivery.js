/**
 * Выдача ключа: постановка в очередь и обработка одной задачи.
 *
 * Однократность выдачи держится на трёх вещах:
 * 1. задача на заказ одна (UNIQUE order_id), захват задачи через CAS;
 * 2. переход paid -> delivering через CAS, параллельный обработчик не пройдёт;
 * 3. request_id детерминированный и записан в заказ ещё при создании, поэтому любой
 *    повтор (после таймаута, рестарта, ручной повторной выдачи) получает у поставщика
 *    тот же код, а не новый.
 */
import { STATUS } from '../domain/statuses.js';
import { deliveryJobsRepo } from '../repositories/deliveryJobs.js';
import { ordersRepo } from '../repositories/orders.js';
import { issueWithRetries } from '../suppliers/client.js';

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: object, log?: Function }} deps
 */
export function deliveryService({ db, config, log = console.log }) {
  const orders = ordersRepo(db);
  const jobs = deliveryJobsRepo(db);

  return {
    /** Ставит выдачу в очередь. Повтор для того же заказа ничего не делает. */
    enqueue: (orderId) => jobs.enqueue(orderId),

    /** Для ручной повторной выдачи: заново ставит уже завершённую задачу. */
    enqueueAgain: (orderId) => jobs.enqueueOrRequeue(orderId),

    claimJob: () => jobs.claim(),
    resetRunningJobs: () => jobs.resetRunning(),

    /**
     * Обрабатывает одну захваченную задачу до терминального для этой попытки состояния.
     * @param {{ id: number, order_id: string }} job
     */
    async process(job) {
      const order = orders.byId(job.order_id);
      if (!order) {
        jobs.finish(job.id, 'failed');
        return;
      }
      if (order.status === STATUS.DELIVERED) {
        jobs.finish(job.id, 'done');
        return;
      }

      // Захват заказа на выдачу. Из delivering тоже разрешено: это повтор после рестарта.
      const claimed = orders.transition(order.id, STATUS.DELIVERING, { reason: `job ${job.id}` });
      if (!claimed) {
        log(`[delivery] ${order.id}: status ${order.status}, nothing to deliver`);
        jobs.finish(job.id, 'done');
        return;
      }

      const result = await issueWithRetries(
        config.suppliers.a,
        { request_id: order.request_id_a, sku: order.sku, order_id: order.id },
        {
          timeoutMs: config.suppliers.timeoutMs,
          maxRetries: config.suppliers.maxRetries,
          onAttempt: (info) => log(`[delivery] ${order.id}: supplier A attempt ${info.attempt} -> ${info.kind}${info.reason ? ` (${info.reason})` : ''}`),
        },
      );

      const attempts = (order.attempts ?? 0) + result.attempts;

      if (result.kind === 'ok') {
        orders.transition(order.id, STATUS.DELIVERED, {
          patch: { key_code: result.code, supplier: 'A', attempts, last_error: null },
          reason: 'issued by supplier A',
        });
        log(`[delivery] ${order.id}: delivered ${result.code}`);
      } else if (result.kind === 'error' && result.reason === 'out_of_stock') {
        orders.transition(order.id, STATUS.OUT_OF_STOCK, {
          patch: { attempts, last_error: 'supplier A: out_of_stock' },
          reason: 'supplier A out of stock',
        });
        log(`[delivery] ${order.id}: out_of_stock`);
      } else {
        const error = `supplier A: ${result.kind} ${result.reason ?? ''}`.trim();
        orders.transition(order.id, STATUS.DELIVERY_FAILED, {
          patch: { attempts, last_error: error },
          reason: error,
        });
        log(`[delivery] ${order.id}: delivery_failed (${error})`);
      }
      jobs.finish(job.id, 'done');
    },
  };
}
