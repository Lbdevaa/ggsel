/**
 * Состязательные сценарии против живого стенда (см. docs/races.md).
 *
 * Запуск: npm run dev, затем в другом терминале npm run race.
 * Переменные: API_URL (по умолчанию http://localhost:3300), SUPPLIER_A_URL (http://localhost:4001),
 * SUPPLIER_B_URL (http://localhost:4002), ADMIN_TOKEN (admin-dev-token),
 * RACE_REPEAT (сколько раз прогнать весь набор, по умолчанию 1).
 *
 * Каждый сценарий создаёт свои заказы, поэтому набор можно гонять многократно без сброса БД.
 * Перед каждым прогоном скрипт пополняет пулы поставщиков до нужного запаса: один круг тратит
 * около 40 ключей, а стартовые пулы это 50 у A и 5 у B.
 * Сценарии R6–R7 включают режимы сбоев у заглушек поставщиков через /chaos и снимают их после себя.
 * Инвариант в конце: у поставщиков A+B списано ровно столько ключей, сколько заказов дошло до delivered.
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3300';
const SUPPLIER_A = process.env.SUPPLIER_A_URL ?? 'http://localhost:4001';
const SUPPLIER_B = process.env.SUPPLIER_B_URL ?? 'http://localhost:4002';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'admin-dev-token';
const REPEAT = Number(process.env.RACE_REPEAT ?? 1);
const JSON_HEADERS = { 'content-type': 'application/json' };
const ADMIN_HEADERS = { ...JSON_HEADERS, 'x-admin-token': ADMIN_TOKEN };

// ---------- helpers ----------

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const get = (url) => fetch(url).then((r) => r.json());
const newOrderId = () => `ord_${randomUUID()}`;
const newEventId = () => `evt_${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createOrder = (orderId, sku = 'KEY-GTA5', promo_code) => post(`${API}/api/orders`, { order_id: orderId, sku, promo_code });
const adminPost = async (path, body) => {
  const res = await fetch(`${API}/api/admin${path}`, { method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const promoUsed = async (code) => {
  const res = await fetch(`${API}/api/admin/promocodes`, { headers: ADMIN_HEADERS });
  return (await res.json()).promocodes.find((p) => p.code === code)?.used;
};
// Свежий промокод на каждый прогон: лимит глобальный, иначе повторный запуск упёрся бы в исчерпанный код.
const freshPromo = async (prefix, maxUses, type = 'percent', value = 25) => {
  const code = `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
  await adminPost('/promocodes', { code, type, value, max_uses: maxUses });
  return code;
};
const webhook = (orderId, status, eventId = newEventId(), amount) =>
  post(`${API}/webhook/payment`, { event_id: eventId, order_id: orderId, status, amount, currency: 'RUB' });
const issuedAt = async (url) => (await get(`${url}/stats`)).issued;
const availableAt = async (url) => (await get(`${url}/stats`)).available;

// Запас ключей на один круг: A основной поставщик, B нужен для fallback и хаос-стресса.
const STOCK_PER_ROUND = { [SUPPLIER_A]: 60, [SUPPLIER_B]: 20 };
async function ensureStock() {
  for (const [url, need] of Object.entries(STOCK_PER_ROUND)) {
    const available = await availableAt(url);
    if (available < need) await post(`${url}/restock`, { count: need - available });
  }
}
const supplierIssued = () => issuedAt(SUPPLIER_A);
const supplierIssuedTotal = async () => (await issuedAt(SUPPLIER_A)) + (await issuedAt(SUPPLIER_B));
const chaos = (url, body) => post(`${url}/chaos`, body);
const orderInfo = (orderId) => get(`${API}/api/orders/${orderId}`);
const reissue = async (orderId) => {
  const res = await fetch(`${API}/api/admin/orders/${orderId}/reissue`, { method: 'POST', headers: ADMIN_HEADERS });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function waitFor(orderId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let info;
  while (Date.now() < deadline) {
    info = await orderInfo(orderId);
    if (predicate(info.order)) return info;
    await sleep(100);
  }
  return info;
}

const countResults = (responses) =>
  responses.reduce((acc, r) => {
    const key = r.body.result ?? `http_${r.status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const countTransitionsTo = (history, status) => history.filter((e) => e.to_status === status).length;

/** Собирает проверки сценария и решает, прошёл ли он. */
function check(name, expectations, { delivered = 1 } = {}) {
  const failed = expectations.filter((e) => !e.ok);
  return {
    name,
    ok: failed.length === 0,
    delivered, // сколько заказов сценарий довёл до delivered (для итогового инварианта)
    details: expectations.map((e) => `${e.ok ? 'ok ' : 'FAIL'} ${e.label}: expected ${e.expected}, got ${e.actual}`),
  };
}
const expect = (label, actual, expected) => ({ label, actual, expected, ok: actual === expected });

