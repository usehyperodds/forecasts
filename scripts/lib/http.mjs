import { setTimeout as sleep } from "node:timers/promises";

const ATTEMPTS = 5;
const TIMEOUT_MS = 30_000;

function waitMs(res, attempt) {
  const after = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after, 60) * 1000;
  return 1000 * 2 ** (attempt - 1);
}

/** fetch with a timeout, retrying network errors, 429 and 5xx; any other non-2xx throws. */
export async function request(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`${url}: ${error.cause?.message ?? error.message}`);
      await sleep(waitMs(null, attempt));
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) {
      await res.body?.cancel();
      await sleep(waitMs(res, attempt));
      continue;
    }
    const text = (await res.text()).slice(0, 200);
    throw new Error(`${url} answered ${res.status}${text ? `: ${text}` : ""}`);
  }
}

export async function bytes(url) {
  return Buffer.from(await (await request(url)).arrayBuffer());
}
