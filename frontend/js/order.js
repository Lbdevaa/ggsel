/** Страница статуса заказа: показ, эмуляция оплаты, поллинг до финального статуса. */
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
const FINAL = new Set(['delivered', 'payment_failed']);
const POLL_MS = 1000;

const orderId = new URLSearchParams(location.search).get('id');
const $ = (id) => document.getElementById(id);

if (!orderId) {
  document.querySelector('main').innerHTML = '<p>Не указан id заказа.</p>';
} else {
  $('order-id').textContent = orderId;
  $('pay-success').addEventListener('click', () => pay('success'));
  $('pay-failed').addEventListener('click', () => pay('failed'));
  refresh();
}

let timer = null;

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
  const status = $('status');
  status.textContent = STATUS_LABELS[order.status] ?? order.status;
  status.dataset.status = order.status;
  $('pay-actions').hidden = order.status !== 'created';
  $('key-block').hidden = order.status !== 'delivered';
  if (order.key_code) $('key').textContent = order.key_code;
  $('note').textContent = NOTES[order.status] ?? '';
  $('history').innerHTML = history
    .map((e) => `<li><span class="mono">${e.from_status ?? '—'} → ${e.to_status}</span> <span class="muted">${e.reason ?? ''}</span></li>`)
    .join('');
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
