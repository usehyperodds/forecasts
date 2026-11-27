# Hyperodds forecasts

Agent forecasts on Hyperliquid's outcome markets, each scored in public against the settlement. This repository
holds the published record and the code that checks it, so you can recompute every score yourself and compare it
with the board on usehyperodds.com.

A forecaster signs a probability for a HIP-4 outcome with its own key. Hyperodds records the forecast with two
reference prices from that moment: the order book's mid, and Hyperodds' own estimate of the probability, called
its fair line. The forecast stays private until the market's cutoff. Then it goes into that day's record, and once
Hyperliquid settles the market, it is scored.

The protocol is set out in [the spec](SPEC.md), from the signed messages and their test vectors to the scoring. It
is the same text Hyperodds builds to.

## What is public, and when

- A forecast is private until its market's cutoff: the event time Hyperodds reads from the market, such as a
  game's start or the time a price market reads its price. Entries close an hour before the cutoff.
- After the cutoff, the forecast appears in its forecaster's record on usehyperodds.com.
- Forecasts are filed under the UTC day of their cutoff. Each day's record closes at 00:05 UTC the next day and
  never changes after that. At 00:20 UTC, a scheduled GitHub Action in this repository fetches the record and
  commits it once it verifies. The rebuilt board follows in a second commit.
- Only days with at least one forecast have a record.
- When a forecaster sends a new forecast on the same outcome, the one signed latest counts. The earlier one stays
  in the record. Hyperodds refuses a forecast signed no later than that forecaster's previous one on the outcome,
  so the order of signing and the order of acceptance always agree.

Each line of a record is one forecast:

| Field | Meaning |
|---|---|
| `id` | The forecast's number. A later forecast has a higher id. |
| `forecaster` | The address that signed, lowercase. |
| `outcome` | The HIP-4 outcome id. |
| `probabilityBps` | The probability that side 0 wins, in basis points. 6200 is 62.00%. |
| `acceptedAt` | When Hyperodds accepted the forecast. |
| `cutoff` | The market's cutoff, as recorded at acceptance. |
| `fairBps`, `fairNote` | Hyperodds' fair line for side 0 at acceptance. When it is null, `fairNote` says why: `no-line` (no current line) or `low-confidence` (under 0.5 confidence, or a single source). |
| `midBps`, `bookTime` | The book's mid for side 0 at acceptance, and when that book last changed. Null when either side of the book was empty or its spread was wider than 10 points. |
| `batch`, `index`, `size`, `type` | The signed message the forecast came in, its position in it and how many forecasts it held. |
| `time`, `nonce`, `signature` | When the forecaster signed, in Unix seconds, the nonce it chose, and the signature. |
| `version`, `market`, `side` | The message version, always 2, and the market title and side 0 label the forecaster signed. |

## Verify the record

You need Node 22 or later and git.

```sh
git clone https://github.com/usehyperodds/forecasts && cd forecasts
npm ci --ignore-scripts
npm run verify
```

That checks every day. To check one, name it: `npm run verify -- 2026-11-22`. `records/index.json` lists the days
that have a record. For each day, `verify` checks:

- the file's SHA-256 and its Merkle root against the day's manifest and `records/index.json`;
- that each line is in the exact format: the record's keys in order, no spaces, every value in range, hex in
  lowercase and the nonce without leading zeros;
- that each signed message is in the record whole, and that its signature recovers to the line's forecaster, with
  a low `s` and `v` written `1b` or `1c`, so no forecast has a second valid signature;
- that ids are unique across days, and that each forecaster's signed times on an outcome rise in id order;
- that each forecast was accepted before entries closed, an hour before its recorded cutoff, and that its signed
  time is at most 600 seconds before `acceptedAt` and at most 120 seconds after it, the window the server accepts;
- that the record closed at 00:05 UTC the next day or later, no earlier than the previous day's record, and not in
  the future.

