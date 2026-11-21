#!/usr/bin/env node
// Rebuilds board.json from the verified records and Hyperliquid's settlements, kept in
// settlements.json. Hyperliquid is asked about unsettled outcomes, and again about those in the
// newest records. --compare exits 1 when the API's board differs, and 3 when the only cause is that
// the two boards used different settlements.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fetchJson } from "./lib/http.mjs";
import { firstDifference } from "./lib/record.mjs";
import { board as buildBoard, outcomeBps, outcomesToAsk } from "./lib/score.mjs";
import { loadRecords, verifyRecords } from "./lib/verify.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    hl: { type: "string" },
    offline: { type: "boolean", default: false },
    refetch: { type: "boolean", default: false },
    compare: { type: "string" },
  },
});
const root = resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
const custom = values.hl ?? process.env.HL_INFO_URL;
const info = custom ?? "https://api.hyperliquid.xyz/info";
// Hyperliquid's public info endpoint allows about 60 of these a minute from one address. A custom
// endpoint (a mirror, a test server) is not paced.
const PACE_MS = custom ? 0 : 1000;
const PAGE = 200;
const ANSWER_MAX = 1024 * 1024;
const BOARD_PAGE_MAX = 8 * 1024 * 1024;
const SETTLEMENTS_DIFFER = 3;
const q = JSON.stringify;

function fail(message, code = 1) {
  console.error(`FAIL ${message}`);
  process.exit(code);
}

async function writeJson(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function readCache(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  let cache;
  try {
    cache = JSON.parse(text);
  } catch {
    throw new Error("settlements.json is not JSON");
  }
  for (const [outcome, fraction] of Object.entries(cache))
    if (!/^(0|[1-9]\d*)$/.test(outcome) || outcomeBps(fraction) === null)
      throw new Error(`settlements.json: outcome ${q(outcome)} has ${q(fraction)}, not a settle fraction`);
  return cache;
}

/** Hyperliquid's settleFraction for an outcome, or null while it is unsettled. */
async function settleFraction(outcome) {
  const { value } = await fetchJson(info, ANSWER_MAX, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "settledOutcome", outcome }),
  });
  if (value === null) return null;
  if (value?.spec?.outcome !== outcome)
    throw new Error(`settledOutcome ${outcome} answered for outcome ${q(value?.spec?.outcome)}`);
  if (typeof value.settleFraction !== "string") throw new Error(`settledOutcome ${outcome} has no settleFraction`);
  return value.settleFraction;
}

async function settle(days, cache) {
  const { ask } = outcomesToAsk(days, cache, { refetch: values.refetch });
  const counts = { settled: 0, confirmed: 0, open: 0 };
  for (const [i, outcome] of ask.entries()) {
    if (i > 0) await sleep(PACE_MS);
    const held = cache[outcome];
    const fraction = await settleFraction(outcome);
    if (fraction === null) {
      if (held !== undefined) throw new Error(`settlements.json has outcome ${outcome} settled at ${q(held)}; Hyperliquid now answers null`);
      counts.open++;
      continue;
    }
    if (held !== undefined && held !== fraction)
      throw new Error(`settlements.json has outcome ${outcome} settled at ${q(held)}; Hyperliquid now answers ${q(fraction)}`);
    if (outcomeBps(fraction) === null) {
      console.warn(`outcome ${outcome}: settleFraction ${q(fraction)} is not 0, 1 or a decimal between them; left unsettled`);
      counts.open++;
      continue;
    }
    if (held === undefined) counts.settled++;
    else counts.confirmed++;
    cache[outcome] = fraction;
  }
  return { asked: ask.length, ...counts };
}

