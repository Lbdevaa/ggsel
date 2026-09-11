/**
 * Приём вебхука оплаты и эмулятор платёжной системы.
 *
 * Гарантии контракта, которые здесь закрываются:
 * - at-least-once: повтор с тем же event_id ничего не меняет (PRIMARY KEY + INSERT OR IGNORE);
 * - гонка одинаковых событий с разными event_id: переход created -> paid делает ровно один
 *   вызов (CAS в ordersRepo.transition), только он ставит задачу на выдачу;
 * - не по порядку: failed после paid игнорируется, финальные статусы не откатываются;
 * - вебхук раньше заказа: событие сохраняется и применяется при создании заказа.
 */
import { randomUUID } from 'node:crypto';

import { inTransaction } from '../db/index.js';
import { STATUS } from '../domain/statuses.js';
import { ordersRepo } from '../repositories/orders.js';
import { webhookEventsRepo } from '../repositories/webhookEvents.js';

const WEBHOOK_STATUSES = new Set(['paid', 'failed']);

export class WebhookError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, config: object, enqueueDelivery: (orderId: string) => boolean, log?: Function }} deps
 */
export function paymentsService({ db, config, enqueueDelivery, log = console.log }) {
  const orders = ordersRepo(db);
  const events = webhookEventsRepo(db);

  /**
   * Применяет одно событие к заказу. Вызывается внутри транзакции.
   * @returns {'applied' | 'ignored' | 'amount_mismatch'}
   */
  function applyEvent(event, order) {
    if (typeof event.amount === 'number' && event.amount !== order.amount) {
      log(`[webhook] ${event.event_id}: amount ${event.amount} != order ${order.amount}, ignored`);
      return 'amount_mismatch';
    }
    if (event.status === 'paid') {
      const moved = orders.transition(order.id, STATUS.PAID, { reason: `webhook ${event.event_id}` });
      if (!moved) return 'ignored';
      enqueueDelivery(order.id);
      events.markApplied(event.event_id);
      return 'applied';
    }
    const moved = orders.transition(order.id, STATUS.PAYMENT_FAILED, { reason: `webhook ${event.event_id}` });
    if (!moved) return 'ignored';
    events.markApplied(event.event_id);
    return 'applied';
  }

  return {
    /**
     * Обработка входящего вебхука. Всегда быстро: только запись в БД, выдача идёт в воркере.
     * @returns {{ result: 'applied' | 'duplicate' | 'ignored' | 'pending_order' | 'amount_mismatch' }}
     */
    handleWebhook(payload) {
      const event = normalize(payload);
      return inTransaction(db, () => {
        const isNew = events.insert(event);
        if (!isNew) return { result: 'duplicate' };

        const order = orders.byId(event.order_id);
        if (!order) return { result: 'pending_order' };

        return { result: applyEvent(event, order) };
      });
    },

    /**
     * Вебхуки, пришедшие раньше заказа. Вызывается сразу после создания заказа
     * в той же транзакции, поэтому «окно» между созданием и применением отсутствует.
     */
    applyPending(order) {
      const pending = events.pendingForOrder(order.id);
      let current = order;
      for (const row of pending) {
        const event = JSON.parse(row.payload);
        if (applyEvent(event, current) === 'applied') current = orders.byId(order.id);
      }
      return pending.length;
    },

    /**
     * Эмулятор платёжки: формирует событие по контракту и шлёт его на собственный
     * вебхук по HTTP, тем же путём, что и внешний тестер.
     */
    async emulatePayment(orderId, result) {
      const order = orders.byId(orderId);
      if (!order) throw new WebhookError('order_not_found');
      const event = {
        event_id: `evt_${randomUUID()}`,
        order_id: order.id,
        status: result === 'failed' ? 'failed' : 'paid',
        amount: order.amount,
        currency: 'RUB',
        created_at: new Date().toISOString(),
      };
      const res = await fetch(`${config.publicUrl}/webhook/payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      const webhook = await res.json().catch(() => ({}));
      return { event, webhook_http_status: res.status, webhook };
    },

    eventsForOrder: (orderId) => events.byOrder(orderId),
  };
}

function normalize(payload) {
  const eventId = String(payload?.event_id ?? '');
  const orderId = String(payload?.order_id ?? '');
  const status = String(payload?.status ?? '');
  if (!eventId || eventId.length > 128) throw new WebhookError('invalid_event_id');
  if (!orderId || orderId.length > 128) throw new WebhookError('invalid_order_id');
  if (!WEBHOOK_STATUSES.has(status)) throw new WebhookError('invalid_status');
  const amount = payload.amount === undefined || payload.amount === null ? undefined : Number(payload.amount);
  if (amount !== undefined && !Number.isFinite(amount)) throw new WebhookError('invalid_amount');
  return {
    event_id: eventId,
    order_id: orderId,
    status,
    amount,
    currency: payload.currency,
    created_at: payload.created_at,
  };
}
