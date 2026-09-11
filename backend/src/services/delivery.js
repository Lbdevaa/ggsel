/**
 * Выдача ключа: постановка в очередь, обработка задачи, повторная выдача.
 *
 * Однократность выдачи держится на четырёх вещах:
 * 1. задача на заказ одна (UNIQUE order_id), захват задачи через CAS;
 * 2. переход в delivering через CAS, параллельный обработчик не пройдёт;
 * 3. request_id для каждого поставщика детерминированный и записан в заказ ещё при создании,
 *    поэтому любой повтор (после таймаута, рестарта, ручной повторной выдачи) получает
 *    у поставщика тот же код, а не новый;
 * 4. привязка к поставщику: перед вызовом поставщика его имя пишется в orders.supplier и
 *    снимается только после его явного отказа. Если исход неопределённый (таймаут), заказ
 *    остаётся привязан, и повторная выдача продолжит с того же поставщика с тем же request_id,
 *    а не пойдёт к следующему за вторым ключом.
 *
 * Порядок: A, затем B. К следующему поставщику переходим только после явного отказа
 * предыдущего (4xx/5xx с телом): контракт гарантирует, что при явной ошибке код не выдан.
 */
import { RECOVERABLE_STATUSES, STATUS } from '../domain/statuses.js';
import { deliveryJobsRepo } from '../repositories/deliveryJobs.js';
import { ordersRepo } from '../repositories/orders.js';
import { issueWithRetries } from '../suppliers/client.js';

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: object, log?: Function }} deps
 */
export function deliveryService({ db, config, log = console.log }) {
  const orders = ordersRepo(db);
  const jobs = deliveryJobsRepo(db);

  const suppliers = [
    { name: 'A', url: config.suppliers.a, requestIdField: 'request_id_a' },
    { name: 'B', url: config.suppliers.b, requestIdField: 'request_id_b' },
  ];

  return {
    /** Ставит выдачу в очередь. Повтор для того же заказа ничего не делает. */
    enqueue: (orderId) => jobs.enqueue(orderId),
    claimJob: () => jobs.claim(),
    resetRunningJobs: () => jobs.resetRunning(),
    jobFor: (orderId) => jobs.byOrder(orderId),

    /**
     * Ручная повторная выдача. Идемпотентна: параллельные вызовы ставят одну задачу,
     * а переходы статуса внутри process() защищены CAS.
     * @returns {{ result: 'queued' | 'already_queued' | 'not_recoverable' | 'not_found', status?: string }}
     */
    reissue(orderId) {
      const order = orders.byId(orderId);
      if (!order) return { result: 'not_found' };
      if (!RECOVERABLE_STATUSES.includes(order.status)) {
        return { result: 'not_recoverable', status: order.status };
      }
      const queued = jobs.enqueueOrRequeue(orderId);
      log(`[delivery] ${orderId}: reissue requested -> ${queued ? 'queued' : 'already queued'}`);
      return { result: queued ? 'queued' : 'already_queued', status: order.status };
    },

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

      const outcome = await deliver(order);
      const attempts = (order.attempts ?? 0) + outcome.attempts;

      if (outcome.kind === 'ok') {
        orders.transition(order.id, STATUS.DELIVERED, {
          patch: { key_code: outcome.code, supplier: outcome.supplier, attempts, last_error: null },
          reason: `issued by supplier ${outcome.supplier}`,
        });
        log(`[delivery] ${order.id}: delivered ${outcome.code} by ${outcome.supplier}`);
      } else {
        const status = outcome.kind === 'out_of_stock' ? STATUS.OUT_OF_STOCK : STATUS.DELIVERY_FAILED;
        orders.transition(order.id, status, {
          patch: { attempts, last_error: outcome.error },
          reason: outcome.error,
        });
        log(`[delivery] ${order.id}: ${status} (${outcome.error})`);
      }
      jobs.finish(job.id, 'done');
    },
  };

  /**
   * Обходит поставщиков начиная с того, к которому заказ привязан.
   * @returns {Promise<{ kind: 'ok', code: string, supplier: string, attempts: number }
   *                 | { kind: 'out_of_stock' | 'failed', error: string, attempts: number }>}
   */
  async function deliver(order) {
    const startIndex = Math.max(0, suppliers.findIndex((s) => s.name === order.supplier));
    const errors = [];
    let attempts = 0;
    let allOutOfStock = true;

    for (const supplier of suppliers.slice(startIndex)) {
      // Привязка до вызова: если процесс упадёт посреди запроса, повтор пойдёт к тому же поставщику.
      orders.update(order.id, { supplier: supplier.name });

      const result = await issueWithRetries(
        supplier.url,
        { request_id: order[supplier.requestIdField], sku: order.sku, order_id: order.id },
        {
          timeoutMs: config.suppliers.timeoutMs,
          maxRetries: config.suppliers.maxRetries,
          onAttempt: (info) =>
            log(`[delivery] ${order.id}: supplier ${supplier.name} attempt ${info.attempt} -> ${info.kind}${info.reason ? ` (${info.reason})` : ''}`),
        },
      );
      attempts += result.attempts;

      if (result.kind === 'ok') {
        return { kind: 'ok', code: result.code, supplier: supplier.name, attempts };
      }

      if (result.kind === 'error') {
        // Явный отказ: код не выдан, привязку снимаем и идём к следующему поставщику.
        errors.push(`supplier ${supplier.name}: ${result.reason}`);
        if (result.reason !== 'out_of_stock') allOutOfStock = false;
        orders.update(order.id, { supplier: null });
        continue;
      }

      // Таймаут или сеть: поставщик мог выдать код. Остаёмся привязанными к нему,
      // к следующему не идём. Повторная выдача продолжит отсюда с тем же request_id.
      errors.push(`supplier ${supplier.name}: ${result.kind} ${result.reason ?? ''}`.trim());
      return { kind: 'failed', error: errors.join('; '), attempts };
    }

    return { kind: allOutOfStock ? 'out_of_stock' : 'failed', error: errors.join('; '), attempts };
  }
}
