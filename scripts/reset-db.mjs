/**
 * Удаляет файлы SQLite API и поставщиков. При следующем старте схема и пулы
 * создаются заново. Запускать при остановленных процессах.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  process.env.DB_PATH ?? 'backend/data/app.sqlite',
  'suppliers/data/supplier-a.sqlite',
  'suppliers/data/supplier-b.sqlite',
];

let removed = 0;
for (const target of targets) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.resolve(root, target + suffix);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed += 1;
      console.log(`removed ${path.relative(root, file)}`);
    }
  }
}
console.log(removed ? `done, ${removed} file(s) removed` : 'nothing to remove');
