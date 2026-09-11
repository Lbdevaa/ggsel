/**
 * Поднимает три процесса локально: supplier A, supplier B, API.
 * Без зависимостей. Ctrl+C останавливает всех.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  ['supplier-a', ['suppliers/supplier.js', 'A']],
  ['supplier-b', ['suppliers/supplier.js', 'B']],
  ['api', ['backend/src/server.js']],
].map(([label, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${label} exited with code ${code}`);
      stopAll();
      process.exit(code);
    }
  });
  return child;
});

function stopAll() {
  for (const child of procs) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
