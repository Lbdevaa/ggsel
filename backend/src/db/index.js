/**
 * Подключение к SQLite через встроенный node:sqlite (Node >= 22.13).
 *
 * DatabaseSync выполняет запросы синхронно, поэтому транзакция внутри одного
 * процесса не может перемежаться с другой: это и даёт сериализацию конкурентных
 * записей без внешних блокировок.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');

/**
 * @param {string} [dbPath] путь к файлу БД или ':memory:' для тестов
 * @returns {DatabaseSync}
 */
export function openDb(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  seedPromocodes(db);
  return db;
}

/** Применяет schema.sql. Все выражения идемпотентны. */
export function migrate(db) {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}

/** Загружает промокоды из data/promocodes.json, не трогая уже существующие (счётчики used сохраняются). */
function seedPromocodes(db) {
  const file = path.join(config.dataDir, 'promocodes.json');
  if (!fs.existsSync(file)) return;
  const { promocodes } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const insert = db.prepare(
    'INSERT OR IGNORE INTO promocodes (code, type, value, max_uses) VALUES (?, ?, ?, ?)',
  );
  inTransaction(db, () => {
    for (const p of promocodes) insert.run(p.code, p.type, p.value, p.max_uses);
  });
}

/**
 * Выполняет fn внутри транзакции. Любое исключение откатывает изменения.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function inTransaction(db, fn) {
  // Реентерабельность: вложенный вызов выполняется внутри уже открытой транзакции.
  if (txDepth.get(db)) return fn();
  txDepth.set(db, 1);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
}

/** @type {WeakMap<DatabaseSync, number>} */
const txDepth = new WeakMap();

export const nowIso = () => new Date().toISOString();
