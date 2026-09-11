/**
 * Заглушка поставщика выдачи по контракту из брифа.
 *
 * Запуск: node supplier.js A   (или B). Настройки через env с префиксом SUPPLIER_<NAME>_
 * или общим SUPPLIER_ (см. .env.example).
 *
 * Контракт:
 *   POST /issue   { request_id, sku, order_id } -> 200 { status:'ok', request_id, code }
 *                                              -> 409 { status:'error', reason:'out_of_stock' }
 *                                              -> 500 { status:'error', reason:'supplier_error' }
 *                                              -> зависание на HANG_MS (эмуляция таймаута)
 *   POST /restock { keys: [...] } | { count: N }  пополнить пул
 *   POST /chaos   { fail_rate, timeout_rate, hang_ms }  поменять долю сбоев на лету (для гонок)
 *   GET  /stats   { name, total, issued, available, fail_rate, timeout_rate }
 *   GET  /health
 *
 * Ключевое требование контракта: повтор с тем же request_id возвращает тот же код.
 * Ловушка таймаута воспроизведена честно: при «зависании» ключ уже выдан и привязан
 * к request_id, просто ответ не дошёл.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const name = (process.argv[2] ?? process.env.SUPPLIER_NAME ?? 'A').toUpperCase();

const env = (key, fallback) => {
  const specific = process.env[`SUPPLIER_${name}_${key}`];
  const common = process.env[`SUPPLIER_${key}`];
  return specific ?? common ?? fallback;
};

const defaultPort = name === 'A' ? 4001 : 4002;
const state = {
  name,
  port: Number(env('PORT', defaultPort)),
  keysFile: path.resolve(here, env('KEYS_FILE', `data/keys-${name.toLowerCase()}.json`)),
  dbPath: path.resolve(here, env('DB_PATH', `data/supplier-${name.toLowerCase()}.sqlite`)),
  failRate: Number(env('FAIL_RATE', 0)),
  timeoutRate: Number(env('TIMEOUT_RATE', 0)),
  hangMs: Number(env('HANG_MS', 10000)),
};

// ---------- хранилище ----------

fs.mkdirSync(path.dirname(state.dbPath), { recursive: true });
const db = new DatabaseSync(state.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    code       TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    order_id   TEXT,
    sku        TEXT,
    issued_at  TEXT
  );
`);

const stmt = {
  insertKey: db.prepare('INSERT OR IGNORE INTO keys (code) VALUES (?)'),
  byRequest: db.prepare('SELECT code FROM keys WHERE request_id = ?'),
  reserve: db.prepare(`
    UPDATE keys
       SET request_id = ?, order_id = ?, sku = ?, issued_at = ?
     WHERE code = (SELECT code FROM keys WHERE request_id IS NULL ORDER BY rowid LIMIT 1)
    RETURNING code
  `),
  stats: db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN request_id IS NOT NULL THEN 1 ELSE 0 END) AS issued
      FROM keys
  `),
};

function seedFromFile() {
  if (!fs.existsSync(state.keysFile)) return 0;
  const { keys } = JSON.parse(fs.readFileSync(state.keysFile, 'utf8'));
  return addKeys(keys);
}

function addKeys(keys) {
  let added = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const code of keys) added += stmt.insertKey.run(code).changes;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

function generateKeys(count) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const block = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return Array.from({ length: count }, () => `${name}${block().slice(1)}-${block()}-${block()}`);
}

/**
 * Единственная точка выдачи. Транзакция гарантирует: либо ключ найден по request_id,
 * либо зарезервирован ровно один свободный, либо пул пуст.
 * @returns {{ code: string, repeated: boolean } | null}
 */
function issue({ request_id, order_id, sku }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = stmt.byRequest.get(request_id);
    if (existing) {
      db.exec('COMMIT');
      return { code: existing.code, repeated: true };
    }
    const reserved = stmt.reserve.get(request_id, order_id ?? null, sku ?? null, new Date().toISOString());
    db.exec('COMMIT');
    return reserved ? { code: reserved.code, repeated: false } : null;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function stats() {
  const row = stmt.stats.get();
  const total = Number(row.total ?? 0);
  const issued = Number(row.issued ?? 0);
  return {
    name,
    total,
    issued,
    available: total - issued,
    fail_rate: state.failRate,
    timeout_rate: state.timeoutRate,
    hang_ms: state.hangMs,
  };
}

// ---------- http ----------

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 65536) reject(new Error('payload_too_large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });

const log = (...args) => console.log(`[supplier-${name}]`, ...args);

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /health') return send(res, 200, { ok: true, name });
  if (route === 'GET /stats') return send(res, 200, stats());

  if (route === 'POST /chaos') {
    const body = await readJson(req);
    if (body.fail_rate !== undefined) state.failRate = Number(body.fail_rate);
    if (body.timeout_rate !== undefined) state.timeoutRate = Number(body.timeout_rate);
    if (body.hang_ms !== undefined) state.hangMs = Number(body.hang_ms);
    log('chaos updated', { fail_rate: state.failRate, timeout_rate: state.timeoutRate, hang_ms: state.hangMs });
    return send(res, 200, stats());
  }

  if (route === 'POST /restock') {
    const body = await readJson(req);
    const keys = Array.isArray(body.keys) ? body.keys : generateKeys(Number(body.count ?? 10));
    const added = addKeys(keys);
    log(`restocked +${added}`);
    return send(res, 200, { added, ...stats() });
  }

  if (route === 'POST /issue') {
    const body = await readJson(req);
    if (!body.request_id) {
      return send(res, 400, { status: 'error', reason: 'request_id_required' });
    }

    // Повтор по request_id обслуживается до любого «хаоса»: поставщик обязан вернуть тот же код.
    const existing = stmt.byRequest.get(body.request_id);
    if (existing) {
      log(`issue repeat ${body.request_id} -> ${existing.code}`);
      return send(res, 200, { status: 'ok', request_id: body.request_id, code: existing.code });
    }

    if (Math.random() < state.failRate) {
      log(`issue ${body.request_id} -> 500 (chaos)`);
      return send(res, 500, { status: 'error', reason: 'supplier_error' });
    }

    const result = issue(body);
    if (!result) {
      log(`issue ${body.request_id} -> out_of_stock`);
      return send(res, 409, { status: 'error', reason: 'out_of_stock' });
    }

    const payload = { status: 'ok', request_id: body.request_id, code: result.code };
    if (Math.random() < state.timeoutRate) {
      // Ключ уже выдан и привязан к request_id, но ответ «теряется» на hangMs.
      log(`issue ${body.request_id} -> ${result.code}, but hanging ${state.hangMs}ms (chaos)`);
      setTimeout(() => send(res, 200, payload), state.hangMs);
      return;
    }

    log(`issue ${body.request_id} -> ${result.code}`);
    return send(res, 200, payload);
  }

  return send(res, 404, { status: 'error', reason: 'not_found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.message === 'invalid_json' || err.message === 'payload_too_large' ? 400 : 500;
    send(res, status, { status: 'error', reason: err.message });
  });
});

const seeded = seedFromFile();
server.listen(state.port, () => {
  log(`listening on http://localhost:${state.port}`, { seeded, ...stats() });
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
