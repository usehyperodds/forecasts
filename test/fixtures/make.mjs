#!/usr/bin/env node
// Rebuilds the fixture records: node test/fixtures/make.mjs. The output is deterministic;
// scoring/board.json is the expected board and is not written here.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../scripts/lib/eip712.mjs";
import { formatLine, merkleRoot, sha256 } from "../../scripts/lib/record.mjs";
import { addressOf, key, sign } from "../keys.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

const iso = (ms) => new Date(ms).toISOString();
const at = (s) => Date.parse(s);

/**
 * Lines for a list of submissions, ids and batch ids given in order. Each submission:
 * { key, cutoff, acceptedAt, entries: [{ outcome, p, fair?, fairNote?, mid?, bookTime? }], single? }
 */
function linesOf(submissions) {
  let id = 0;
  return submissions.flatMap((s, b) => {
    const forecaster = addressOf(s.key);
    const time = Math.floor(at(s.acceptedAt) / 1000) - 1;
    const nonce = String(1763719200000 + b);
    const type = s.entries.length === 1 && s.single !== false ? "Forecast" : "ForecastBatch";
    const message =
      type === "Forecast"
        ? { forecaster, outcome: s.entries[0].outcome, probabilityBps: s.entries[0].p, time, nonce }
        : { forecaster, forecasts: s.entries.map((e) => ({ outcome: e.outcome, probabilityBps: e.p })), time, nonce };
    const signature = sign(digest(type, message), s.key);
    return s.entries.map((e, index) => {
      const fair = e.fair ?? null;
      const mid = e.mid ?? null;
      return {
        id: ++id,
        forecaster,
        outcome: e.outcome,
        probabilityBps: e.p,
        acceptedAt: s.acceptedAt,
        cutoff: e.cutoff ?? s.cutoff,
        fairBps: fair,
        fairNote: fair === null ? (e.fairNote ?? "no-line") : null,
        midBps: mid,
        bookTime: mid === null ? null : (e.bookTime ?? iso(at(s.acceptedAt) - 284)),
        batch: b + 1,
        index,
        size: s.entries.length,
        type,
        time,
        nonce,
        signature,
      };
    });
  });
}

const jsonFile = (v) => `${JSON.stringify(v, null, 2)}\n`;

function manifest(day, text, closedAt) {
  const body = text.map((l) => `${l}\n`).join("");
  return {
    day,
    count: text.length,
    root: merkleRoot(text),
    sha256: sha256(Buffer.from(body)).toString("hex"),
    bytes: Buffer.byteLength(body),
    closedAt,
  };
}

/** Writes records/ for days of raw line text: { day: { text: [...], closedAt } }. */
async function writeRecords(dir, days) {
  const records = join(dir, "records");
  await rm(records, { recursive: true, force: true });
  await mkdir(records, { recursive: true });
  const index = [];
  for (const day of Object.keys(days).sort()) {
    const { text, closedAt } = days[day];
    const m = manifest(day, text, closedAt);
    await writeFile(join(records, `${day}.jsonl`), text.map((l) => `${l}\n`).join(""));
    await writeFile(join(records, `${day}.json`), jsonFile(m));
    index.unshift({ ...m, url: `https://api.usehyperodds.com/forecasts/records/${day}.jsonl` });
  }
  await writeFile(join(records, "index.json"), jsonFile({ days: index }));
}

function byDay(lines, closedAt) {
  const days = {};
  for (const l of lines.sort((a, b) => a.id - b.id)) {
    const day = l.cutoff.slice(0, 10);
    days[day] ??= { text: [], closedAt: closedAt[day] };
    days[day].text.push(formatLine(l));
  }
  return days;
}

const CLOSED = { "2026-10-22": "2026-10-23T00:05:00.412Z", "2026-10-23": "2026-10-24T00:05:00.388Z" };

const valid = linesOf([
  {
    key: key(1),
    cutoff: "2026-10-22T06:00:00.000Z",
    acceptedAt: "2026-10-21T10:00:01.234Z",
    single: false,
    entries: [
      { outcome: 42400, p: 6200, fair: 5810, mid: 6050 },
      { outcome: 42501, p: 3100, fairNote: "low-confidence", mid: 2950 },
      { outcome: 42602, p: 8800, fair: 9120 },
    ],
  },
  { key: key(2), cutoff: "2026-10-23T14:00:00.000Z", acceptedAt: "2026-10-21T10:12:44.020Z", entries: [{ outcome: 43010, p: 4500, fair: 4400, mid: 4720 }] },
  { key: key(2), cutoff: "2026-10-22T06:00:00.000Z", acceptedAt: "2026-10-21T11:30:09.871Z", entries: [{ outcome: 42400, p: 5500, fair: 5830, mid: 6010 }] },
  { key: key(1), cutoff: "2026-10-22T06:00:00.000Z", acceptedAt: "2026-10-22T04:59:59.999Z", entries: [{ outcome: 42400, p: 6600, fair: 5900, mid: 6120 }] },
  {
    key: key(3),
    cutoff: "2026-10-23T14:00:00.000Z",
    acceptedAt: "2026-10-22T21:40:00.500Z",
    entries: [
      { outcome: 43010, p: 3900, fair: 4380, mid: 4600 },
      { outcome: 43011, p: 7100 },
    ],
  },
]);

