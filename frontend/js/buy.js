/**
 * Клик «Купить». order_id генерируется один раз на клик и отправляется с запросом:
 * повторный клик или ретрай браузера с тем же id вернёт тот же заказ, а не создаст второй.
 */
import { api } from './api.js';

export async function buy(button, sku) {
  if (button.disabled) return;
  button.disabled = true;
  const orderId = `ord_${crypto.randomUUID()}`;
  try {
    await api.post('/api/orders', { order_id: orderId, sku });
    window.location.href = `order.html?id=${encodeURIComponent(orderId)}`;
  } catch (err) {
    button.disabled = false;
    alert(`Не удалось создать заказ: ${err.message}`);
  }
}