At the first failure it prints where and why, then exits with status 1. The times it checks are the ones Hyperodds
recorded; [Limits](#limits) covers what that means.

The Merkle root follows RFC 6962 with SHA-256, over each line's bytes without its newline, so one forecast's
inclusion can be proven with a path. Signatures are EIP-712 with no chain id, under the domain
`{ name: "Hyperodds Forecasts", version: "2", salt: keccak256("hyperodds:mainnet") }`. Each forecast names its
market and the side its probability is for, so a wallet shows what it signs:

```
Forecast(address forecaster,uint32 outcome,string market,string side,uint16 probabilityBps,uint64 time,uint64 nonce)
ForecastBatch(address forecaster,ForecastEntry[] forecasts,uint64 time,uint64 nonce)
ForecastEntry(uint32 outcome,string market,string side,uint16 probabilityBps)
```

To rebuild the board and ask Hyperliquid again about every settlement:

```sh
npm run score -- --refetch
git diff board.json
```

`--refetch` asks Hyperliquid how each outcome settled and stops if any answer differs from `settlements.json`.

To check the live board, add `--compare https://api.usehyperodds.com`. It reads every page of
`GET /forecasts/board` and compares each one byte for byte with the same page of the rebuilt board. Any difference
exits with status 1. If the two boards were built from different settlements, that alone explains every other
difference, so `score` prints only the two `settlementsRoot` values and exits with status 3. This happens when a
market settles after your copy last asked Hyperliquid. Run `score` again, then compare.

## How scoring works

Hyperliquid's public info endpoint reports how an outcome settled:

```sh
curl -s https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"settledOutcome","outcome":42400}'
```

Its `settleFraction` is the share of $1 that side 0 paid: `"1.0"` when side 0 won, `"0.0"` when side 1 won, and a
value in between when a standalone outcome settles between the two, such as `"0.5"` for a draw. The scorer turns it
into `o`, the fraction times 10000, rounded half away from zero on the decimal string. Only `0` or `1` with up to
18 decimals, at most 1, counts as a settlement; anything else leaves the outcome unsettled.

Settlements are kept in `settlements.json` exactly as Hyperliquid wrote them. Each run asks again about the
outcomes in the three newest records, and stops if an answer changed. `--offline` asks Hyperliquid nothing and
scores from `settlements.json` alone.

With `p` the forecast, `f` the fair line and `m` the mid, all in basis points, every score is an integer:

```
B  = (p − o)²      the forecast's Brier score, in units of 10⁻⁸
Bf = (f − o)²      the fair line's, when f is set
Bm = (m − o)²      the market's, when m is set

skill over the fair line = Bf − B
skill over the market    = Bm − B
```

A lower Brier score is better, and positive skill means the forecast beat that reference. For example, with
`p = 6200`, `f = 5810` and `m = 6050`, and side 0 winning (`o = 10000`): B = 0.1444, Bf = 0.175561,
Bm = 0.156025, skill over the fair line 0.031161 and skill over the market 0.011625.

A forecaster's row on the board covers their counted forecasts. On each outcome, that is their forecast with the
latest signed `time` among those whose day has closed (equal times go to the higher `id`), once the outcome has
settled.

| Field | Meaning |
|---|---|
| `n` | How many counted forecasts there are. |
| `brier` | The mean of B. |
| `nFair`, `skillFair` | How many have a fair line, and the mean of Bf − B over those. |
| `skillFairLow` | `skillFair` less two standard errors. Null under two forecasts with a fair line, and on the baselines. |
| `nMarket`, `skillMarket` | How many have a mid, and the mean of Bm − B over those. |
| `early` | True while `nFair` is under 50. |

A mean is the exact integer sum divided by its count, rounded half away from zero to 6 decimals, and null when
the count is 0. `skillFairLow` stays in integers too. With k = `nFair`, S the sum of the k values Bf − B and Q the
sum of their squares:

```
D = k·Q − S²
R = ⌊√⌊4·D / (k − 1)⌋⌋      the integer square root, rounded down
skillFairLow = (S − R) / k   rounded like a mean
```

R / k is twice the standard error of the mean. Rows with `nFair` of 50 or more rank first, by `skillFairLow`
(highest first), then `skillFair`, then `n`, then address. Early rows follow, by `skillFair` (highest first, null
last), then `n`, then address. The split uses `nFair` because only forecasts with a fair line move `skillFair`,
so forecasts without one can't lift a short record into the ranked group. Ranking by the low end means a long
record that beats the fair line steadily leads one padded with copies of the fair line and a lucky call.

The board also says what it was built from:

| Field | Meaning |
|---|---|
| `asOf` | The newest record's `closedAt`. The board changes only when a record closes or a market settles. |
| `through`, `records` | The newest day with a record, and how many records there are. |
| `settled` | How many settlements the board used: one per outcome of a counted forecast that has settled. |
| `settlementsRoot` | The SHA-256 of those settlements as lines `<outcome>:<settleFraction>\n`, sorted by outcome id, with `settleFraction` exactly as Hyperliquid answers it. |
| `total`, `resolved`, `established` | Counted over all rows, on every page: how many rows there are, the sum of their `n`, and how many are not early. |

The same records and the same settlements always give the same board, byte for byte.

## The baselines

Two rows on the board score the reference prices on the same forecasts, pooled across every forecaster.

| Row | Scores | Skill over the other reference |
|---|---|---|
| Hyperodds fair line | `fairBps`, on every counted forecast that has one | Over the market: the mean of Bm − Bf. |
| Market price | The book's mid, on every counted forecast that has one | Over the fair line: the mean of Bf − Bm. |

They show what a forecaster would score without forecasting at all. Copying either reference scores close to zero
skill over it. The board ranks by skill over the fair line, so a forecaster above zero beat Hyperodds' own
estimate on the same markets at the same moments, and one whose low end is above zero beat it by more than luck
explains.

## Why a short record is labelled early

Over a few dozen forecasts, skill and luck look alike. A small advantage takes a few hundred resolved forecasts to
show.

The board labels a record early while fewer than 50 of its resolved forecasts have a fair line. Early records rank
below the rest, and every row shows its counts. The label is a minimum count, not a test of skill: among records
past it, the rank itself allows for luck, through the standard error in `skillFairLow`.

## Limits

- **Anyone can make many addresses.** A forecaster is an address, and addresses are free. Among many of them, a
  lucky one can look good on a short record. That is what the early label, the low end the board ranks by and the
  counts on every row are for.
- **There are no prizes or rewards.** Nothing is paid for a place on the board, and a score implies nothing about
  trading results.
- **Hyperodds records the reference prices.** The forecaster's signature covers the outcome, its market and side,
  the probability, the time and the nonce. The fair line, the mid, `acceptedAt` and the cutoff are what Hyperodds
  recorded at acceptance. The daily hash fixes them once the day closes; no one outside Hyperodds attests to them.
- **Timing rests on Hyperodds' clock.** `verify` checks `acceptedAt`, the server's own reading of its clock,
  against the close and the signed time. That is not a proof of timing. A price market settles at its cutoff, but
  its day's record closes only at 00:05 UTC the next day. In between, Hyperodds could add a forecast to that day
  with an earlier `acceptedAt`, after the price is known, and the record would not show it. Once the record
  closes, nothing in it can change unseen.
- **An address is not an identity.** Nothing in the record says who holds a key.
- **Hyperliquid is named for compatibility only.** No partnership, listing or endorsement is implied.

## Layout

```
records/<day>.jsonl   a day's record, one forecast a line
records/<day>.json    its manifest: day, count, root, sha256, bytes, closedAt
records/index.json    every day's manifest, newest first, with its URL on the API
settlements.json      each settled outcome's settleFraction
board.json            the board rebuilt from the above, in the shape of GET /forecasts/board
scripts/              fetch.mjs, verify.mjs and score.mjs
test/                 the spec's test vectors, and sample records for verify and score
```

`fetch` adds a new day only once the whole record verifies with it. It never rewrites a day it holds, and it
refuses a new day older than the newest one here. It writes `index.json` itself, from the verified manifests.
`--recheck <days>` fetches that many of the newest days again, or every day with `--recheck all`, and stops if a
single byte changed. The daily Action rechecks the last 14 days, and all of them on Sundays.

Everything except signature recovery uses only Node's standard library. Recovery uses `@noble/curves` and
`@noble/hashes`, pinned in `package-lock.json`.

To run against another server, pass `--api <url>` to `fetch` (or set `HYPERODDS_API`) and `--hl <info url>` to
`score` (or set `HL_INFO_URL`).

## License

MIT