// ---------- scenarios ----------

async function r1_parallelPaidWebhooks() {
  const orderId = newOrderId();
  await createOrder(orderId, 'KEY-GTA5');
  const issuedBefore = await supplierIssued();

  const responses = await Promise.all(Array.from({ length: 50 }, () => webhook(orderId, 'paid', newEventId(), 1990)));
  const results = countResults(responses);
  const { order, history } = await waitFor(orderId, (o) => o.status === 'delivered');

  return check('R1 50 параллельных paid с разными event_id', [
    expect('applied', results.applied ?? 0, 1),
    expect('ignored', results.ignored ?? 0, 49),
    expect('status', order.status, 'delivered'),
    expect('key issued', Boolean(order.key_code), true),
    expect('transitions to paid', countTransitionsTo(history, 'paid'), 1),
    expect('transitions to delivered', countTransitionsTo(history, 'delivered'), 1),
    expect('supplier issued delta', (await supplierIssued()) - issuedBefore, 1),
  ]);
}

async function r2_duplicateEventId() {
  const orderId = newOrderId();
  await createOrder(orderId, 'SUB-YT-3M');
  const issuedBefore = await supplierIssued();
  const eventId = newEventId();

  const responses = await Promise.all(Array.from({ length: 20 }, () => webhook(orderId, 'paid', eventId, 1490)));
  const results = countResults(responses);
  const { order } = await waitFor(orderId, (o) => o.status === 'delivered');

  // Ещё 10 повторов уже после выдачи: ничего не меняется.
  const late = countResults(await Promise.all(Array.from({ length: 10 }, () => webhook(orderId, 'paid', eventId, 1490))));
  const after = await orderInfo(orderId);

  return check('R2 20 повторов одного event_id', [
    expect('applied', results.applied ?? 0, 1),
    expect('duplicate', results.duplicate ?? 0, 19),
    expect('late duplicates', late.duplicate ?? 0, 10),
    expect('status', order.status, 'delivered'),
    expect('key unchanged', after.order.key_code, order.key_code),
    expect('supplier issued delta', (await supplierIssued()) - issuedBefore, 1),
  ]);
}

async function r3_webhookBeforeOrder() {
  const orderId = newOrderId();
  const issuedBefore = await supplierIssued();

  const early = await webhook(orderId, 'paid', newEventId(), 1290);
  const created = await createOrder(orderId, 'KEY-CS2-PRIME');
  const { order, history } = await waitFor(orderId, (o) => o.status === 'delivered');

  return check('R3 вебхук раньше создания заказа', [
    expect('early webhook result', early.body.result, 'pending_order'),
    expect('create status', created.status, 201),
    expect('status', order.status, 'delivered'),
    expect('transitions to paid', countTransitionsTo(history, 'paid'), 1),
    expect('supplier issued delta', (await supplierIssued()) - issuedBefore, 1),
  ]);
}

async function r4_mixedPaidAndFailed() {
  const orderId = newOrderId();
  await createOrder(orderId, 'GIFT-PSN-1000');
  const issuedBefore = await supplierIssued();

  // Первым уходит paid, затем шторм из failed и повторных paid вперемешку.
  const first = await webhook(orderId, 'paid', newEventId(), 1000);
  const storm = Array.from({ length: 40 }, (_, i) => webhook(orderId, i % 2 ? 'failed' : 'paid', newEventId(), 1000));
  const results = countResults(await Promise.all(storm));
  const { order, history } = await waitFor(orderId, (o) => o.status === 'delivered');

  return check('R4 failed и paid вперемешку после первого paid', [
    expect('first paid applied', first.body.result, 'applied'),
    expect('storm ignored', results.ignored ?? 0, 40),
    expect('status', order.status, 'delivered'),
    expect('transitions to payment_failed', countTransitionsTo(history, 'payment_failed'), 0),
    expect('supplier issued delta', (await supplierIssued()) - issuedBefore, 1),
  ]);
}

