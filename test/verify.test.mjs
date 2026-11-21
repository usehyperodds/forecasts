import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatLine, merkleRoot, sha256 } from "../scripts/lib/record.mjs";
import { loadRecords, RecordError, verifyRecords } from "../scripts/lib/verify.mjs";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const verifyScript = fileURLToPath(new URL("../scripts/verify.mjs", import.meta.url));
const run = promisify(execFile);

const load = (name) => loadRecords(join(fixtures, name, "records"));

function failure(store) {
  try {
    verifyRecords(store);
  } catch (error) {
    if (error instanceof RecordError) return error;
    throw error;
  }
  assert.fail("verify passed");
}

/** The valid store with 2026-11-22's lines changed and, unless `stale`, its manifest and index to match. */
async function edited(change, { stale = false } = {}) {
  const store = await load("valid");
  const files = store.days.get("2026-11-22");
  const text = change(files.jsonl.toString("utf8"));
  files.jsonl = Buffer.from(text);
  if (stale) return store;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const manifest = {
    ...JSON.parse(files.manifest),
    count: lines.length,
    root: merkleRoot(lines),
    sha256: sha256(files.jsonl).toString("hex"),
    bytes: files.jsonl.length,
  };
  files.manifest = Buffer.from(JSON.stringify(manifest));
  const index = JSON.parse(store.index);
  index.days = index.days.map((d) => (d.day === "2026-11-22" ? { ...manifest, url: d.url } : d));
  store.index = Buffer.from(JSON.stringify(index));
  return store;
}

const editLine = (i, fn) => (text) =>
  text.replace(/[^\n]+/g, (line, offset) => (text.slice(0, offset).split("\n").length - 1 === i ? fn(line) : line));
const editField = (i, fn) => editLine(i, (line) => formatLine(fn(JSON.parse(line))));

test("the valid record verifies", async () => {
  const days = verifyRecords(await load("valid"));
  assert.deepEqual(
    days.map((d) => [d.day, d.lines.length, d.batches]),
    [
      ["2026-11-22", 5, 3],
      ["2026-11-23", 3, 2],
    ],
  );
});

test("a tampered line fails its batch's signature", async () => {
  const e = failure(await load("tampered-line"));
  assert.equal(e.where, "2026-11-22");
  assert.deepEqual(e.lines, [1, 2, 3]);
  assert.match(e.detail, /^batch 1's signature recovers to 0x[0-9a-f]{40}, not to its forecaster 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf$/);
});

test("a missing batch entry fails", async () => {
  const e = failure(await load("missing-entry"));
  assert.equal(e.message, "2026-11-22, lines 1, 2: batch 1 signed 3 entries, but index 2 is not in the record");
});

test("a bad signature fails", async () => {
  const e = failure(await load("bad-signature"));
  assert.equal(
    e.message,
    "2026-11-22, line 4: batch 3's signature recovers to 0xf7edc8fa1ecc32967f827c9043fcae6ba73afa5c, not to its forecaster 0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  );
});

test("a reordered key fails", async () => {
  const e = failure(await load("reordered-key"));
  assert.equal(e.message, '2026-11-22, line 4: key 3 is "probabilityBps"; the contract puts "outcome" there');
});

test("an unsigned field changed under the published manifest fails the sha256", async () => {
  const e = failure(await edited(editField(0, (l) => ({ ...l, fairBps: 5811 })), { stale: true }));
  assert.match(e.message, /^2026-11-22: sha256 is [0-9a-f]{64}; the manifest says [0-9a-f]{64}$/);
});

test("a line with a space fails the format", async () => {
  const e = failure(await edited(editLine(2, (line) => line.replace('"outcome":', '"outcome": '))));
  assert.match(e.message, /^2026-11-22, line 3: is not in the record's format at character \d+/);
});

test("a number written another way fails the format", async () => {
  const e = failure(await edited(editLine(0, (line) => line.replace('"probabilityBps":6200', '"probabilityBps":6.2e3'))));
  assert.match(e.message, /^2026-11-22, line 1: is not in the record's format/);
});

test("lines out of id order fail", async () => {
  const e = failure(await edited((t) => {
    const lines = t.slice(0, -1).split("\n");
    [lines[3], lines[4]] = [lines[4], lines[3]];
    return `${lines.join("\n")}\n`;
  }));
  assert.equal(e.message, "2026-11-22, line 5: id 5 follows id 6; lines are sorted by id");
});

test("a record without its final newline fails", async () => {
  const e = failure(await edited((t) => t.slice(0, -1)));
  assert.equal(e.message, "2026-11-22, line 5: does not end in a newline");
});

test("a forecast accepted after the close fails", async () => {
  const e = failure(await edited(editField(3, (l) => ({ ...l, acceptedAt: "2026-11-22T05:00:00.000Z" }))));
  assert.equal(e.message, "2026-11-22, line 4: accepted at 2026-11-22T05:00:00.000Z, after entries closed at 2026-11-22T05:00:00.000Z");
});

test("a fair note beside a fair line fails", async () => {
  const e = failure(await edited(editField(0, (l) => ({ ...l, fairNote: "no-line" }))));
  assert.equal(e.message, '2026-11-22, line 1: fairBps is set, so fairNote must be null, not "no-line"');
});

test("an index that disagrees with a manifest fails", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  index.days[1].count = 6;
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(failure(store).message, "2026-11-22: index.json gives count 6, but 2026-11-22.json gives 5");
});

test("a day missing from the index fails", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  index.days = index.days.filter((d) => d.day !== "2026-11-22");
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(failure(store).message, "records/2026-11-22: is not listed in records/index.json");
});

test("a record closed before 00:05 UTC the next day fails", async () => {
  const store = await load("valid");
  for (const f of [store.days.get("2026-11-22").manifest, store.index]) {
    const text = f.toString().replace("2026-11-23T00:05:00.412Z", "2026-11-22T23:59:00.000Z");
    if (f === store.index) store.index = Buffer.from(text);
    else store.days.get("2026-11-22").manifest = Buffer.from(text);
  }
  assert.equal(failure(store).message, "2026-11-22: closed at 2026-11-22T23:59:00.000Z, before 2026-11-23T00:05:00.000Z");
});

test("a batch split across two records fails", async () => {
  const store = await load("valid");
  const day = store.days.get("2026-11-23");
  const moved = day.jsonl.toString().replace(/"batch":5/g, '"batch":3');
  day.jsonl = Buffer.from(moved);
  assert.match(failure(store).message, /^2026-11-23, lines 2, 3: batch 3 is also in 2026-11-22/);
});

test("the CLI names the first failure and exits 1", async () => {
  const ok = await run(process.execPath, [verifyScript, "--root", join(fixtures, "valid")]);
  assert.match(ok.stdout, /verified 2 days, 8 forecasts/);
  const one = await run(process.execPath, [verifyScript, "--root", join(fixtures, "valid"), "2026-11-23"]);
  assert.match(one.stdout, /^2026-11-23 {2}ok {2}3 forecasts, 2 batches/);
  await assert.rejects(run(process.execPath, [verifyScript, "--root", join(fixtures, "tampered-line")]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^FAIL 2026-11-22, lines 1, 2, 3: batch 1's signature recovers to/);
    return true;
  });
});
