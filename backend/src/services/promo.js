/**
 * Промокоды. Скидку считает только сервер, клиент присылает лишь код.
 *
 * Лимит использований держится на одном атомарном выражении
 * `UPDATE promocodes SET used = used + 1 WHERE code = ? AND used < max_uses`:
 * под гонкой из N параллельных заказов строку успеют изменить ровно max_uses из них.
 * Использование привязано к заказу (promo_usages), поэтому повтор создания заказа
 * с тем же order_id не списывает второй раз, а неуспешная оплата возвращает его ровно один раз.
 */
import { inTransaction } from '../db/index.js';
import { STATUS } from '../domain/statuses.js';
import { ordersRepo } from '../repositories/orders.js';
import { promocodesRepo } from '../repositories/promocodes.js';

const CODE_RE = /^[A-Z0-9_-]{2,32}$/;

export class PromoError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Скидка в рублях для базовой цены. Не больше цены, округление вниз до рубля. */
export function calcDiscount(promo, baseAmount) {
  const raw = promo.type === 'percent' ? Math.floor((baseAmount * promo.value) / 100) : promo.value;
  return Math.max(0, Math.min(baseAmount, raw));
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, log?: Function }} deps
 */
export function promoService({ db, log = console.log }) {
  const promos = promocodesRepo(db);
  const orders = ordersRepo(db);

  function normalizeCode(input) {
    const code = String(input ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new PromoError(400, 'invalid_promo_code');
    return code;
  }

  return {
    /** Расчёт без списания: что даст код для товара с такой ценой. */
    quote(codeInput, baseAmount) {
      const code = normalizeCode(codeInput);
      const promo = promos.byCode(code);
      if (!promo) throw new PromoError(404, 'promo_not_found');
      const discount = calcDiscount(promo, baseAmount);
      return {
        code: promo.code,
        type: promo.type,
        value: promo.value,
        discount,
        amount: baseAmount - discount,
        remaining: promo.max_uses - promo.used,
      };
    },

    /**
     * Занимает использование под заказ и считает итог. Вызывается внутри транзакции создания заказа.
     * @returns {{ code: string, discount: number, amount: number }}
     */
    reserveForOrder(codeInput, orderId, baseAmount) {
      const quote = this.quote(codeInput, baseAmount);
      const outcome = promos.reserve(quote.code, orderId);
      if (outcome === 'exhausted') throw new PromoError(409, 'promo_exhausted', 'promo code usage limit reached');
      return { code: quote.code, discount: quote.discount, amount: quote.amount };
    },

    /**
     * Применить код к уже созданному, ещё не оплаченному заказу.
     * Идемпотентно и безопасно под гонкой: всё в одной транзакции, второй вызов видит promo_code.
     */
    applyToOrder(orderId, codeInput) {
      return inTransaction(db, () => {
        const order = orders.byId(orderId);
        if (!order) throw new PromoError(404, 'order_not_found');
        if (order.status !== STATUS.CREATED) throw new PromoError(409, 'order_not_editable', `order is ${order.status}`);
        if (order.promo_code) throw new PromoError(409, 'promo_already_applied');

        const applied = this.reserveForOrder(codeInput, orderId, order.base_amount);
        const updated = orders.applyPromo(orderId, applied);
        if (!updated) throw new PromoError(409, 'order_not_editable');
        log(`[promo] ${orderId}: ${applied.code} applied, amount ${order.base_amount} -> ${applied.amount}`);
        return orders.byId(orderId);
      });
    },

    /** Возврат использования при неуспешной оплате. Вызывается внутри транзакции перехода. */
    releaseForOrder(order) {
      if (!order.promo_code) return false;
      const released = promos.release(order.promo_code, order.id);
      if (released) log(`[promo] ${order.id}: ${order.promo_code} released`);
      return released;
    },

    list: () => promos.list(),

    /** Админ: новый промокод. Существующий не меняется. */
    create(input) {
      const code = normalizeCode(input?.code);
      const type = String(input?.type ?? '');
      const value = Number(input?.value);
      const maxUses = Number(input?.max_uses);
      if (!['percent', 'amount'].includes(type)) throw new PromoError(400, 'invalid_promo_type');
      if (!Number.isInteger(value) || value <= 0 || (type === 'percent' && value > 100)) throw new PromoError(400, 'invalid_promo_value');
      if (!Number.isInteger(maxUses) || maxUses <= 0) throw new PromoError(400, 'invalid_max_uses');
      const created = promos.insert({ code, type, value, max_uses: maxUses });
      return { promo: promos.byCode(code), created };
    },
  };
}