async function r5_doubleClickCreate() {
  const orderId = newOrderId();
  const responses = await Promise.all(Array.from({ length: 30 }, () => createOrder(orderId, 'SUB-SPOTIFY-1M')));
  const statuses = countResults(responses);
  const ids = new Set(responses.map((r) => r.body.order?.id));
  const createdFlags = responses.filter((r) => r.body.created === true).length;

  return check('R5 30 параллельных POST /api/orders с одним order_id', [
    expect('201 responses', statuses.http_201 ?? 0, 1),
    expect('200 responses', statuses.http_200 ?? 0, 29),
    expect('created:true count', createdFlags, 1),
    expect('distinct order ids', ids.size, 1),
  ], { delivered: 0 });
}

async function r5b_doubleClickThenParallelPay() {
  // Двойной клик и одновременная оплата: заказ один, ключ один.
  const orderId = newOrderId();
  const issuedBefore = await supplierIssued();
  const mixed = [
    ...Array.from({ length: 10 }, () => createOrder(orderId, 'KEY-EFT')),
    ...Array.from({ length: 10 }, () => webhook(orderId, 'paid', newEventId(), 3490)),
  ];
  await Promise.all(mixed);
  const { order, history } = await waitFor(orderId, (o) => o.status === 'delivered');

  return check('R5b создание и оплата одного заказа одновременно', [
    expect('status', order.status, 'delivered'),
    expect('transitions to paid', countTransitionsTo(history, 'paid'), 1),
    expect('supplier issued delta', (await supplierIssued()) - issuedBefore, 1),
  ]);
}

async function r6_outOfStockThenRestockAndParallelReissue() {
  // Оба поставщика отвечают «нет остатка», оплата уже прошла.
  await chaos(SUPPLIER_A, { out_of_stock: true });
  await chaos(SUPPLIER_B, { out_of_stock: true });
  const orderId = newOrderId();
  try {
    await createOrder(orderId, 'KEY-GTA5');
    await webhook(orderId, 'paid', newEventId(), 1990);
    const stuck = await waitFor(orderId, (o) => o.status === 'out_of_stock');
    const issuedBefore = await supplierIssuedTotal();

    // «Пополнение», затем 10 параллельных нажатий «Повторить выдачу».
    await chaos(SUPPLIER_A, { out_of_stock: false });
    await chaos(SUPPLIER_B, { out_of_stock: false });
    const responses = await Promise.all(Array.from({ length: 10 }, () => reissue(orderId)));
    const queued = responses.filter((r) => r.body.result === 'queued').length;
    const { order, history } = await waitFor(orderId, (o) => o.status === 'delivered');
    const again = await reissue(orderId);

    return check('R6 пустой пул → пополнение → 10 параллельных reissue', [
      expect('stuck status', stuck.order.status, 'out_of_stock'),
      expect('stuck has no key', stuck.order.key_code, null),
      expect('reissue queued once', queued, 1),
      expect('status', order.status, 'delivered'),
      expect('transitions to delivered', countTransitionsTo(history, 'delivered'), 1),
      expect('supplier issued delta', (await supplierIssuedTotal()) - issuedBefore, 1),
      expect('reissue after delivered', again.status, 409),
    ]);
  } finally {
    await chaos(SUPPLIER_A, { out_of_stock: false });
    await chaos(SUPPLIER_B, { out_of_stock: false });
  }
}

async function r7_supplierTimeoutSameCode() {
  // A выдаёт ключ, но ответ зависает дольше таймаута клиента. Повтор идёт с тем же request_id.
  const issuedBefore = await supplierIssued();
  await chaos(SUPPLIER_A, { timeout_rate: 1, hang_ms: 20000 });
  const orderId = newOrderId();
  try {
    await createOrder(orderId, 'GIFT-XBOX-1500');
    await webhook(orderId, 'paid', newEventId(), 1500);
    const { order } = await waitFor(orderId, (o) => o.status === 'delivered', 15000);
    return check('R7 таймаут поставщика A, повтор с тем же request_id', [
      expect('status', order.status, 'delivered'),
      expect('supplier', order.supplier, 'A'),
      expect('attempts (1 таймаут + 1 повтор)', order.attempts, 2),
      expect('supplier A issued delta', (await supplierIssued()) - issuedBefore, 1),
    ]);
  } finally {
    await chaos(SUPPLIER_A, { timeout_rate: 0 });
  }
}

