import { setTimeout as sleep } from "node:timers/promises";

const ATTEMPTS = 5;
const TIMEOUT_MS = 30_000;

function waitMs(res, attempt) {
  const after = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 60) * 1000;
  return 1000 * 2 ** (attempt - 1);
}

/**
 * The body of a 2xx answer, at most `max` bytes, retrying network errors, 429 and 5xx. Any other
 * status throws. Text from the server only ever appears JSON-quoted in an error.
 */
export async function fetchBytes(url, max, init = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`${url}: ${JSON.stringify(error.cause?.message ?? error.message)}`);
      await sleep(waitMs(null, attempt));
      continue;
    }
    if (res.ok) return read(url, res, max);
    if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
      await res.body?.cancel();
      await sleep(waitMs(res, attempt));
      continue;
    }
    const text = (await read(url, res, 64 * 1024).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 200);
    throw new Error(`${url} answered ${res.status}${text ? `: ${JSON.stringify(text)}` : ""}`);
  }
}

async function read(url, res, max) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(`${url} sent ${declared} bytes, over the ${max}-byte limit`);
  }
  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader?.read()) ?? { done: true };
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${url} sent more than ${max} bytes`);
    }
    chunks.push(value);
  }
}

export async function fetchJson(url, max, init) {
  const body = await fetchBytes(url, max, init);
  try {
    return { text: body.toString("utf8"), value: JSON.parse(body.toString("utf8")) };
  } catch {
    throw new Error(`${url} did not answer JSON`);
  }
}
