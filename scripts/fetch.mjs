#!/usr/bin/env node
// Mirrors the daily records this copy is missing from the Hyperodds API. New days are written only
// after the whole record, old and new, verifies; a day already here is never rewritten.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bytes } from "./lib/http.mjs";
import { isDay, MANIFEST_KEYS } from "./lib/record.mjs";
import { loadRecords, verifyRecords } from "./lib/verify.mjs";

const { values } = parseArgs({ options: { api: { type: "string" }, root: { type: "string" } } });
const api = (values.api ?? process.env.HYPERODDS_API ?? "https://api.usehyperodds.com").replace(/\/+$/, "");
const root = resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
const dir = join(root, "records");

function parse(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

async function plan() {
  const local = await loadRecords(dir);
  const index = await bytes(`${api}/forecasts/records`);
  const remote = parse(index);
  if (!Array.isArray(remote?.days)) throw new Error(`${api}/forecasts/records is not { "days": [...] }`);
  const listed = new Map();
  for (const entry of remote.days) {
    if (!isDay(entry?.day)) throw new Error(`${api}/forecasts/records lists ${JSON.stringify(entry?.day)}, which is not a day`);
    listed.set(entry.day, entry);
  }
  for (const [day, files] of local.days) {
    const entry = listed.get(day);
    if (!entry) throw new Error(`the API no longer lists ${day}, which this copy holds`);
    const held = files.manifest && parse(files.manifest);
    if (!held) continue;
    for (const k of MANIFEST_KEYS)
      if (entry[k] !== held[k])
        throw new Error(
          `the API now gives ${day} ${k} ${JSON.stringify(entry[k])}, but this copy holds ${JSON.stringify(held[k])}; a closed record never changes`,
        );
  }
  const fetched = new Map();
  for (const day of [...listed.keys()].filter((d) => !local.days.has(d)).sort())
    fetched.set(day, {
      jsonl: await bytes(`${api}/forecasts/records/${day}.jsonl`),
      manifest: await bytes(`${api}/forecasts/records/${day}.json`),
    });
  const verified = verifyRecords({ index, days: new Map([...local.days, ...fetched]) });
  return { index, fetched, verified };
}

let result;
try {
  result = await plan();
} catch (error) {
  console.error(`FAIL ${error.message}; nothing was written`);
  process.exit(1);
}

const { index, fetched, verified } = result;
await mkdir(dir, { recursive: true });
for (const [day, files] of fetched) {
  await writeFile(join(dir, `${day}.jsonl`), files.jsonl, { flag: "wx" });
  await writeFile(join(dir, `${day}.json`), files.manifest, { flag: "wx" });
}
const tmp = join(dir, ".index.json.tmp");
await writeFile(tmp, index);
await rename(tmp, join(dir, "index.json"));

for (const d of verified.filter((v) => fetched.has(v.day)))
  console.log(`added ${d.day}  ${d.lines.length} forecasts, root ${d.manifest.root}`);
console.log(fetched.size === 0 ? `up to date, ${verified.length} days` : `${verified.length} days in the record`);
