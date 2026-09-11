/**
 * Заглушка поставщика выдачи по контракту из брифа.
 *
 * Запуск: node supplier.js A   (или B). Настройки через env с префиксом SUPPLIER_<NAME>_
 * или общим SUPPLIER_ (см. .env.example). Модуль также экспортирует createSupplier()
 * для интеграционных тестов: та же логика поднимается в процессе на случайном порту.
 *
 * Контракт:
 *   POST /issue   { request_id, sku, order_id } -> 200 { status:'ok', request_id, code }
 *                                              -> 409 { status:'error', reason:'out_of_stock' }
 *                                              -> 500 { status:'error', reason:'supplier_error' }
 *                                              -> зависание на hang_ms (эмуляция таймаута)
 *   POST /restock { keys: [...] } | { count: N }  пополнить пул
 *   POST /chaos   { fail_rate, timeout_rate, hang_ms }  поменять долю сбоев на лету (для гонок)
 *   GET  /stats   { name, total, issued, available, fail_rate, timeout_rate, hang_ms }
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

/**
 * @param {{ name: string, dbPath?: string, keys?: string[], keysFile?: string,
 *           failRate?: number, timeoutRate?: number, hangMs?: number, log?: Function }} options
 */
export function createSupplier(options) {
  const name = options.name.toUpperCase();
  const state = {
    failRate: options.failRate ?? 0,
    timeoutRate: options.timeoutRate ?? 0,
    hangMs: options.hangMs ?? 10000,
  };
  const log = options.log ?? ((...args) => console.log(`[supplier-${name}]`, ...args));

  // ---------- хранилище ----------

  const dbPath = options.dbPath ?? ':memory:';
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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
        const timer = setTimeout(() => send(res, 200, payload), state.hangMs);
        timer.unref?.();
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

  // Начальный пул: явный список ключей или файл.
  let seeded = 0;
  if (options.keys) seeded = addKeys(options.keys);
  else if (options.keysFile && fs.existsSync(options.keysFile)) {
    seeded = addKeys(JSON.parse(fs.readFileSync(options.keysFile, 'utf8')).keys);
  }

  return {
    name,
    server,
    stats,
    addKeys,
    setChaos(next) {
      Object.assign(state, next);
    },
    /** @returns {Promise<number>} фактический порт */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          log(`listening on http://localhost:${server.address().port}`, { seeded, ...stats() });
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      });
    },
  };
}

// ---------- запуск из командной строки ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const name = (process.argv[2] ?? process.env.SUPPLIER_NAME ?? 'A').toUpperCase();
  const env = (key, fallback) =>
    process.env[`SUPPLIER_${name}_${key}`] ?? process.env[`SUPPLIER_${key}`] ?? fallback;
  const lower = name.toLowerCase();

  const supplier = createSupplier({
    name,
    dbPath: path.resolve(here, env('DB_PATH', `data/supplier-${lower}.sqlite`)),
    keysFile: path.resolve(here, env('KEYS_FILE', `data/keys-${lower}.json`)),
    failRate: Number(env('FAIL_RATE', 0)),
    timeoutRate: Number(env('TIMEOUT_RATE', 0)),
    hangMs: Number(env('HANG_MS', 10000)),
  });

  supplier.listen(Number(env('PORT', name === 'A' ? 4001 : 4002))).catch((err) => {
    console.error(`[supplier-${name}] failed to start: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => supplier.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
