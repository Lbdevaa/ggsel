/**
 * HTTP-клиент поставщика выдачи.
 *
 * Главное правило: таймаут не равен отказу. Поставщик мог выдать код, а ответ потеряться,
 * поэтому повтор всегда идёт с тем же request_id, и поставщик обязан вернуть тот же код.
 */

/**
 * @typedef {{ kind: 'ok', code: string }
 *         | { kind: 'error', reason: string, httpStatus: number }
 *         | { kind: 'timeout' | 'network', reason: string }} IssueResult
 */

/**
 * Один запрос POST /issue.
 * @param {string} baseUrl
 * @param {{ request_id: string, sku: string, order_id: string }} body
 * @param {{ timeoutMs: number }} opts
 * @returns {Promise<IssueResult>}
 */
export async function issueOnce(baseUrl, body, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'ok' && typeof data.code === 'string') {
      return { kind: 'ok', code: data.code };
    }
    return { kind: 'error', reason: data.reason ?? `http_${res.status}`, httpStatus: res.status };
  } catch (err) {
    const kind = err?.name === 'AbortError' ? 'timeout' : 'network';
    return { kind, reason: err?.cause?.code ?? err?.message ?? kind };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Повторяет запрос с тем же request_id, пока ответ неопределённый (таймаут или сетевая ошибка).
 * Явный ответ поставщика (ok или 4xx/5xx с телом) возвращается сразу.
 *
 * @param {string} baseUrl
 * @param {{ request_id: string, sku: string, order_id: string }} body
 * @param {{ timeoutMs: number, maxRetries: number, backoffMs?: number, onAttempt?: (info: object) => void }} opts
 * @returns {Promise<IssueResult & { attempts: number }>}
 */
export async function issueWithRetries(baseUrl, body, { timeoutMs, maxRetries, backoffMs = 200, onAttempt }) {
  let last;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    last = await issueOnce(baseUrl, body, { timeoutMs });
    onAttempt?.({ attempt, request_id: body.request_id, ...last });
    if (last.kind === 'ok' || last.kind === 'error') return { ...last, attempts: attempt };
    if (attempt < maxRetries) await sleep(backoffMs * attempt);
  }
  return { ...last, attempts: maxRetries };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