async function r7b_fallbackToB() {
  // A явно отказывает (5xx): код не выдан, идём к B.
  const issuedABefore = await issuedAt(SUPPLIER_A);
  const issuedBBefore = await issuedAt(SUPPLIER_B);
  await chaos(SUPPLIER_A, { fail_rate: 1 });
  const orderId = newOrderId();
  try {
    await createOrder(orderId, 'SUB-DISCORD-1M');
    await webhook(orderId, 'paid', newEventId(), 399);
    const { order } = await waitFor(orderId, (o) => o.status === 'delivered');
    return check('R7b явный отказ A → выдача через B', [
      expect('status', order.status, 'delivered'),
      expect('supplier', order.supplier, 'B'),
      expect('supplier A issued delta', (await issuedAt(SUPPLIER_A)) - issuedABefore, 0),
      expect('supplier B issued delta', (await issuedAt(SUPPLIER_B)) - issuedBBefore, 1),
    ]);
  } finally {
    await chaos(SUPPLIER_A, { fail_rate: 0 });
  }
}

async function rs_chaosStress() {
  // Оба поставщика нестабильны: A даёт 5xx в половине случаев и зависает в трети,
  // B падает в трети. 30 заказов оплачиваются одновременно. После затишья все
  // восстановимые заказы добиваются повторной выдачей. Ни одного задвоения быть не должно.
  const COUNT = 30;
  const issuedBefore = await supplierIssuedTotal();
  await chaos(SUPPLIER_A, { fail_rate: 0.5, timeout_rate: 0.3, hang_ms: 20000 });
  await chaos(SUPPLIER_B, { fail_rate: 0.3 });
  const ids = Array.from({ length: COUNT }, newOrderId);
  const settled = (o) => ['delivered', 'out_of_stock', 'delivery_failed'].includes(o.status);
  try {
    await Promise.all(ids.map((id) => createOrder(id, 'KEY-EFT')));
    await Promise.all(ids.map((id) => webhook(id, 'paid', newEventId(), 3490)));
    const firstPass = await Promise.all(ids.map((id) => waitFor(id, settled, 30000)));
    const deliveredFirst = firstPass.filter((i) => i.order.status === 'delivered').length;
    const recoverable = firstPass.filter((i) => i.order.status !== 'delivered').map((i) => i.order.id);

    // Хаос снят, восстановимые заказы добиваем.
    await chaos(SUPPLIER_A, { fail_rate: 0, timeout_rate: 0 });
    await chaos(SUPPLIER_B, { fail_rate: 0 });
    await Promise.all(recoverable.map((id) => reissue(id)));
    const finalPass = await Promise.all(ids.map((id) => waitFor(id, (o) => o.status === 'delivered', 30000)));
    const deliveredFinal = finalPass.filter((i) => i.order.status === 'delivered').length;
    const keys = finalPass.map((i) => i.order.key_code).filter(Boolean);
    const doubleDelivered = finalPass.filter((i) => countTransitionsTo(i.history, 'delivered') > 1).length;

    return check(`RS хаос-стресс: ${COUNT} заказов при A(5xx 0.5, таймаут 0.3) и B(5xx 0.3), затем reissue`, [
      expect('all settled after first pass', firstPass.filter((i) => settled(i.order)).length, COUNT),
      expect('delivered after reissue', deliveredFinal, COUNT),
      expect('distinct keys', new Set(keys).size, COUNT),
      expect('orders delivered twice', doubleDelivered, 0),
      expect('supplier issued delta', (await supplierIssuedTotal()) - issuedBefore, COUNT),
      expect('recovered via reissue (info)', recoverable.length, recoverable.length),
      expect('delivered on first pass (info)', deliveredFirst, deliveredFirst),
    ], { delivered: COUNT });
  } finally {
    await chaos(SUPPLIER_A, { fail_rate: 0, timeout_rate: 0 });
    await chaos(SUPPLIER_B, { fail_rate: 0 });
  }
}

