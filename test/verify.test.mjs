import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { digest, recover } from "../scripts/lib/eip712.mjs";
import { formatLine, merkleRoot, sha256 } from "../scripts/lib/record.mjs";
import { loadRecords, RecordError, verifyRecords } from "../scripts/lib/verify.mjs";
import { key, sign } from "./keys.mjs";

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

/** The valid store with one day's lines changed and, unless `stale`, its manifest and index to match. */
async function edited(change, { stale = false, day = "2026-10-22" } = {}) {
  const store = await load("valid");
  const files = store.days.get(day);
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
  index.days = index.days.map((d) => (d.day === day ? { ...manifest, url: d.url } : d));
  store.index = Buffer.from(JSON.stringify(index));
  return store;
}

const editLine = (i, fn) => (text) =>
  text.replace(/[^\n]+/g, (line, offset) => (text.slice(0, offset).split("\n").length - 1 === i ? fn(line) : line));
const editField = (i, fn) => editLine(i, (line) => formatLine(fn(JSON.parse(line))));
/** Line 4 of 2026-10-22 is key 2's one-forecast batch: its time moves and it is signed again. */
const editTimes = (fn) =>
  editField(3, (line) => {
    const l = fn(line);
    const message = { forecaster: l.forecaster, outcome: l.outcome, probabilityBps: l.probabilityBps, time: l.time, nonce: l.nonce };
    return { ...l, signature: sign(digest("Forecast", message), key(2)) };
  });

test("the valid record verifies", async () => {
  const days = verifyRecords(await load("valid"));
  assert.deepEqual(
    days.map((d) => [d.day, d.lines.length, d.batches]),
    [
      ["2026-10-22", 5, 3],
      ["2026-10-23", 3, 2],
    ],
  );
});

