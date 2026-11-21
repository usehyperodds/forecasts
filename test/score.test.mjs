import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { board, mean, outcomeBps, outcomesToAsk, scoreBoard, scoreForecast } from "../scripts/lib/score.mjs";
import { loadRecords, verifyRecords } from "../scripts/lib/verify.mjs";
import { addressOf, key } from "./keys.mjs";

const scoring = fileURLToPath(new URL("fixtures/scoring/", import.meta.url));

async function fixture() {
  const days = verifyRecords(await loadRecords(join(scoring, "records")));
  const json = JSON.parse(await readFile(join(scoring, "settlements.json"), "utf8"));
  const settlements = new Map(Object.entries(json).map(([o, f]) => [Number(o), f]));
  const results = new Map([...settlements].map(([o, f]) => [o, outcomeBps(f)]));
  return { days, settlements, results };
}

test("the contract's scoring example", () => {
  assert.deepEqual(scoreForecast({ probabilityBps: 6200, fairBps: 5810, midBps: 6050 }, 10000), {
    brier: 0.1444,
    brierFair: 0.175561,
    brierMarket: 0.156025,
    skillFair: 0.031161,
    skillMarket: 0.011625,
  });
  assert.deepEqual(scoreForecast({ probabilityBps: 6200, fairBps: null, midBps: null }, 0), {
    brier: 0.3844,
    brierFair: null,
    brierMarket: null,
    skillFair: null,
    skillMarket: null,
  });
});

test("outcomeBps reads the decimal string and rounds half away from zero", () => {
  const cases = {
    "1.0": 10000,
    "0.0": 0,
    "0.5": 5000,
    1: 10000,
    0: 0,
    "1.000": 10000,
    "0.12344": 1234,
    "0.12345": 1235,
    "0.123449999": 1234,
    "0.00005": 1,
    "0.99995": 10000,
    "0.123456789012345678": 1235,
  };
  for (const [s, want] of Object.entries(cases)) assert.equal(outcomeBps(s), want, s);
});

test("outcomeBps reads only 0 or 1 with up to 18 decimals, at most 1", () => {
  for (const s of ["1.00005", "2.0", "-0.5", "-0", "0.5e1", "", "abc", " 1.0", "1.0 ", "1.", ".5", "01.0", "00.5", "0.1234567890123456789", "+1"])
    assert.equal(outcomeBps(s), null, s);
  assert.equal(outcomeBps(null), null);
  assert.equal(outcomeBps(1), null);
});

test("Hyperliquid is asked about unsettled outcomes and those in the three newest records", () => {
  const day = (d, outcomes) => ({ day: d, lines: outcomes.map((outcome) => ({ outcome })) });
  const days = [day("2026-10-01", [1, 2]), day("2026-10-02", [3]), day("2026-10-03", [4]), day("2026-10-04", [5, 1])];
  const cache = { 1: "1.0", 2: "0.0", 3: "1.0", 4: "0.0" };
  assert.deepEqual(outcomesToAsk(days, cache), { outcomes: [1, 2, 3, 4, 5], ask: [1, 3, 4, 5] });
  assert.deepEqual(outcomesToAsk(days, cache, { refetch: true }).ask, [1, 2, 3, 4, 5]);
  assert.deepEqual(outcomesToAsk(days, { ...cache, 5: "1.0" }, { recent: 1 }).ask, [1, 5]);
});

test("means round half away from zero to 6 decimals", () => {
  assert.equal(mean(150n, 1), 0.000002);
  assert.equal(mean(-150n, 1), -0.000002);
  assert.equal(mean(149n, 1), 0.000001);
  assert.equal(mean(-149n, 1), -0.000001);
  assert.equal(mean(1n, 3), 0);
  assert.equal(mean(10n ** 8n * 2n + 1n, 2), 1);
  assert.equal(mean(0n, 0), null);
});

test("the scoring fixture rebuilds the known board", async () => {
  const { days, settlements } = await fixture();
  const want = await readFile(join(scoring, "board.json"), "utf8");
  assert.equal(`${JSON.stringify(board(days, settlements), null, 2)}\n`, want);
});