const segment = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${q(k)}]`);

function differences(ours, theirs, path = "", out = []) {
  if (out.length >= 20 || isDeepStrictEqual(ours, theirs)) return out;
  const object = (v) => v !== null && typeof v === "object";
  if (!object(ours) || !object(theirs) || Array.isArray(ours) !== Array.isArray(theirs)) {
    out.push(`${path.replace(/^\./, "") || "(board)"}: api ${q(theirs)}, rebuilt ${q(ours)}`);
    return out;
  }
  const keys = Array.isArray(ours)
    ? [...Array(Math.max(ours.length, theirs.length)).keys()]
    : [...new Set([...Object.keys(theirs), ...Object.keys(ours)])];
  for (const k of keys) differences(ours[k], theirs[k], Array.isArray(ours) ? `${path}[${k}]` : `${path}${segment(k)}`, out);
  return out;
}

/**
 * Boards built from different settlements differ for that reason alone, so a different
 * settlementsRoot is reported in place of the rows it explains.
 */
async function compare(url, rebuilt) {
  const target = new URL(url);
  if (!target.pathname.endsWith("/forecasts/board"))
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/forecasts/board`;
  let total = rebuilt.total;
  for (let offset = 0; offset === 0 || offset < total; offset += PAGE) {
    target.searchParams.set("limit", String(PAGE));
    target.searchParams.set("offset", String(offset));
    const { text, value: theirs } = await fetchJson(target, BOARD_PAGE_MAX);
    total = Math.max(total, Number.isSafeInteger(theirs?.total) ? theirs.total : 0);
    const ours = JSON.stringify({ ...rebuilt, rows: rebuilt.rows.slice(offset, offset + PAGE) });
    if (ours === text) {
      console.log(`page offset=${offset}: ${rebuilt.rows.slice(offset, offset + PAGE).length} rows, ${Buffer.byteLength(text)} bytes, identical`);
      continue;
    }
    if (theirs?.settlementsRoot !== rebuilt.settlementsRoot) {
      console.error(
        `the API scored ${q(theirs?.settled)} settlements (settlementsRoot ${q(theirs?.settlementsRoot)}); this rebuild scored ${rebuilt.settled} (settlementsRoot ${q(rebuilt.settlementsRoot)}). The boards were built from different settlements.`,
      );
      return "settlements";
    }
    const list = differences(JSON.parse(ours), theirs);
    console.error(`page offset=${offset} differs:`);
    if (list.length === 0) console.error(`  same values, different bytes ${firstDifference(ours, text)}`);
    for (const d of list) console.error(`  ${d}`);
    return "differs";
  }
  return "same";
}

let verified;
let cache;
const cachePath = join(root, "settlements.json");
try {
  verified = verifyRecords(await loadRecords(join(root, "records")));
  cache = await readCache(cachePath);
} catch (error) {
  fail(`${error.message}; the board was not rebuilt`);
}

if (!values.offline) {
  try {
    const c = await settle(verified, cache);
    console.log(
      `asked Hyperliquid about ${c.asked} ${c.asked === 1 ? "outcome" : "outcomes"}: ${c.settled} newly settled, ${c.confirmed} confirmed, ${c.open} not yet`,
    );
  } catch (error) {
    fail(error.message);
  }
  await writeJson(cachePath, cache);
}

const rebuilt = buildBoard(verified, new Map(Object.entries(cache).map(([o, f]) => [Number(o), f])));
await writeJson(join(root, "board.json"), rebuilt);
const outcomes = new Set(verified.flatMap((d) => d.lines.map((l) => l.outcome))).size;
console.log(
  `board.json: ${rebuilt.total} forecasters, ${outcomes} outcomes (${rebuilt.settled} settled, settlementsRoot ${rebuilt.settlementsRoot}), through ${rebuilt.through ?? "no record yet"}`,
);

if (values.compare) {
  let result;
  try {
    result = await compare(values.compare, rebuilt);
  } catch (error) {
    fail(error.message);
  }
  if (result === "settlements")
    fail(`the board at ${values.compare} was built from different settlements`, SETTLEMENTS_DIFFER);
  if (result === "differs") fail(`the rebuilt board differs from ${values.compare}`);
}