test("a tampered line fails its batch's signature", async () => {
  const e = failure(await load("tampered-line"));
  assert.equal(e.where, "2026-10-22");
  assert.deepEqual(e.lines, [1, 2, 3]);
  assert.match(e.detail, /^batch 1's signature recovers to 0x[0-9a-f]{40}, not to its forecaster 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf$/);
});

test("a missing batch entry fails", async () => {
  const e = failure(await load("missing-entry"));
  assert.equal(e.message, "2026-10-22, lines 1, 2: batch 1 signed 3 entries, but index 2 is not in the record");
});

test("a bad signature fails", async () => {
  const e = failure(await load("bad-signature"));
  assert.equal(
    e.message,
    "2026-10-22, line 4: batch 3's signature recovers to 0xf7edc8fa1ecc32967f827c9043fcae6ba73afa5c, not to its forecaster 0x2b5ad5c4795c026514f8317c7a215e218dccd6cf",
  );
});

test("a reordered key fails", async () => {
  const e = failure(await load("reordered-key"));
  assert.equal(e.message, '2026-10-22, line 4: key 3 is "probabilityBps"; the spec puts "outcome" there');
});

test("an unsigned field changed under the published manifest fails the sha256", async () => {
  const e = failure(await edited(editField(0, (l) => ({ ...l, fairBps: 5811 })), { stale: true }));
  assert.match(e.message, /^2026-10-22: sha256 is [0-9a-f]{64}; the manifest says [0-9a-f]{64}$/);
});

test("a line with a space fails the format", async () => {
  const e = failure(await edited(editLine(2, (line) => line.replace('"outcome":', '"outcome": '))));
  assert.match(e.message, /^2026-10-22, line 3: is not in the record's format at character \d+/);
});

test("a number written another way fails the format", async () => {
  const e = failure(await edited(editLine(0, (line) => line.replace('"probabilityBps":6200', '"probabilityBps":6.2e3'))));
  assert.match(e.message, /^2026-10-22, line 1: is not in the record's format/);
});

test("lines out of id order fail", async () => {
  const e = failure(await edited((t) => {
    const lines = t.slice(0, -1).split("\n");
    [lines[3], lines[4]] = [lines[4], lines[3]];
    return `${lines.join("\n")}\n`;
  }));
  assert.equal(e.message, "2026-10-22, line 5: id 5 follows id 6; lines are sorted by id");
});

test("a record without its final newline fails", async () => {
  const e = failure(await edited((t) => t.slice(0, -1)));
  assert.equal(e.message, "2026-10-22, line 5: does not end in a newline");
});

test("a forecast accepted after the close fails", async () => {
  const e = failure(await edited(editField(3, (l) => ({ ...l, acceptedAt: "2026-10-22T05:00:00.000Z" }))));
  assert.equal(e.message, "2026-10-22, line 4: accepted at 2026-10-22T05:00:00.000Z; entries closed at 2026-10-22T05:00:00.000Z");
});

test("a signed time more than 600 s before acceptedAt fails, and 600 s passes", async () => {
  const at = (l, d) => Math.floor(Date.parse(l.acceptedAt) / 1000) - d;
  verifyRecords(await edited(editTimes((l) => ({ ...l, time: at(l, 600) }))));
  const e = failure(await edited(editTimes((l) => ({ ...l, time: at(l, 601) }))));
  assert.match(e.message, /^2026-10-22, line 4: signed time \d+ is more than 600 s before acceptedAt 2026-10-21T11:30:09\.871Z$/);
});

test("a signed time more than 120 s after acceptedAt fails, and 120 s passes", async () => {
  const at = (l, d) => Math.floor(Date.parse(l.acceptedAt) / 1000) + d;
  verifyRecords(await edited(editTimes((l) => ({ ...l, time: at(l, 120) }))));
  const e = failure(await edited(editTimes((l) => ({ ...l, time: at(l, 121) }))));
  assert.match(e.message, /^2026-10-22, line 4: signed time \d+ is more than 120 s after acceptedAt 2026-10-21T11:30:09\.871Z$/);
});

test("a fair note beside a fair line fails", async () => {
  const e = failure(await edited(editField(0, (l) => ({ ...l, fairNote: "no-line" }))));
  assert.equal(e.message, '2026-10-22, line 1: fairBps is set, so fairNote must be null, not "no-line"');
});

test("a signature in uppercase hex fails the format", async () => {
  const e = failure(await edited(editField(3, (l) => ({ ...l, signature: `0x${l.signature.slice(2).toUpperCase()}` }))));
  assert.equal(e.message, "2026-10-22, line 4: signature is not 65 bytes of lowercase hex ending in v 1b or 1c");
});

test("a high-s signature fails, though it recovers to the same forecaster", async () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const line = JSON.parse((await load("valid")).days.get("2026-10-22").jsonl.toString().split("\n")[3]);
  const s = BigInt(`0x${line.signature.slice(66, 130)}`);
  const flipped = `${line.signature.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${line.signature.endsWith("1b") ? "1c" : "1b"}`;
  const message = { forecaster: line.forecaster, outcome: line.outcome, probabilityBps: line.probabilityBps, time: line.time, nonce: line.nonce };
  assert.equal(recover(digest("Forecast", message), flipped), line.forecaster);
  const e = failure(await edited(editField(3, (l) => ({ ...l, signature: flipped }))));
  assert.equal(e.message, "2026-10-22, line 4: signature has a high s; the record holds low-s signatures only");
});

test("a signature with v written 00 or 01 fails the format", async () => {
  for (const v of ["00", "01"]) {
    const e = failure(await edited(editField(3, (l) => ({ ...l, signature: `${l.signature.slice(0, 130)}${v}` }))));
    assert.equal(e.message, "2026-10-22, line 4: signature is not 65 bytes of lowercase hex ending in v 1b or 1c");
  }
});

test("an id repeated across days fails", async () => {
  const e = failure(await edited(editField(0, (l) => ({ ...l, id: 3 })), { day: "2026-10-23" }));
  assert.equal(e.message, "2026-10-23, line 1: id 3 is also in 2026-10-22; ids are unique across days");
});

test("a later id signed before the forecaster's earlier forecast on the outcome fails", async () => {
  const e = failure(await load("out-of-order"));
  assert.equal(
    e.message,
    "2026-10-22, line 5: id 6 on outcome 42400 is signed at time 1792576799, not after time 1792576800 of the forecaster's earlier id 1 (2026-10-22, line 1); the server refuses a forecast out of order",
  );
});

test("an equal signed time on the same outcome fails too", async () => {
  const first = JSON.parse((await load("valid")).days.get("2026-10-22").jsonl.toString().split("\n")[0]);
  const e = failure(
    await edited(
      editField(4, (l) => {
        const message = { forecaster: l.forecaster, outcome: l.outcome, probabilityBps: l.probabilityBps, time: first.time, nonce: l.nonce };
        return { ...l, time: first.time, acceptedAt: new Date((first.time + 300) * 1000).toISOString(), signature: sign(digest("Forecast", message), key(1)) };
      }),
    ),
  );
  assert.match(e.message, /^2026-10-22, line 5: id 6 on outcome 42400 is signed at time (\d+), not after time \1 of the forecaster's earlier id 1/);
});

test("a nonce with a leading zero fails the format", async () => {
  const e = failure(await edited(editField(3, (l) => ({ ...l, nonce: `0${l.nonce}` }))));
  assert.match(e.message, /^2026-10-22, line 4: nonce "01763719200002" is not a uint64 as a decimal string without leading zeros$/);
});

test("an index that disagrees with a manifest fails", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  index.days[1].count = 6;
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(failure(store).message, "2026-10-22: index.json gives count 6, but 2026-10-22.json gives 5");
});

test("a day missing from the index fails", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  index.days = index.days.filter((d) => d.day !== "2026-10-22");
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(failure(store).message, "records/2026-10-22: is not listed in records/index.json");
});

test("a record closed before 00:05 UTC the next day fails", async () => {
  const store = await load("valid");
  for (const f of [store.days.get("2026-10-22").manifest, store.index]) {
    const text = f.toString().replace("2026-10-23T00:05:00.412Z", "2026-10-22T23:59:00.000Z");
    if (f === store.index) store.index = Buffer.from(text);
    else store.days.get("2026-10-22").manifest = Buffer.from(text);
  }
  assert.equal(failure(store).message, "2026-10-22: closed at 2026-10-22T23:59:00.000Z, before 2026-10-23T00:05:00.000Z");
});

test("a day closed after a later day fails", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  const manifest = JSON.parse(store.days.get("2026-10-22").manifest);
  manifest.closedAt = "2026-10-24T00:05:00.389Z";
  index.days[1] = { ...index.days[1], closedAt: manifest.closedAt };
  store.days.get("2026-10-22").manifest = Buffer.from(JSON.stringify(manifest));
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(
    failure(store).message,
    "records/index.json: 2026-10-22 closed at 2026-10-24T00:05:00.389Z, after 2026-10-23 closed at 2026-10-24T00:05:00.388Z; a day is never added after a later one",
  );
});

