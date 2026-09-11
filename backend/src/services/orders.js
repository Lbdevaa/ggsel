/** Создание и чтение заказов. */
import { inTransaction } from '../db/index.js';
import { STATUS } from '../domain/statuses.js';
import { ordersRepo } from '../repositories/orders.js';
import { findProduct } from '../repositories/products.js';

const ORDER_ID_RE = /^ord_[A-Za-z0-9-]{8,64}$/;

export class OrderError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, promo: object, hooks?: { onOrderCreated?: (order: object) => void } }} deps
 */
export function ordersService({ db, promo, hooks = {} }) {
  const orders = ordersRepo(db);

  return {
    /**
     * Идемпотентное создание: order_id приходит с клиента, повтор с тем же id
     * возвращает существующий заказ. Это закрывает двойной клик «Купить».
     *
     * @param {{ order_id: string, sku: string, promo_code?: string }} input
     * @returns {{ order: object, created: boolean }}
     */
    create(input) {
      const orderId = String(input?.order_id ?? '');
      if (!ORDER_ID_RE.test(orderId)) {
        throw new OrderError(400, 'invalid_order_id', 'order_id must match ord_<uuid>');
      }
      const product = findProduct(String(input?.sku ?? ''));
      if (!product) throw new OrderError(400, 'unknown_sku');

      return inTransaction(db, () => {
        // Повтор с тем же order_id: возвращаем как есть, промокод второй раз не трогаем.
        const existing = orders.byId(orderId);
        if (existing) return { order: existing, created: false };

        // Скидку считает сервер; клиентские суммы игнорируются. Использование занимается
        // в той же транзакции, что и вставка заказа, поэтому «занято, но заказа нет» невозможно.
        const pricing = input?.promo_code
          ? promo.reserveForOrder(input.promo_code, orderId, product.price)
          : { code: null, discount: 0, amount: product.price };

        orders.insert({
          id: orderId,
          sku: product.sku,
          base_amount: product.price,
          discount: pricing.discount,
          amount: pricing.amount,
          promo_code: pricing.code,
          request_id_a: `req_${orderId}_A`,
          request_id_b: `req_${orderId}_B`,
        });
        const order = orders.byId(orderId);
        hooks.onOrderCreated?.(order);
        return { order, created: true };
      });
    },

    /** @returns {object | null} */
    get(orderId) {
      return orders.byId(orderId);
    },

    history(orderId) {
      return orders.events(orderId);
    },

    /** Публичное представление заказа: ключ виден только в delivered. */
    serialize(order) {
      if (!order) return null;
      const product = findProduct(order.sku);
      return {
        id: order.id,
        sku: order.sku,
        product_name: product?.name ?? order.sku,
        base_amount: order.base_amount,
        discount: order.discount,
        amount: order.amount,
        currency: 'RUB',
        promo_code: order.promo_code,
        status: order.status,
        key_code: order.status === STATUS.DELIVERED ? order.key_code : null,
        supplier: order.supplier,
        attempts: order.attempts,
        last_error: order.last_error,
        created_at: order.created_at,
        updated_at: order.updated_at,
      };
    },
  };
}
