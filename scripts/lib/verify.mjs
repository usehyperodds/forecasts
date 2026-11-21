import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, recover } from "./eip712.mjs";
import {
  firstDifference,
  formatLine,
  isDay,
  isIso,
  KEYS,
  lineProblem,
  MANIFEST_KEYS,
  merkleRoot,
  sha256,
} from "./record.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A day's record closes at 00:05 UTC the next day. */
const CLOSE_AFTER_MS = DAY_MS + 5 * 60_000;
/** The server refuses a signed time more than this far ahead of its clock. */
const TIME_AHEAD_S = 120;
const BATCH_FIELDS = ["forecaster", "type", "size", "time", "nonce", "signature"];

export class RecordError extends Error {
  /** `lines` is one line number, a list of them, or null for the file as a whole. */
  constructor(where, detail, lines = null) {
    const list = lines === null ? [] : [lines].flat();
    const at = list.length === 0 ? "" : list.length === 1 ? `, line ${list[0]}` : `, lines ${list.join(", ")}`;
    super(`${where}${at}: ${detail}`);
    this.where = where;
    this.lines = list;
    this.detail = detail;
  }
}

/** What is under records/: index.json's bytes (null when absent) and each day's record and manifest. */
export async function loadRecords(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { index: null, days: new Map() };
    throw error;
  }
  const days = new Map();
  let index = null;
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    if (name === "index.json") {
      index = await readFile(join(dir, name));
      continue;
    }
    const m = /^(\d{4}-\d{2}-\d{2})\.(jsonl|json)$/.exec(name);
    if (!m) throw new RecordError(`records/${name}`, "is not part of the record");
    const files = days.get(m[1]) ?? {};
    files[m[2] === "jsonl" ? "jsonl" : "manifest"] = await readFile(join(dir, name));
    days.set(m[1], files);
  }
  return { index, days };
}

function json(where, bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new RecordError(where, `is not JSON (${error.message})`);
  }
}

const q = JSON.stringify;
const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v > 0;

function manifestProblem(m, keys) {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return "is not a JSON object";
  const missing = keys.filter((k) => !Object.hasOwn(m, k));
  if (missing.length > 0) return `has no ${missing.map((k) => q(k)).join(", ")}`;
  const extra = Object.keys(m).filter((k) => !keys.includes(k));
  if (extra.length > 0) return `has unexpected ${extra.map((k) => q(k)).join(", ")}`;
  if (!isDay(m.day)) return `day ${q(m.day)} is not a date`;
  if (!isCount(m.count)) return `count ${q(m.count)} is not a positive whole number`;
  if (!isHash(m.root)) return `root ${q(m.root)} is not 32 bytes of lowercase hex`;
  if (!isHash(m.sha256)) return `sha256 ${q(m.sha256)} is not 32 bytes of lowercase hex`;
  if (!isCount(m.bytes)) return `bytes ${q(m.bytes)} is not a positive whole number`;
  if (!isIso(m.closedAt)) return `closedAt ${q(m.closedAt)} is not an ISO 8601 UTC time with milliseconds`;
  return null;
}

/** index.json's entries by day, after checking it lists exactly the days on disk, newest first. */
function checkIndex(bytes, days) {
  const entries = new Map();
  if (bytes === null) {
    if (days.size === 0) return entries;
    throw new RecordError("records/index.json", "is missing");
  }
  const index = json("records/index.json", bytes);
  if (index === null || typeof index !== "object" || !Array.isArray(index.days))
    throw new RecordError("records/index.json", 'is not { "days": [...] }');
  let newer = null;
  index.days.forEach((entry, i) => {
    const problem = manifestProblem(entry, [...MANIFEST_KEYS, "url"]);
    if (problem) throw new RecordError("records/index.json", `days[${i}] ${problem}`);
    if (typeof entry.url !== "string") throw new RecordError("records/index.json", `days[${i}].url is not a string`);
    if (newer !== null && entry.day >= newer)
      throw new RecordError("records/index.json", `${entry.day} comes after ${newer}; days are listed newest first, once each`);
    newer = entry.day;
    entries.set(entry.day, entry);
  });
  for (const day of entries.keys())
    if (!days.has(day)) throw new RecordError("records/index.json", `lists ${day}, but records/${day}.jsonl is missing`);
  for (const day of days.keys())
    if (!entries.has(day)) throw new RecordError(`records/${day}`, "is not listed in records/index.json");
  return entries;
}

