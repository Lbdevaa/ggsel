/**
 * Фоновый воркер выдачи. Опрашивает очередь, захватывает задачи через CAS,
 * обрабатывает до `concurrency` задач параллельно.
 */

/**
 * @param {{ delivery: ReturnType<import('../services/delivery.js').deliveryService>, intervalMs?: number, concurrency?: number, log?: Function }} deps
 */
export function startDeliveryWorker({ delivery, intervalMs = 250, concurrency = 4, log = console.log }) {
  const requeued = delivery.resetRunningJobs();
  if (requeued) log(`[worker] requeued ${requeued} job(s) left running after restart`);

  let inFlight = 0;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    while (inFlight < concurrency) {
      const job = delivery.claimJob();
      if (!job) break;
      inFlight += 1;
      delivery
        .process(job)
        .catch((err) => log(`[worker] job ${job.id} crashed: ${err?.stack ?? err}`))
        .finally(() => {
          inFlight -= 1;
        });
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    /** Немедленно проверить очередь, не дожидаясь интервала. */
    kick: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
