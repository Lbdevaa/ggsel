/**
 * Состязательные сценарии против живого стенда (см. docs/races.md).
 *
 * Запуск: npm run dev, затем в другом терминале npm run race.
 * Переменные: API_URL (по умолчанию http://localhost:3300), SUPPLIER_A_URL (http://localhost:4001),
 * RACE_REPEAT (сколько раз прогнать весь набор, по умолчанию 1).
 *
 * Каждый сценарий создаёт свои заказы, поэтому набор можно гонять многократно без сброса БД.
 * Инвариант в конце: у поставщика списано ровно столько ключей, сколько заказов дошло до delivered.
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3300';
const SUPPLIER_A = process.env.SUPPLIER_A_URL ?? 'http://localhost:4001';
const REPEAT = Number(process.env.RACE_REPEAT ?? 1);
const JSON_HEADERS = { 'content-type': 'application/json' };

// ---------- helpers ----------

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const get = (url) => fetch(url).then((r) => r.json());
const newOrderId = () => `ord_${randomUUID()}`;
const newEventId = () => `evt_${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createOrder = (orderId, sku = 'KEY-GTA5') => post(`${API}/api/orders`, { order_id: orderId, sku });
const webhook = (orderId, status, eventId = newEventId(), amount) =>
  post(`${API}/webhook/payment`, { event_id: eventId, order_id: orderId, status, amount, currency: 'RUB' });
const supplierIssued = async () => (await get(`${SUPPLIER_A}/stats`)).issued;
const orderInfo = (orderId) => get(`${API}/api/orders/${orderId}`);

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
function check(name, expectations) {
  const failed = expectations.filter((e) => !e.ok);
  return {
    name,
    ok: failed.length === 0,
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
  ]);
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

// ---------- runner ----------

const SCENARIOS = [r1_parallelPaidWebhooks, r2_duplicateEventId, r3_webhookBeforeOrder, r4_mixedPaidAndFailed, r5_doubleClickCreate, r5b_doubleClickThenParallelPay];

async function main() {
  try {
    await get(`${API}/health`);
    await get(`${SUPPLIER_A}/health`);
  } catch {
    console.error(`Стенд недоступен: ${API} / ${SUPPLIER_A}. Запустите npm run dev.`);
    process.exit(2);
  }

  const issuedAtStart = await supplierIssued();
  let deliveredOrders = 0;
  let failures = 0;

  for (let round = 1; round <= REPEAT; round += 1) {
    if (REPEAT > 1) console.log(`\n=== прогон ${round}/${REPEAT} ===`);
    for (const scenario of SCENARIOS) {
      const started = Date.now();
      const result = await scenario();
      const ms = Date.now() - started;
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${ms} ms)`);
      for (const line of result.details) console.log(`      ${line}`);
      if (!result.ok) failures += 1;
      // Сценарии R1–R4 и R5b заканчиваются одним delivered заказом; R5 без оплаты.
      if (scenario !== r5_doubleClickCreate) deliveredOrders += 1;
    }
  }

  const issuedDelta = (await supplierIssued()) - issuedAtStart;
  const invariantOk = issuedDelta === deliveredOrders;
  console.log(`\nИнвариант: ключей списано у поставщика ${issuedDelta}, заказов доведено до delivered ${deliveredOrders} -> ${invariantOk ? 'OK' : 'FAIL'}`);
  if (!invariantOk) failures += 1;

  console.log(failures ? `\nПровалено проверок: ${failures}` : '\nВсе сценарии прошли.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