function checkManifest(day, files, entry) {
  if (!files.jsonl) throw new RecordError(day, `records/${day}.jsonl is missing`);
  if (!files.manifest) throw new RecordError(day, `records/${day}.json is missing`);
  const manifest = json(`records/${day}.json`, files.manifest);
  const problem = manifestProblem(manifest, MANIFEST_KEYS);
  if (problem) throw new RecordError(`records/${day}.json`, problem);
  if (manifest.day !== day) throw new RecordError(`records/${day}.json`, `names day ${manifest.day}`);
  for (const k of MANIFEST_KEYS)
    if (manifest[k] !== entry[k])
      throw new RecordError(day, `index.json gives ${k} ${q(entry[k])}, but ${day}.json gives ${q(manifest[k])}`);
  const due = Date.parse(`${day}T00:00:00.000Z`) + CLOSE_AFTER_MS;
  if (Date.parse(manifest.closedAt) < due)
    throw new RecordError(day, `closed at ${manifest.closedAt}, before ${new Date(due).toISOString()}`);
  return manifest;
}

function checkLine(day, text, n, prev) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (error) {
    throw new RecordError(day, `is not JSON (${error.message})`, n);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new RecordError(day, "is not a JSON object", n);
  const keys = Object.keys(v);
  const missing = KEYS.filter((k) => !Object.hasOwn(v, k));
  if (missing.length > 0) throw new RecordError(day, `has no ${missing.map((k) => q(k)).join(", ")}`, n);
  const extra = keys.filter((k) => !KEYS.includes(k));
  if (extra.length > 0) throw new RecordError(day, `has unexpected ${extra.map((k) => q(k)).join(", ")}`, n);
  const at = keys.findIndex((k, i) => k !== KEYS[i]);
  if (at >= 0)
    throw new RecordError(day, `key ${at + 1} is ${q(keys[at])}; the contract puts ${q(KEYS[at])} there`, n);
  const problem = lineProblem(v);
  if (problem) throw new RecordError(day, problem, n);
  const canonical = formatLine(v);
  if (canonical !== text) throw new RecordError(day, `is not in the record's format ${firstDifference(canonical, text)}`, n);
  if (prev && v.id <= prev.v.id) throw new RecordError(day, `id ${v.id} follows id ${prev.v.id}; lines are sorted by id`, n);
  if (v.cutoff.slice(0, 10) !== day) throw new RecordError(day, `cutoff ${v.cutoff} is not on ${day}`, n);
  const close = Date.parse(v.cutoff) - HOUR_MS;
  if (Date.parse(v.acceptedAt) >= close)
    throw new RecordError(day, `accepted at ${v.acceptedAt}, after entries closed at ${new Date(close).toISOString()}`, n);
  if (v.time > Math.floor(Date.parse(v.acceptedAt) / 1000) + TIME_AHEAD_S)
    throw new RecordError(day, `signed time ${v.time} is more than ${TIME_AHEAD_S} s after acceptedAt ${v.acceptedAt}`, n);
  return { n, v };
}

function messageOf(group) {
  const [{ v }] = group;
  if (v.type === "Forecast")
    return { forecaster: v.forecaster, outcome: v.outcome, probabilityBps: v.probabilityBps, time: v.time, nonce: v.nonce };
  return {
    forecaster: v.forecaster,
    forecasts: group.map(({ v: e }) => ({ outcome: e.outcome, probabilityBps: e.probabilityBps })),
    time: v.time,
    nonce: v.nonce,
  };
}