async function r8_promoLimitUnderParallelOrders() {
  const code = await freshPromo('LIMIT3', 3);
  const responses = await Promise.all(Array.from({ length: 50 }, () => createOrder(newOrderId(), 'KEY-CS2-PRIME', code)));
  const ok = responses.filter((r) => r.status === 201);
  const exhausted = responses.filter((r) => r.status === 409 && r.body.error === 'promo_exhausted');
  return check('R8 50 параллельных заказов с промокодом на 3 использования', [
    expect('applied (201)', ok.length, 3),
    expect('rejected (409 promo_exhausted)', exhausted.length, 47),
    expect('server-side discount 25% of 1290', ok.every((r) => r.body.order.discount === 322 && r.body.order.amount === 968), true),
    expect('promo used counter', await promoUsed(code), 3),
  ], { delivered: 0 });
}

async function r9_promoOnceOnly() {
  const code = await freshPromo('ONCE', 1, 'percent', 50);
  const responses = await Promise.all(Array.from({ length: 50 }, () => createOrder(newOrderId(), 'SUB-YT-3M', code)));
  return check('R9 промокод на 1 использование под 50 параллельными заказами', [
    expect('applied (201)', responses.filter((r) => r.status === 201).length, 1),
    expect('rejected (409)', responses.filter((r) => r.status === 409).length, 49),
    expect('promo used counter', await promoUsed(code), 1),
  ], { delivered: 0 });
}

async function r9b_promoReleasedOnFailedPayment() {
  // Неуспешная оплата возвращает использование ровно один раз; повторный failed ничего не возвращает.
  const code = await freshPromo('RELEASE', 1, 'amount', 500);
  const first = newOrderId();
  const created = await createOrder(first, 'KEY-GTA5', code);
  const blocked = await createOrder(newOrderId(), 'KEY-GTA5', code);
  await webhook(first, 'failed');
  const usedAfterFail = await promoUsed(code);
  await webhook(first, 'failed');
  const second = await createOrder(newOrderId(), 'KEY-GTA5', code);
  return check('R9b возврат промокода при неуспешной оплате', [
    expect('first order amount (1990 - 500)', created.body.order?.amount, 1490),
    expect('second order blocked', blocked.status, 409),
    expect('used after failed payment', usedAfterFail, 0),
    expect('used after repeated failed', await promoUsed(code), 1),
    expect('next order takes the code', second.status, 201),
  ], { delivered: 0 });
}

// ---------- runner ----------

const SCENARIOS = [
  r1_parallelPaidWebhooks,
  r2_duplicateEventId,
  r3_webhookBeforeOrder,
  r4_mixedPaidAndFailed,
  r5_doubleClickCreate,
  r5b_doubleClickThenParallelPay,
  r6_outOfStockThenRestockAndParallelReissue,
  r7_supplierTimeoutSameCode,
  r7b_fallbackToB,
  rs_chaosStress,
  r8_promoLimitUnderParallelOrders,
  r9_promoOnceOnly,
  r9b_promoReleasedOnFailedPayment,
];

async function main() {
  try {
    await get(`${API}/health`);
    await get(`${SUPPLIER_A}/health`);
    await get(`${SUPPLIER_B}/health`);
  } catch {
    console.error(`Стенд недоступен: ${API} / ${SUPPLIER_A} / ${SUPPLIER_B}. Запустите npm run dev.`);
    process.exit(2);
  }

  const issuedAtStart = await supplierIssuedTotal();
  let deliveredOrders = 0;
  let failures = 0;

  for (let round = 1; round <= REPEAT; round += 1) {
    if (REPEAT > 1) console.log(`\n=== прогон ${round}/${REPEAT} ===`);
    await ensureStock();
    for (const scenario of SCENARIOS) {
      const started = Date.now();
      const result = await scenario();
      const ms = Date.now() - started;
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${ms} ms)`);
      for (const line of result.details) console.log(`      ${line}`);
      if (!result.ok) failures += 1;
      deliveredOrders += result.delivered;
    }
  }

  const issuedDelta = (await supplierIssuedTotal()) - issuedAtStart;
  const invariantOk = issuedDelta === deliveredOrders;
  console.log(`\nИнвариант: ключей списано у поставщиков A+B ${issuedDelta}, заказов доведено до delivered ${deliveredOrders} -> ${invariantOk ? 'OK' : 'FAIL'}`);
  if (!invariantOk) failures += 1;

  console.log(failures ? `\nПровалено проверок: ${failures}` : '\nВсе сценарии прошли.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
