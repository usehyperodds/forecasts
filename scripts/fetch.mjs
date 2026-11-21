#!/usr/bin/env node
// Mirrors the daily records this copy lacks from the Hyperodds API. A new day is written only once
// the whole record, old days and new, verifies, and a day already held is never rewritten.
// --recheck <days>|all fetches the newest held days again and stops on any changed byte.
import { link, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cliArgs, usageError } from "./lib/cli.mjs";
import { fetchBytes } from "./lib/http.mjs";
import { isDay, MANIFEST_KEYS, sha256 } from "./lib/record.mjs";
import { loadRecords, verifyRecords } from "./lib/verify.mjs";

const USAGE = `usage: node scripts/fetch.mjs [--api <url>] [--root <dir>] [--recheck <days>|all]

Mirrors the daily records this copy lacks from the Hyperodds API. New days are written only once the
whole record verifies; a day already held is never rewritten.

  --api <url>            the API (default: $HYPERODDS_API, else https://api.usehyperodds.com)
  --root <dir>           the directory holding records/ (default: this repository)
  --recheck <days>|all   fetch that many of the newest held days again, or all, and stop on any changed byte
  -h, --help             print this help`;

const { values } = cliArgs(USAGE, { api: { type: "string" }, root: { type: "string" }, recheck: { type: "string" } });
if (values.recheck !== undefined && !/^([1-9]\d*|all)$/.test(values.recheck))
  usageError(USAGE, `--recheck takes a number of days or all, not ${JSON.stringify(values.recheck)}`);
const api = (values.api ?? process.env.HYPERODDS_API ?? "https://api.usehyperodds.com").replace(/\/+$/, "");
const root = resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
const dir = join(root, "records");
const INDEX_MAX = 16 * 1024 * 1024;
const MANIFEST_MAX = 64 * 1024;
const RECORD_MAX = 256 * 1024 * 1024;
// The API serves each address 10 reads a second.
const PACE_MS = 100;
const q = JSON.stringify;

let requests = 0;
async function get(path, max) {
  if (requests++ > 0) await sleep(PACE_MS);
  return fetchBytes(`${api}${path}`, max);
}

function parse(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

const hash = (buf) => sha256(buf).toString("hex");

function same(name, held, served) {
  if (!held.equals(served))
    throw new Error(
      `the API now serves ${name} with sha256 ${hash(served)}, but this copy holds sha256 ${hash(held)}; a closed record never changes`,
    );
}

async function dayFiles(day) {
  return {
    jsonl: await get(`/forecasts/records/${day}.jsonl`, RECORD_MAX),
    manifest: await get(`/forecasts/records/${day}.json`, MANIFEST_MAX),
  };
}

/** Built from the verified manifests, so it lists only what verified, whatever the API's index says. */
function buildIndex(verified) {
  const days = verified
    .map((d) => ({ ...Object.fromEntries(MANIFEST_KEYS.map((k) => [k, d.manifest[k]])), url: `${api}/forecasts/records/${d.day}.jsonl` }))
    .reverse();
  return Buffer.from(`${JSON.stringify({ days }, null, 2)}\n`);
}

async function plan() {
  const local = await loadRecords(dir);
  const remoteIndex = await get("/forecasts/records", INDEX_MAX);
  const remote = parse(remoteIndex);
  if (!Array.isArray(remote?.days)) throw new Error(`${api}/forecasts/records is not { "days": [...] }`);
  const listed = new Map();
  for (const entry of remote.days) {
    if (!isDay(entry?.day)) throw new Error(`${api}/forecasts/records lists ${q(entry?.day)}, which is not a day`);
    listed.set(entry.day, entry);
  }
  // A day with one of its two files is what a run that stopped midway leaves: it is completed.
  const partial = new Set([...local.days].filter(([, f]) => !f.jsonl || !f.manifest).map(([day]) => day));
  for (const [day, files] of local.days) {
    const entry = listed.get(day);
    if (!entry) throw new Error(`the API no longer lists ${day}, which this copy holds`);
    const held = files.manifest && parse(files.manifest);
    if (!held) continue;
    for (const k of MANIFEST_KEYS)
      if (entry[k] !== held[k])
        throw new Error(`the API now gives ${day} ${k} ${q(entry[k])}, but this copy holds ${q(held[k])}; a closed record never changes`);
  }
  const newest = [...local.days.keys()].sort().at(-1);
  const fetched = new Map();
  for (const day of [...listed.keys()].sort()) {
    if (local.days.has(day) && !partial.has(day)) continue;
    if (!partial.has(day) && newest !== undefined && day < newest)
      throw new Error(`the API lists ${day}, which this copy lacks though it holds the later ${newest}; a day is never added after a later one`);
    const files = await dayFiles(day);
    for (const kind of ["jsonl", "manifest"]) {
      const held = local.days.get(day)?.[kind];
      if (held) same(`records/${day}.${kind === "jsonl" ? "jsonl" : "json"}`, held, files[kind]);
    }
    fetched.set(day, files);
  }
  const held = [...local.days.keys()].filter((d) => !partial.has(d)).sort();
  const recheck = values.recheck === undefined ? [] : values.recheck === "all" ? held : held.slice(-Number(values.recheck));
  let rechecked = 0;
  for (const day of recheck) {
    const files = local.days.get(day);
    const served = await dayFiles(day);
    same(`records/${day}.jsonl`, files.jsonl, served.jsonl);
    same(`records/${day}.json`, files.manifest, served.manifest);
    rechecked++;
  }
  const days = new Map([...local.days, ...fetched]);
  const verified = verifyRecords({ index: remoteIndex, days });
  const index = buildIndex(verified);
  verifyRecords({ index, days });
  return { local, fetched, verified, index, rechecked };
}

/** Writes a file that must not exist yet: a temp file linked into place, so no reader sees half of it. */
async function writeNew(path, bytes) {
  const tmp = join(dir, `.${path.split("/").at(-1)}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  try {
    await link(tmp, path);
  } finally {
    await unlink(tmp);
  }
}

let result;
try {
  result = await plan();
} catch (error) {
  console.error(`FAIL ${error.message}; nothing was written`);
  process.exit(1);
}

const { local, fetched, verified, index, rechecked } = result;
await mkdir(dir, { recursive: true });
for (const name of await readdir(dir)) if (/^\..+\.tmp$/.test(name)) await unlink(join(dir, name));
for (const [day, files] of fetched) {
  const held = local.days.get(day) ?? {};
  if (!held.jsonl) await writeNew(join(dir, `${day}.jsonl`), files.jsonl);
  if (!held.manifest) await writeNew(join(dir, `${day}.json`), files.manifest);
}
const tmp = join(dir, `.index.json.${process.pid}.tmp`);
await writeFile(tmp, index);
await rename(tmp, join(dir, "index.json"));

for (const d of verified.filter((v) => fetched.has(v.day)))
  console.log(`added ${d.day}  ${d.lines.length} forecasts, root ${d.manifest.root}`);
if (values.recheck !== undefined) console.log(`rechecked ${rechecked} held ${rechecked === 1 ? "day" : "days"} against the API: unchanged`);
const days = `${verified.length} ${verified.length === 1 ? "day" : "days"}`;
console.log(fetched.size === 0 ? `up to date, ${days}` : `${days} in the record`);
