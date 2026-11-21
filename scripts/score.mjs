#!/usr/bin/env node
// Rebuilds the board from the verified records and Hyperliquid's settlements, and writes board.json.
// Settled outcomes are kept in settlements.json and never asked again.
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { request } from "./lib/http.mjs";
import { firstDifference } from "./lib/record.mjs";
import { board as buildBoard, outcomeBps } from "./lib/score.mjs";
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
// Hyperliquid's public info endpoint allows about 60 of these a minute from one address.
const PACE_MS = custom ? 0 : 1000;
const PAGE = 200;

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
  const cache = JSON.parse(text);
  for (const [outcome, fraction] of Object.entries(cache))
    if (!/^\d+$/.test(outcome) || outcomeBps(fraction) === null)
      throw new Error(`settlements.json: outcome ${outcome} has ${JSON.stringify(fraction)}, not a settle fraction`);
  return cache;
}

/** Hyperliquid's settleFraction for an outcome, or null while it is unsettled. */
async function settleFraction(outcome) {
  const res = await request(info, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "settledOutcome", outcome }),
  });
  const answer = await res.json();
  if (answer === null) return null;
  if (answer.spec?.outcome !== undefined && answer.spec.outcome !== outcome)
    throw new Error(`settledOutcome ${outcome} answered for outcome ${answer.spec.outcome}`);
  if (typeof answer.settleFraction !== "string")
    throw new Error(`settledOutcome ${outcome} has no settleFraction: ${JSON.stringify(answer).slice(0, 200)}`);
  return answer.settleFraction;
}

async function settle(outcomes, cache) {
  const asked = { settled: 0, open: 0 };
  for (const outcome of outcomes) {
    const held = cache[outcome];
    if (held !== undefined && !values.refetch) continue;
    if (asked.settled + asked.open > 0) await sleep(PACE_MS);
    const fraction = await settleFraction(outcome);
    if (fraction === null) {
      if (held !== undefined) throw new Error(`settlements.json has outcome ${outcome} settled at ${held}; Hyperliquid answers null`);
      asked.open++;
      continue;
    }
    if (held !== undefined && held !== fraction)
      throw new Error(`settlements.json has outcome ${outcome} settled at ${held}; Hyperliquid answers ${fraction}`);
    if (outcomeBps(fraction) === null) {
      console.warn(`outcome ${outcome}: settleFraction ${JSON.stringify(fraction)} is not a decimal from 0 to 1; left unsettled`);
      asked.open++;
      continue;
    }
    cache[outcome] = fraction;
    asked.settled++;
  }
  return asked;
}

function differences(ours, theirs, path = "", out = []) {
  if (out.length >= 20 || isDeepStrictEqual(ours, theirs)) return out;
  const object = (v) => v !== null && typeof v === "object";
  if (!object(ours) || !object(theirs) || Array.isArray(ours) !== Array.isArray(theirs)) {
    out.push(`${path || "(board)"}: api ${JSON.stringify(theirs)}, rebuilt ${JSON.stringify(ours)}`);
    return out;
  }
  const keys = Array.isArray(ours)
    ? [...Array(Math.max(ours.length, theirs.length)).keys()]
    : [...new Set([...Object.keys(theirs), ...Object.keys(ours)])];
  for (const k of keys) differences(ours[k], theirs[k], Array.isArray(ours) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
  return out;
}

/**
 * Asks the API for every page of its board and checks each answer, byte for byte, against the same
 * page of the rebuilt board. `asOf` is when the API computed its copy, so it is shown, not compared.
 */
async function compare(url, rebuilt) {
  const target = new URL(url);
  if (!target.pathname.endsWith("/forecasts/board"))
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/forecasts/board`;
  let failed = false;
  let total = rebuilt.total;
  for (let offset = 0, page = 0; offset === 0 || offset < total; offset += PAGE, page++) {
    target.searchParams.set("limit", String(PAGE));
    target.searchParams.set("offset", String(offset));
    const text = await (await request(target)).text();
    const theirs = JSON.parse(text);
    total = Math.max(total, theirs.total ?? 0);
    if (page === 0) console.log(`api asOf ${theirs.asOf}, rebuilt asOf ${rebuilt.asOf} (not compared)`);
    const ours = JSON.stringify({ ...rebuilt, asOf: theirs.asOf, rows: rebuilt.rows.slice(offset, offset + PAGE) });
    if (ours === text) {
      console.log(`page offset=${offset}: ${theirs.rows?.length ?? 0} rows, ${Buffer.byteLength(text)} bytes, identical`);
      continue;
    }
    failed = true;
    const list = differences(JSON.parse(ours), theirs);
    console.error(`page offset=${offset} differs:`);
    if (list.length === 0) console.error(`  same values, different bytes ${firstDifference(ours, text)}`);
    for (const d of list) console.error(`  ${d}`);
  }
  return !failed;
}

let verified;
try {
  verified = verifyRecords(await loadRecords(join(root, "records")));
} catch (error) {
  console.error(`FAIL ${error.message}; the board was not rebuilt`);
  process.exit(1);
}

const cachePath = join(root, "settlements.json");
const cache = await readCache(cachePath);
const outcomes = [...new Set(verified.flatMap((d) => d.lines.map((l) => l.outcome)))].sort((a, b) => a - b);
if (!values.offline) {
  try {
    const asked = await settle(outcomes, cache);
    console.log(`asked Hyperliquid about ${asked.settled + asked.open} outcomes: ${asked.settled} settled, ${asked.open} not yet`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  }
  await writeJson(cachePath, cache);
}

const results = new Map(Object.entries(cache).map(([o, f]) => [Number(o), outcomeBps(f)]));
const rebuilt = buildBoard(verified, results);
await writeJson(join(root, "board.json"), rebuilt);
const settled = outcomes.filter((o) => results.has(o)).length;
console.log(
  `board.json: ${rebuilt.total} forecasters, ${outcomes.length} outcomes (${settled} settled), through ${rebuilt.through ?? "no record yet"}`,
);

if (values.compare) {
  let same;
  try {
    same = await compare(values.compare, rebuilt);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  }
  if (!same) {
    console.error(`FAIL the rebuilt board differs from ${values.compare}`);
    process.exit(1);
  }
}
