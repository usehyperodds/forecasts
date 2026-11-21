import { createHash } from "node:crypto";

/** A record line's keys, in the order the contract fixes. */
export const KEYS = [
  "id",
  "forecaster",
  "outcome",
  "probabilityBps",
  "acceptedAt",
  "cutoff",
  "fairBps",
  "fairNote",
  "midBps",
  "bookTime",
  "batch",
  "index",
  "size",
  "type",
  "time",
  "nonce",
  "signature",
];

export const MANIFEST_KEYS = ["day", "count", "root", "sha256", "bytes", "closedAt"];

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UINT64_MAX = (1n << 64n) - 1n;

export function sha256(...parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

const LEAF = Buffer.of(0);
const NODE = Buffer.of(1);

function treeHash(leaves, from, to) {
  const n = to - from;
  if (n === 0) return sha256();
  if (n === 1) return sha256(LEAF, leaves[from]);
  let k = 1;
  while (k * 2 < n) k *= 2;
  return sha256(NODE, treeHash(leaves, from, from + k), treeHash(leaves, from + k, to));
}

/** The RFC 6962 Merkle tree hash over the lines' bytes, hex. */
export function merkleRoot(lines) {
  const leaves = lines.map((l) => (typeof l === "string" ? Buffer.from(l, "utf8") : l));
  return treeHash(leaves, 0, leaves.length).toString("hex");
}

export function formatLine(l) {
  return JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, l[k]])));
}

export function isIso(s) {
  return typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
}

export function isDay(s) {
  return typeof s === "string" && DAY.test(s) && isIso(`${s}T00:00:00.000Z`);
}

/** A uint64 as a decimal string without leading zeros. */
export function isUint64String(s) {
  return typeof s === "string" && /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= UINT64_MAX;
}

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const nullOr = (v, test) => v === null || test(v);

/**
 * What is wrong with one parsed line's values, or null. Key order and spacing are checked by the
 * caller against the raw text.
 */
export function lineProblem(l) {
  if (!isInt(l.id, 0, Number.MAX_SAFE_INTEGER)) return `id ${JSON.stringify(l.id)} is not a whole number`;
  if (typeof l.forecaster !== "string" || !/^0x[0-9a-f]{40}$/.test(l.forecaster))
    return `forecaster ${JSON.stringify(l.forecaster)} is not a lowercase address`;
  if (!isInt(l.outcome, 0, 0xffffffff)) return `outcome ${JSON.stringify(l.outcome)} is not a uint32`;
  if (!isInt(l.probabilityBps, 1, 9999))
    return `probabilityBps ${JSON.stringify(l.probabilityBps)} is not an integer from 1 to 9999`;
  if (!isIso(l.acceptedAt)) return `acceptedAt ${JSON.stringify(l.acceptedAt)} is not an ISO 8601 UTC time with milliseconds`;
  if (!isIso(l.cutoff)) return `cutoff ${JSON.stringify(l.cutoff)} is not an ISO 8601 UTC time with milliseconds`;
  if (!nullOr(l.fairBps, (v) => isInt(v, 0, 10000)))
    return `fairBps ${JSON.stringify(l.fairBps)} is neither null nor an integer from 0 to 10000`;
  if (l.fairBps === null && l.fairNote !== "no-line" && l.fairNote !== "low-confidence")
    return `fairBps is null, so fairNote must be "no-line" or "low-confidence", not ${JSON.stringify(l.fairNote)}`;
  if (l.fairBps !== null && l.fairNote !== null) return `fairBps is set, so fairNote must be null, not ${JSON.stringify(l.fairNote)}`;
  if (!nullOr(l.midBps, (v) => isInt(v, 0, 10000)))
    return `midBps ${JSON.stringify(l.midBps)} is neither null nor an integer from 0 to 10000`;
  if (l.midBps === null && l.bookTime !== null) return `midBps is null, so bookTime must be null, not ${JSON.stringify(l.bookTime)}`;
  if (l.midBps !== null && !isIso(l.bookTime))
    return `bookTime ${JSON.stringify(l.bookTime)} is not an ISO 8601 UTC time with milliseconds`;
  if (!isInt(l.batch, 0, Number.MAX_SAFE_INTEGER)) return `batch ${JSON.stringify(l.batch)} is not a whole number`;
  if (l.type === "Forecast") {
    if (l.size !== 1 || l.index !== 0) return `a Forecast has size 1 and index 0, not size ${l.size} and index ${l.index}`;
  } else if (l.type === "ForecastBatch") {
    if (!isInt(l.size, 1, 50)) return `size ${JSON.stringify(l.size)} is not an integer from 1 to 50`;
    if (!isInt(l.index, 0, l.size - 1)) return `index ${JSON.stringify(l.index)} is not from 0 to ${l.size - 1}`;
  } else {
    return `type ${JSON.stringify(l.type)} is neither "Forecast" nor "ForecastBatch"`;
  }
  if (!isInt(l.time, 0, Number.MAX_SAFE_INTEGER)) return `time ${JSON.stringify(l.time)} is not Unix seconds`;
  if (!isUint64String(l.nonce))
    return `nonce ${JSON.stringify(l.nonce)} is not a uint64 as a decimal string without leading zeros`;
  if (typeof l.signature !== "string" || !/^0x[0-9a-f]{130}$/.test(l.signature))
    return "signature is not 65 bytes of lowercase hex";
  return null;
}

/** Where two strings first differ, as a short excerpt of each. */
export function firstDifference(want, got) {
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i++;
  const cut = (s) => JSON.stringify(s.slice(Math.max(0, i - 12), i + 24));
  return `at character ${i + 1}: expected ${cut(want)}, found ${cut(got)}`;
}