/** Breaks one line of 2026-10-22 in the valid set. `recompute` rewrites the manifests to match. */
async function variant(name, change, recompute = true) {
  const days = byDay(valid.map((l) => ({ ...l })), CLOSED);
  const original = days["2026-10-22"].text.slice();
  days["2026-10-22"].text = change(days["2026-10-22"].text);
  const dir = join(here, name);
  await writeRecords(dir, days);
  if (recompute) return;
  // Leave the published manifest and index as they were: someone edited the committed record.
  const m = manifest("2026-10-22", original, CLOSED["2026-10-22"]);
  await writeFile(join(dir, "records", "2026-10-22.json"), jsonFile(m));
  const clean = byDay(valid.map((l) => ({ ...l })), CLOSED);
  const index = Object.keys(clean)
    .sort()
    .reverse()
    .map((day) => ({ ...manifest(day, clean[day].text, CLOSED[day]), url: `https://api.usehyperodds.com/forecasts/records/${day}.jsonl` }));
  await writeFile(join(dir, "records", "index.json"), jsonFile({ days: index }));
}

const edit = (text, i, fn) => text.map((t, j) => (j === i ? formatLine(fn(JSON.parse(t))) : t));

await writeRecords(join(here, "valid"), byDay(valid.map((l) => ({ ...l })), CLOSED));
await variant("tampered-line", (t) => edit(t, 1, (l) => ({ ...l, probabilityBps: 3900 })), false);
await variant("missing-entry", (t) => t.filter((_, i) => i !== 2));
await variant("bad-signature", (t) =>
  edit(t, 3, (l) => {
    const message = { forecaster: l.forecaster, outcome: l.outcome, probabilityBps: l.probabilityBps, time: l.time, nonce: l.nonce };
    return { ...l, signature: sign(digest("Forecast", message), key(9)) };
  }),
);
// Key 1's second forecast on 42400 (line 5) signed one second before its first (line 1): accepted
// later, so its id is higher, but signed earlier. The server refuses that as out_of_order.
await variant("out-of-order", (t) =>
  edit(t, 4, (l) => {
    const time = JSON.parse(t[0]).time - 1;
    const message = { forecaster: l.forecaster, outcome: l.outcome, probabilityBps: l.probabilityBps, time, nonce: l.nonce };
    return { ...l, time, acceptedAt: iso((time + 300) * 1000), signature: sign(digest("Forecast", message), key(1)) };
  }),
);
await variant("reordered-key", (t) =>
  t.map((s, i) => {
    if (i !== 3) return s;
    const { id, forecaster, outcome, probabilityBps, ...rest } = JSON.parse(s);
    return JSON.stringify({ id, forecaster, probabilityBps, outcome, ...rest });
  }),
);

// The scoring set: six forecasters over 60 outcomes on two days, with replacements, a draw, missing
// lines and unsettled outcomes.
let seed = 20261122;
const rand = (lo, hi) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return lo + (seed % (hi - lo + 1));
};
const outcomes = Array.from({ length: 60 }, (_, i) => 1000 + i);
const cutoffOf = (o) => (o % 2 === 0 ? "2026-10-22T18:00:00.000Z" : "2026-10-23T09:30:00.000Z");
const settle = (o) => (o === 1005 ? "0.5" : o >= 1058 ? null : o % 3 === 0 ? "0.0" : "1.0");
const market = new Map(outcomes.map((o) => [o, { fair: rand(1500, 8500), mid: rand(1500, 8500) }]));
const quote = (o, p) => {
  const q = market.get(o);
  return { outcome: o, p, fair: o % 11 === 7 ? null : q.fair, fairNote: o % 22 === 7 ? "low-confidence" : undefined, mid: o % 13 === 4 ? null : q.mid };
};
const submissions = [];
const file = (k, os, acceptedAt, p) => {
  for (const cutoff of ["2026-10-22T18:00:00.000Z", "2026-10-23T09:30:00.000Z"]) {
    const mine = os.filter((o) => cutoffOf(o) === cutoff);
    for (let i = 0; i < mine.length; i += 25)
      submissions.push({ key: key(k), cutoff, acceptedAt, single: false, entries: mine.slice(i, i + 25).map((o) => quote(o, p(o))) });
  }
};
file(2, outcomes.slice(0, 56), "2026-10-21T08:15:30.100Z", () => rand(500, 9500));
file(3, [1001, 1002, 1005, 1010, 1020, 1033, 1058], "2026-10-21T09:00:00.000Z", () => rand(1000, 9000));
file(4, outcomes.slice(20, 30), "2026-10-21T09:30:00.000Z", (o) => market.get(o).fair ?? 5000);
file(5, [1008, 1019, 1030, 1041], "2026-10-21T10:00:00.000Z", () => rand(2000, 8000));
file(6, [1058, 1059], "2026-10-21T10:30:00.000Z", () => 5000);
for (const k of [7, 8]) file(k, [1012, 1013, 1014], "2026-10-21T11:00:00.000Z", (o) => 3000 + o);
// Replacements: the later forecast counts, even when the market's cutoff moved to another day.
submissions.push({ key: key(3), cutoff: cutoffOf(1002), acceptedAt: "2026-10-21T15:45:00.000Z", entries: [quote(1002, 9100)] });
submissions.push({ key: key(3), cutoff: "2026-10-23T09:30:00.000Z", acceptedAt: "2026-10-21T16:00:00.000Z", entries: [quote(1010, 1200)] });

const scoring = linesOf(submissions);
await writeRecords(join(here, "scoring"), byDay(scoring, CLOSED));
const used = [...new Set(scoring.map((l) => l.outcome))].sort((a, b) => a - b);
const settlements = Object.fromEntries(used.flatMap((o) => (settle(o) === null ? [] : [[o, settle(o)]])));
await writeFile(join(here, "scoring", "settlements.json"), jsonFile(settlements));
