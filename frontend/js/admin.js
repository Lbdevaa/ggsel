/** Админка: список заказов, повторная выдача, управление заглушками поставщиков. */
import { API_BASE } from './config.js';

const $ = (id) => document.getElementById(id);
const tokenInput = $('token');

try {
  tokenInput.value = localStorage.getItem('ggsel_admin_token') ?? 'admin-dev-token';
} catch {
  tokenInput.value = 'admin-dev-token';
}
tokenInput.addEventListener('change', () => {
  try {
    localStorage.setItem('ggsel_admin_token', tokenInput.value);
  } catch {
    /* хранилище недоступно, работаем без запоминания */
  }
  refreshAll();
});

async function adminRequest(method, path, body) {
  const res = await fetch(`${API_BASE}/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': tokenInput.value },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function say(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.style.color = isError ? '#dc2626' : '';
}

// ---------- поставщики ----------

async function renderSuppliers() {
  const { suppliers } = await adminRequest('GET', '/suppliers');
  $('suppliers').innerHTML = Object.entries(suppliers)
    .map(([name, s]) => supplierCard(name, s))
    .join('');
}

function supplierCard(name, s) {
  if (!s.ok) {
    return `<div class="supplier"><div class="supplier-title">Поставщик ${name}</div><p class="muted">Недоступен: ${s.error}</p></div>`;
  }
  return `
    <div class="supplier" data-name="${name}">
      <div class="supplier-title"><span>Поставщик ${name}</span><span class="muted mono">${s.url}</span></div>
      <div class="supplier-stats">
        <span>Всего <b>${s.total}</b></span>
        <span>Выдано <b>${s.issued}</b></span>
        <span>Свободно <b>${s.available}</b></span>
      </div>
      <div class="supplier-actions">
        <button type="button" class="small" data-action="restock">Пополнить +10</button>
        <label><input type="checkbox" data-chaos="out_of_stock" ${s.out_of_stock ? 'checked' : ''}> нет остатка</label>
        <label>5xx <input type="number" min="0" max="1" step="0.1" value="${s.fail_rate}" data-chaos="fail_rate"></label>
        <label>таймаут <input type="number" min="0" max="1" step="0.1" value="${s.timeout_rate}" data-chaos="timeout_rate"></label>
        <label>зависание, мс <input type="number" min="0" step="500" value="${s.hang_ms}" data-chaos="hang_ms"></label>
      </div>
    </div>`;
}

$('suppliers').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-action="restock"]');
  if (!button) return;
  const name = button.closest('.supplier').dataset.name;
  await run(() => adminRequest('POST', `/suppliers/${name}/restock`, { count: 10 }), `Пул ${name} пополнен`);
});

$('suppliers').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-chaos]');
  if (!input) return;
  const name = input.closest('.supplier').dataset.name;
  const value = input.type === 'checkbox' ? input.checked : Number(input.value);
  await run(() => adminRequest('POST', `/suppliers/${name}/chaos`, { [input.dataset.chaos]: value }), `Режим ${name} обновлён`);
});

// ---------- заказы ----------

const filter = () => document.querySelector('input[name="filter"]:checked').value;

async function renderOrders() {
  const query = filter() === 'recoverable' ? '?recoverable=1' : '?limit=200';
  const { orders } = await adminRequest('GET', `/orders${query}`);
  const recoverable = new Set(['out_of_stock', 'delivery_failed']);
  $('orders').innerHTML = orders.length
    ? orders.map((o) => `
      <tr>
        <td><a class="mono" href="order.html?id=${encodeURIComponent(o.id)}" target="_blank">${o.id.slice(0, 12)}…</a></td>
        <td>${o.product_name}</td>
        <td>${o.amount} ₽</td>
        <td><span class="badge" data-status="${o.status}">${o.status}</span></td>
        <td>${o.supplier ?? '—'}</td>
        <td>${o.attempts}</td>
        <td class="error">${o.last_error ?? ''}</td>
        <td class="mono">${o.key_code ?? ''}</td>
        <td>${recoverable.has(o.status) ? `<button type="button" class="small" data-reissue="${o.id}">Повторить выдачу</button>` : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="muted">Пусто</td></tr>';
}

$('orders').addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-reissue]');
  if (!button) return;
  button.disabled = true;
  const id = button.dataset.reissue;
  await run(async () => {
    const outcome = await adminRequest('POST', `/orders/${id}/reissue`);
    return outcome.result;
  }, 'Повторная выдача поставлена в очередь');
  // Даём воркеру время, затем перерисовываем.
  setTimeout(renderOrders, 800);
});

document.querySelectorAll('input[name="filter"]').forEach((el) => el.addEventListener('change', renderOrders));
$('refresh').addEventListener('click', refreshAll);

async function run(fn, okText) {
  try {
    const result = await fn();
    say(typeof result === 'string' ? `${okText}: ${result}` : okText);
    await refreshAll();
  } catch (err) {
    say(err.status === 401 ? 'Неверный токен' : `Ошибка: ${err.data?.error ?? err.message}`, true);
  }
}

async function refreshAll() {
  try {
    await Promise.all([renderSuppliers(), renderOrders()]);
    say('');
  } catch (err) {
    say(err.status === 401 ? 'Неверный токен' : `Ошибка: ${err.message}`, true);
  }
}

refreshAll();
setInterval(renderOrders, 3000);
