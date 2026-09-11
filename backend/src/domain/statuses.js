/**
 * Статусы заказа и разрешённые переходы. Единственное место, где описана машина состояний.
 *
 * created ──paid──▶ paid ──worker──▶ delivering ──ok──▶ delivered (final)
 *    │                                   │
 *    └──failed──▶ payment_failed (final) ├──out_of_stock──▶ out_of_stock  ──reissue──▶ delivering
 *                                        └──both failed──▶ delivery_failed ──reissue──▶ delivering
 */
export const STATUS = Object.freeze({
  CREATED: 'created',
  PAID: 'paid',
  DELIVERING: 'delivering',
  DELIVERED: 'delivered',
  PAYMENT_FAILED: 'payment_failed',
  OUT_OF_STOCK: 'out_of_stock',
  DELIVERY_FAILED: 'delivery_failed',
});

export const FINAL_STATUSES = Object.freeze([STATUS.DELIVERED, STATUS.PAYMENT_FAILED]);

/** Оплачен, но ключ не выдан. Из этих статусов возможна безопасная повторная выдача. */
export const RECOVERABLE_STATUSES = Object.freeze([STATUS.OUT_OF_STOCK, STATUS.DELIVERY_FAILED]);

/** @type {Readonly<Record<string, readonly string[]>>} to → допустимые from */
export const TRANSITIONS = Object.freeze({
  [STATUS.PAID]: [STATUS.CREATED],
  [STATUS.PAYMENT_FAILED]: [STATUS.CREATED],
  [STATUS.DELIVERING]: [STATUS.PAID, STATUS.DELIVERING, ...RECOVERABLE_STATUSES],
  [STATUS.DELIVERED]: [STATUS.DELIVERING],
  [STATUS.OUT_OF_STOCK]: [STATUS.DELIVERING],
  [STATUS.DELIVERY_FAILED]: [STATUS.DELIVERING],
});

export const isFinal = (status) => FINAL_STATUSES.includes(status);