test("the known board's rows follow the contract", async () => {
  const { days, settlements } = await fixture();
  const b = board(days, settlements);
  const row = (n) => b.rows.find((r) => r.forecaster === addressOf(key(n)));
  assert.equal(b.asOf, "2026-10-24T00:05:00.388Z");
  assert.equal(b.through, "2026-10-23");
  assert.equal(b.records, 2);
  // 56 resolved forecasts: ranked first, not early, though its skill is below every early row's.
  assert.deepEqual([row(2).rank, row(2).n, row(2).early], [1, 56, false]);
  assert.ok(b.rows.some((r) => r.early && r.skillFair > row(2).skillFair));
  // Copying the fair line scores exactly 0 over it.
  assert.equal(row(4).skillFair, 0);
  // No fair line on any of its forecasts: skillFair is null and ranks last.
  assert.deepEqual([row(5).nFair, row(5).skillFair, row(5).rank], [0, null, b.total]);
  // Identical records tie; the lower address ranks first.
  assert.deepEqual([row(7).skillFair, row(7).n], [row(8).skillFair, row(8).n]);
  assert.equal(row(7).forecaster < row(8).forecaster, row(7).rank < row(8).rank);
  // Only unsettled outcomes: no row.
  assert.equal(row(6), undefined);
  // Replaced forecasts count once, the latest; the unsettled 1058 counts toward nothing.
  assert.equal(row(3).n, 6);
});

test("the latest forecast counts, across records", async () => {
  const { days, results } = await fixture();
  const lines = days.flatMap((d) => d.lines);
  const b3 = addressOf(key(3));
  const on1010 = lines.filter((l) => l.forecaster === b3 && l.outcome === 1010);
  assert.deepEqual(
    on1010.map((l) => [l.cutoff.slice(0, 10), l.probabilityBps]),
    [
      ["2026-10-22", on1010[0].probabilityBps],
      ["2026-10-23", 1200],
    ],
  );
  const only = (keep) => scoreBoard(lines.filter(keep), results).rows.find((r) => r.forecaster === b3);
  const withLatest = only(() => true);
  const withEarlier = only((l) => !(l.forecaster === b3 && l.outcome === 1010 && l.probabilityBps === 1200));
  assert.notEqual(withLatest.brier, withEarlier.brier);
});

test("baseline rows pool every counted, resolved forecast", async () => {
  const { days, settlements } = await fixture();
  const [fair, market] = board(days, settlements).baselines;
  assert.deepEqual([fair.key, fair.label, fair.skillFair, fair.n === fair.nFair], ["fair", "Hyperodds fair line", 0, true]);
  assert.deepEqual([market.key, market.label, market.skillMarket, market.n === market.nMarket], ["market", "Market price", 0, true]);
  assert.equal(fair.nMarket, market.nFair);
  assert.equal(fair.skillMarket, -market.skillFair);
});

test("the board names its settlements: count and root over the counted outcomes", async () => {
  const { days, settlements } = await fixture();
  const b = board(days, settlements);
  const counted = new Set(days.flatMap((d) => d.lines.map((l) => l.outcome)));
  const used = [...settlements.keys()].filter((o) => counted.has(o)).sort((a, b) => a - b);
  const text = used.map((o) => `${o}:${settlements.get(o)}\n`).join("");
  assert.equal(b.settled, 56);
  assert.equal(b.settled, used.length);
  assert.equal(b.settlementsRoot, createHash("sha256").update(text).digest("hex"));
  assert.deepEqual(Object.keys(b), ["asOf", "through", "records", "settled", "settlementsRoot", "baselines", "total", "rows"]);
});

test("a settlement no counted forecast uses, or an unreadable one, is not in the root", async () => {
  const { days, settlements } = await fixture();
  const b = board(days, settlements);
  const extra = new Map([...settlements, [999999, "1.0"], [1058, "1.5"]]);
  assert.deepEqual([board(days, extra).settled, board(days, extra).settlementsRoot], [b.settled, b.settlementsRoot]);
});

test("the root is over settleFraction exactly as Hyperliquid answers it", async () => {
  const { days, settlements } = await fixture();
  const b = board(days, settlements);
  const respelled = new Map(settlements);
  respelled.set(1000, settlements.get(1000) === "1.0" ? "1" : "0");
  const c = board(days, respelled);
  assert.deepEqual(c.rows, b.rows);
  assert.notEqual(c.settlementsRoot, b.settlementsRoot);
});

test("asOf is the newest record's closedAt", async () => {
  const { days, settlements } = await fixture();
  assert.equal(board(days, settlements).asOf, days.at(-1).manifest.closedAt);
  assert.equal(board(days.slice(0, 1), settlements).asOf, "2026-10-23T00:05:00.412Z");
});

test("an empty record gives an empty board", () => {
  assert.deepEqual(board([], new Map()), {
    asOf: null,
    through: null,
    records: 0,
    settled: 0,
    settlementsRoot: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    baselines: [
      { key: "fair", label: "Hyperodds fair line", n: 0, brier: null, nFair: 0, skillFair: null, nMarket: 0, skillMarket: null },
      { key: "market", label: "Market price", n: 0, brier: null, nFair: 0, skillFair: null, nMarket: 0, skillMarket: null },
    ],
    total: 0,
    rows: [],
  });
});
