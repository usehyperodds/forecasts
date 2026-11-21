export const EARLY_UNDER = 50;
export const LABELS = { fair: "Hyperodds fair line", market: "Market price" };

/**
 * `settleFraction` × 10000, rounded half away from zero, read off the decimal string; null for
 * anything that is not a decimal from 0 to 1.
 */
export function outcomeBps(settleFraction) {
  if (typeof settleFraction !== "string") return null;
  const m = /^(\d+)(?:\.(\d*))?$/.exec(settleFraction.trim());
  if (!m) return null;
  const digits = `${m[2] ?? ""}00000`;
  let bps = Number(m[1]) * 10_000 + Number(digits.slice(0, 4));
  if (digits[4] >= "5") bps += 1;
  return bps <= 10_000 ? bps : null;
}

/** (x − o)² in units of 10⁻⁸. */
export function brier(xBps, oBps) {
  return (xBps - oBps) ** 2;
}

/** A sum in 10⁻⁸ units over a count, rounded half away from zero to 6 decimals; null for none. */
export function mean(sum, count) {
  if (count === 0) return null;
  const den = BigInt(count) * 100n;
  const abs = sum < 0n ? -sum : sum;
  const q = (2n * abs + den) / (2n * den);
  return Number(sum < 0n ? -q : q) / 1e6;
}

/** The scores of one forecast against its outcome, as the contract shows them. */
export function scoreForecast({ probabilityBps: p, fairBps: f, midBps: m }, o) {
  const b = brier(p, o);
  const bf = f === null ? null : brier(f, o);
  const bm = m === null ? null : brier(m, o);
  return {
    brier: b / 1e8,
    brierFair: bf === null ? null : bf / 1e8,
    brierMarket: bm === null ? null : bm / 1e8,
    skillFair: bf === null ? null : (bf - b) / 1e8,
    skillMarket: bm === null ? null : (bm - b) / 1e8,
  };
}

/** For each forecaster and outcome, the line with the highest id. */
export function countedLines(lines) {
  const latest = new Map();
  for (const l of lines) {
    const key = `${l.forecaster}:${l.outcome}`;
    const seen = latest.get(key);
    if (!seen || l.id > seen.id) latest.set(key, l);
  }
  return [...latest.values()];
}

function tally() {
  return { n: 0, sum: 0n, nFair: 0, fair: 0n, nMarket: 0, market: 0n };
}

function stats(t) {
  return {
    n: t.n,
    brier: mean(t.sum, t.n),
    nFair: t.nFair,
    skillFair: mean(t.fair, t.nFair),
    nMarket: t.nMarket,
    skillMarket: mean(t.market, t.nMarket),
  };
}

function byRank(a, b) {
  if (a.early !== b.early) return a.early ? 1 : -1;
  if (a.skillFair !== b.skillFair) {
    if (a.skillFair === null) return 1;
    if (b.skillFair === null) return -1;
    return b.skillFair - a.skillFair;
  }
  if (a.n !== b.n) return b.n - a.n;
  return a.forecaster < b.forecaster ? -1 : a.forecaster > b.forecaster ? 1 : 0;
}

/**
 * Baselines and ranked rows from closed records' lines and settled outcomes (outcome id →
 * outcomeBps). A line whose outcome has not settled counts toward nothing.
 */
export function scoreBoard(lines, results) {
  const forecasters = new Map();
  const fairRow = tally();
  const marketRow = tally();
  for (const l of countedLines(lines)) {
    const o = results.get(l.outcome);
    if (o === undefined) continue;
    let t = forecasters.get(l.forecaster);
    if (!t) forecasters.set(l.forecaster, (t = tally()));
    const b = BigInt(brier(l.probabilityBps, o));
    const bf = l.fairBps === null ? null : BigInt(brier(l.fairBps, o));
    const bm = l.midBps === null ? null : BigInt(brier(l.midBps, o));
    t.n++;
    t.sum += b;
    if (bf !== null) {
      t.nFair++;
      t.fair += bf - b;
      fairRow.n++;
      fairRow.sum += bf;
    }
    if (bm !== null) {
      t.nMarket++;
      t.market += bm - b;
      marketRow.n++;
      marketRow.sum += bm;
    }
    if (bf !== null && bm !== null) {
      fairRow.nMarket++;
      fairRow.market += bm - bf;
      marketRow.nFair++;
      marketRow.fair += bf - bm;
    }
  }
  const rows = [...forecasters].map(([forecaster, t]) => ({
    rank: 0,
    forecaster,
    ...stats(t),
    early: t.n < EARLY_UNDER,
  }));
  rows.sort(byRank);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  const f = stats(fairRow);
  const m = stats(marketRow);
  const baselines = [
    { key: "fair", label: LABELS.fair, ...f, nFair: f.n, skillFair: f.n > 0 ? 0 : null },
    { key: "market", label: LABELS.market, ...m, nMarket: m.n, skillMarket: m.n > 0 ? 0 : null },
  ];
  return { baselines, rows };
}

/**
 * The board in the shape of GET /forecasts/board, every row included. `asOf` is the newest
 * record's close, so the same records and settlements always give the same bytes.
 */
export function board(days, results) {
  const { baselines, rows } = scoreBoard(
    days.flatMap((d) => d.lines),
    results,
  );
  const newest = days.map((d) => d.manifest.closedAt).sort().at(-1) ?? null;
  return {
    asOf: newest,
    through: days.at(-1)?.day ?? null,
    records: days.length,
    baselines,
    total: rows.length,
    rows,
  };
}