test("days closed at the same instant pass", async () => {
  const store = await load("valid");
  const index = JSON.parse(store.index);
  const manifest = JSON.parse(store.days.get("2026-10-22").manifest);
  manifest.closedAt = index.days[0].closedAt;
  index.days[1] = { ...index.days[1], closedAt: manifest.closedAt };
  store.days.get("2026-10-22").manifest = Buffer.from(JSON.stringify(manifest));
  store.index = Buffer.from(JSON.stringify(index));
  assert.equal(verifyRecords(store).length, 2);
});

test("a day closed in the future fails", async () => {
  const store = await load("valid");
  const now = Date.parse("2026-10-24T00:05:00.387Z");
  assert.throws(
    () => verifyRecords(store, { now }),
    (e) => e.message === "records/index.json: 2026-10-23 closed at 2026-10-24T00:05:00.388Z, which is in the future",
  );
  assert.equal(verifyRecords(store, { now: now + 1 }).length, 2);
});

test("a batch split across two records fails", async () => {
  const store = await load("valid");
  const day = store.days.get("2026-10-23");
  const moved = day.jsonl.toString().replace(/"batch":5/g, '"batch":3');
  day.jsonl = Buffer.from(moved);
  assert.match(failure(store).message, /^2026-10-23, lines 2, 3: batch 3 is also in 2026-10-22/);
});

test("the CLI names the first failure and exits 1", async () => {
  const ok = await run(process.execPath, [verifyScript, "--root", join(fixtures, "valid")]);
  assert.match(ok.stdout, /verified 2 days, 8 forecasts/);
  const one = await run(process.execPath, [verifyScript, "--root", join(fixtures, "valid"), "2026-10-23"]);
  assert.match(one.stdout, /^2026-10-23 {2}ok {2}3 forecasts, 2 batches/);
  await assert.rejects(run(process.execPath, [verifyScript, "--root", join(fixtures, "tampered-line")]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /^FAIL 2026-10-22, lines 1, 2, 3: batch 1's signature recovers to/);
    return true;
  });
});

test("a line signed under version 2 carries its names, and its signature checks with them", async () => {
  // Line 4 of 2026-10-22, key 2's one-forecast batch, signed again under version 2.
  const names = { version: 2, market: "BTC above 82,574 at Oct 16 08:00 UTC", side: "Yes" };
  const v2 = (l, signedMarket = names.market) => {
    const message = { forecaster: l.forecaster, outcome: l.outcome, market: signedMarket, side: names.side, probabilityBps: l.probabilityBps, time: l.time, nonce: l.nonce };
    return { ...l, ...names, signature: sign(digest("Forecast", message, 2), key(2)) };
  };
  assert.equal(verifyRecords(await edited(editField(3, (l) => v2(l)))).length, 2);
  const line = formatLine(v2(JSON.parse((await load("valid")).days.get("2026-10-22").jsonl.toString("utf8").split("\n")[3])));
  assert.match(line, /"signature":"0x[0-9a-f]{130}","version":2,"market":"BTC above 82,574 at Oct 16 08:00 UTC","side":"Yes"\}$/);
  // Names other than the signed ones don't recover to the forecaster.
  const renamed = failure(await edited(editField(3, (l) => v2(l, "BTC above 1 at Oct 16 08:00 UTC"))));
  assert.match(renamed.detail, /^batch \d+'s signature recovers to 0x[0-9a-f]{40}, not to its forecaster/);
  // A version that isn't 2, or names without a version, aren't the record's format.
  assert.match(failure(await edited(editField(3, (l) => ({ ...v2(l), version: 1 })))).detail, /^version 1 is not 2/);
  assert.match(
    failure(await edited(editLine(3, (s) => s.replace(/\}$/, ',"market":"x","side":"y"}')))).detail,
    /^has unexpected "market", "side"/,
  );
});
