/** Страница статуса заказа: показ, промокод, эмуляция оплаты, поллинг до финального статуса. */
import { api } from './api.js';

const STATUS_LABELS = {
  created: 'Ожидает оплаты',
  paid: 'Оплачен, запускаем выдачу',
  delivering: 'Получаем ключ у поставщика',
  delivered: 'Ключ выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачен, ключ временно закончился',
  delivery_failed: 'Оплачен, сбой выдачи',
};
const NOTES = {
  out_of_stock: 'Деньги учтены. Ключ будет выдан после пополнения остатка, заказ не потерян.',
  delivery_failed: 'Деньги учтены. Поставщик не ответил, выдача будет повторена вручную или автоматически.',
};
const PROMO_ERRORS = {
  promo_not_found: 'Промокод не найден',
  promo_exhausted: 'Лимит использований промокода исчерпан',
  promo_already_applied: 'Промокод уже применён',
  invalid_promo_code: 'Некорректный промокод',
  order_not_editable: 'Заказ уже оплачен, промокод применить нельзя',
};
const FINAL = new Set(['delivered', 'payment_failed']);
const POLL_MS = 1000;

const orderId = new URLSearchParams(location.search).get('id');
const $ = (id) => document.getElementById(id);
let timer = null;

if (!orderId) {
  document.querySelector('main').innerHTML = '<p>Не указан id заказа.</p>';
} else {
  $('order-id').textContent = orderId;
  $('pay-success').addEventListener('click', () => pay('success'));
  $('pay-failed').addEventListener('click', () => pay('failed'));
  $('promo-form').addEventListener('submit', applyPromo);
  refresh();
}

async function refresh() {
  clearTimeout(timer);
  try {
    const { order, history } = await api.get(`/api/orders/${encodeURIComponent(orderId)}`);
    render(order, history);
    if (!FINAL.has(order.status)) timer = setTimeout(refresh, POLL_MS);
  } catch (err) {
    $('status').textContent = err.status === 404 ? 'Заказ не найден' : `Ошибка: ${err.message}`;
  }
}

function render(order, history) {
  $('product').textContent = order.product_name;
  $('amount').textContent = `${order.amount} ₽`;
  $('discount').textContent = order.discount
    ? `(${order.base_amount} ₽ − ${order.discount} ₽ по промокоду ${order.promo_code})`
    : '';

  const status = $('status');
  status.textContent = STATUS_LABELS[order.status] ?? order.status;
  status.dataset.status = order.status;

  $('promo-form').hidden = order.status !== 'created' || Boolean(order.promo_code);
  $('pay-actions').hidden = order.status !== 'created';
  $('key-block').hidden = order.status !== 'delivered';
  if (order.key_code) $('key').textContent = order.key_code;
  $('note').textContent = NOTES[order.status] ?? '';

  $('history').innerHTML = history
    .map((e) => `<li><span class="mono">${e.from_status ?? '—'} → ${e.to_status}</span> <span class="muted">${e.reason ?? ''}</span></li>`)
    .join('');
}

async function applyPromo(event) {
  event.preventDefault();
  const input = $('promo-code');
  const message = $('promo-message');
  const code = input.value.trim();
  if (!code) return;
  input.disabled = true;
  message.textContent = '';
  try {
    await api.post(`/api/orders/${encodeURIComponent(orderId)}/promo`, { code });
    await refresh();
  } catch (err) {
    message.textContent = PROMO_ERRORS[err.data?.error] ?? `Ошибка: ${err.message}`;
  } finally {
    input.disabled = false;
  }
}

async function pay(result) {
  for (const id of ['pay-success', 'pay-failed']) $(id).disabled = true;
  try {
    await api.post(`/api/orders/${encodeURIComponent(orderId)}/pay?result=${result}`);
  } catch (err) {
    alert(`Ошибка оплаты: ${err.message}`);
  } finally {
    for (const id of ['pay-success', 'pay-failed']) $(id).disabled = false;
    refresh();
  }
}