function checkBatches(day, lines, seen) {
  const groups = new Map();
  for (const l of lines) {
    const group = groups.get(l.v.batch);
    if (group) group.push(l);
    else groups.set(l.v.batch, [l]);
  }
  for (const [batch, group] of groups) {
    const [first] = group;
    const at = group.map((l) => l.n);
    const elsewhere = seen.batches.get(batch);
    if (elsewhere) throw new RecordError(day, `batch ${batch} is also in ${elsewhere}; a batch is published whole, in one record`, at);
    seen.batches.set(batch, day);
    for (const l of group)
      for (const k of BATCH_FIELDS)
        if (l.v[k] !== first.v[k])
          throw new RecordError(day, `batch ${batch} has ${k} ${q(l.v[k])} here and ${q(first.v[k])} on line ${first.n}`, l.n);
    const byIndex = new Array(first.v.size).fill(null);
    for (const l of group) {
      const twin = byIndex[l.v.index];
      if (twin) throw new RecordError(day, `batch ${batch} has index ${l.v.index} twice, here and on line ${twin.n}`, l.n);
      byIndex[l.v.index] = l;
    }
    const absent = byIndex.flatMap((l, i) => (l ? [] : [i]));
    if (absent.length > 0)
      throw new RecordError(
        day,
        `batch ${batch} signed ${first.v.size} entries, but index ${absent.join(", ")} ${absent.length > 1 ? "are" : "is"} not in the record`,
        at,
      );
    const outcomes = new Map();
    for (const l of byIndex) {
      const twin = outcomes.get(l.v.outcome);
      if (twin) throw new RecordError(day, `batch ${batch} has outcome ${l.v.outcome} twice, here and on line ${twin.n}`, l.n);
      outcomes.set(l.v.outcome, l);
    }
    const nonceKey = `${first.v.forecaster}:${BigInt(first.v.nonce)}`;
    const reused = seen.nonces.get(nonceKey);
    if (reused !== undefined)
      throw new RecordError(day, `batch ${batch} reuses nonce ${first.v.nonce}, already signed by its forecaster in batch ${reused}`, at);
    seen.nonces.set(nonceKey, batch);
    let signer;
    try {
      signer = recover(digest(first.v.type, messageOf(byIndex)), first.v.signature);
    } catch (error) {
      throw new RecordError(day, `batch ${batch}'s signature does not recover (${error.message})`, at);
    }
    if (signer !== first.v.forecaster)
      throw new RecordError(day, `batch ${batch}'s signature recovers to ${signer}, not to its forecaster ${first.v.forecaster}`, at);
  }
  return groups.size;
}

function verifyDay(day, files, entry, seen) {
  const manifest = checkManifest(day, files, entry);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(files.jsonl);
  } catch {
    throw new RecordError(day, "the record is not valid UTF-8");
  }
  if (text.length === 0) throw new RecordError(day, "the record is empty");
  const raw = text.split("\n");
  if (raw.at(-1) !== "") throw new RecordError(day, "does not end in a newline", raw.length);
  raw.pop();
  const lines = [];
  raw.forEach((s, i) => lines.push(checkLine(day, s, i + 1, lines.at(-1))));
  const batches = checkBatches(day, lines, seen);
  if (lines.length !== manifest.count)
    throw new RecordError(day, `has ${lines.length} lines; the manifest says ${manifest.count}`);
  if (files.jsonl.length !== manifest.bytes)
    throw new RecordError(day, `is ${files.jsonl.length} bytes; the manifest says ${manifest.bytes}`);
  const digestHex = sha256(files.jsonl).toString("hex");
  if (digestHex !== manifest.sha256)
    throw new RecordError(day, `sha256 is ${digestHex}; the manifest says ${manifest.sha256}`);
  const root = merkleRoot(raw);
  if (root !== manifest.root) throw new RecordError(day, `root is ${root}; the manifest says ${manifest.root}`);
  return { day, manifest, lines: lines.map((l) => l.v), batches };
}

/**
 * Checks the record, oldest day first, and returns each day's lines. Throws a RecordError naming
 * the first failure. `only` limits the days checked; the index is always checked whole.
 */
export function verifyRecords(store, { only } = {}) {
  const entries = checkIndex(store.index, store.days);
  const days = only ? [...new Set(only)].sort() : [...entries.keys()].sort();
  const seen = { batches: new Map(), nonces: new Map() };
  return days.map((day) => {
    const entry = entries.get(day);
    if (!entry) throw new RecordError(day, "is not in the record");
    return verifyDay(day, store.days.get(day), entry, seen);
  });
}
