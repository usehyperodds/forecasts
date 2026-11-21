# The Hyperodds forecast record spec

Everything below is fixed. The Hyperodds API, its MCP bridge (`hyperodds-mcp`), the open scorer and the console
are built to it; a change here is a new version of the spec.

## Units and names

- **Outcome**: a HIP-4 outcome id (`outcome` in Hyperliquid's `outcomeMeta`). Side 0 is the first entry of its
  `sideSpecs`, the first label Hyperodds shows (often Yes).
- **Probability**: `probabilityBps`, the probability that side 0 wins, in basis points: an integer from 1 to 9999.
  6200 means 62.00%. 0 and 10000 are refused.
- **Forecaster**: the address that signed, written lowercase in every answer and record. Only EOA signatures
  (65-byte secp256k1) are accepted; contract wallets (ERC-1271, ERC-6492) are refused.
- **Times**: `time` in signed messages is Unix seconds. Every other time is ISO 8601 UTC with milliseconds
  (`2025-11-22T06:00:00.000Z`). A **day** is a UTC date, `YYYY-MM-DD`.

## EIP-712

One domain for both message types. It has no `chainId` and no `verifyingContract`: there is no contract, and a
domain without a chain id is signed by MetaMask and Rabby on whatever chain the wallet is on (MetaMask checks a
domain's `chainId` against the active chain only when one is present) and by viem's `signTypedData` as is.

```ts
const domain = { name: "Hyperodds Forecasts", version: "1" };

// One forecast.
const forecastTypes = {
  Forecast: [
    { name: "forecaster", type: "address" },
    { name: "outcome", type: "uint32" },
    { name: "probabilityBps", type: "uint16" },
    { name: "time", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
};

// A batch of 1 to 50 forecasts under one signature.
const batchTypes = {
  ForecastBatch: [
    { name: "forecaster", type: "address" },
    { name: "forecasts", type: "ForecastEntry[]" },
    { name: "time", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
  ForecastEntry: [
    { name: "outcome", type: "uint32" },
    { name: "probabilityBps", type: "uint16" },
  ],
};
```

| | Value |
|---|---|
| Domain type | `EIP712Domain(string name,string version)` |
| Domain separator | `0x8c35fadb67824908e8f620e61384ee244830a28d798764768569090f3d929e37` |
| `Forecast` type hash | `keccak256("Forecast(address forecaster,uint32 outcome,uint16 probabilityBps,uint64 time,uint64 nonce)")` = `0xa8d516c0479c1166e3591b894d95ba27b4c73b848308820d52435e923bd368e6` |
| `ForecastBatch` type hash | `keccak256("ForecastBatch(address forecaster,ForecastEntry[] forecasts,uint64 time,uint64 nonce)ForecastEntry(uint32 outcome,uint16 probabilityBps)")` = `0xff5ca7ea63ac690bc636955ac4763383f2c84c4803111d26b74195eba18aa6f9` |
| `ForecastEntry` type hash | `0x36e1078a25cea9e34eff3e4b746daee80ce54e7d5b97256dbf173dade80130bc` |

Test vectors, signed with the private key `0x00…01` (address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`), a
well-known test key that must never hold funds:

| Message | Digest | Signature |
|---|---|---|
| `Forecast {forecaster: 0x7E5F…5Bdf, outcome: 42400, probabilityBps: 6200, time: 1763719200, nonce: 1763719200000}` | `0x9d68b0769b49c457471adea46b361ce9f832bb2e5bbf8199689d357766c9e754` | `0x4d8ddebb9cfe6cfcc6d870809f19364c56e134039c1200cf74004ce6aac7a1ed09c333b798001f1c2cd2d8aa37630592e3d5333abc30b6a479c0db8bd213cd651c` |
| `ForecastBatch {forecaster: 0x7E5F…5Bdf, forecasts: [{42400, 6200}, {42501, 3100}], time: 1763719200, nonce: 1763719200001}` | `0x8628ebe750cec7b7704023cfeb8cbfde075fde486849a3ae9c8931fabc83c139` | `0xf905beb040b0c94625daeb3318c3be48580ec010fec6400f70493dcd3e74c6165dd78927190c61761f03214a1b8a2d065b393ae106adf26edd0b359a2ba1bcd71b` |

The signature is the 65-byte `r ‖ s ‖ v` hex string that `eth_signTypedData_v4` returns. `v` may be 27/28 or 0/1
and is written 27/28 in the record. `s` must be in the lower half of the curve order (`s ≤ n/2`, as Ethereum has
required since EIP-2; viem, ethers, MetaMask and Rabby sign that way); a high-`s` signature is refused as
`bad_signature`, so no forecast has two valid signatures. The recovered address must equal `forecaster`, in any
letter case (an all-capitals address signs as its lowercase form).

## Nonce, time and replay

- `nonce` is a uint64 the signer picks. Each `(forecaster, nonce)` is accepted once, ever; a second submission with
  a used nonce is refused as `replayed`, whatever it contains. A random 63-bit integer, or the time in milliseconds
  for a signer that never sends two in the same millisecond, both work. JSON carries it as a decimal string
  (`"1763719200000"`); a JSON integer up to 2^53 − 1 is accepted too.
- `time` must be within 600 seconds before and 120 seconds after the server's clock at the moment it records the
  forecast (`acceptedAt`), or it is refused as `stale_time`. Every recorded line therefore has
  `floor(acceptedAt / 1000) − 600 ≤ time ≤ floor(acceptedAt / 1000) + 120`. `time` also decides which of a
  forecaster's forecasts on one outcome counts, as set out under What counts. A sign link builds its message when
  the wallet signs, so its `time` is fresh.
- A refused submission doesn't use up its nonce: fix it and send it again with the same one.
- Batches are all or nothing. If any entry is refused, nothing is recorded and the answer lists every refused entry.
- A batch's outcomes must be distinct.

## Cutoff

- A market's **cutoff** is its event time: a game's start, a price market's price time, a decision's time, as
  Hyperodds reads it from the HIP-4 template (`eventTime` in the API's market views).
- A forecast is accepted only if, when the server receives it, the outcome is listed in Hyperliquid's
  `outcomeMeta` (not settled, not removed), is not a question's fallback outcome, has an event time, is not a touch
  market (those settle whenever the price touches, so they have no fixed cutoff), and the server's clock is before
  the close.
- Entries **close** 60 minutes before the cutoff. In that last hour a forecast adds little information of its own,
  and copying the book costs nothing, so a forecast received after the close is refused as `past_close`, and one
  received after the market's current cutoff as `past_cutoff`.
- The cutoff is recorded with the forecast and stays with it if the market's terms change later. The close is the
  earlier of `cutoff − 60 min` and `earliest recorded cutoff on that outcome − 60 min`, the earliest taken over every
  forecaster's forecasts on that outcome. A postponed market therefore keeps its first close: once forecasts made
  for its first cutoff are published, nobody can copy or revise them under the new one.
- All forecasts in one batch must have their cutoffs on the same UTC day, so a batch is published whole, in one
  daily record. A batch that spans days is refused as `mixed_days`; split it by day.

## What counts

- **Ids** are unique across all days and grow in the order forecasts are accepted.
- **Counted**: for each forecaster and outcome, among that forecaster's forecasts on that outcome whose day is
  closed, the one with the latest signed `time`; equal times go to the higher `id`. Earlier ones stay in the record.
  Nothing is deleted.
- **In order**: a forecast whose signed `time` is not later than the `time` of that forecaster's latest accepted
  forecast on the same outcome (pending or published) is refused, entry code `out_of_order`. So the signer's clock
  decides which forecast counts, whatever order the forecasts reach the server in.
- **Replaced**, in the API: a published forecast (one past its cutoff) is replaced when the same forecaster has a
  published forecast on the same outcome with a later `time` (equal times: a higher `id`). Pending forecasts never
  change what others see.
- A forecast is **private** until its recorded cutoff: no endpoint, page or tool shows it, or its probability, to
  anyone, before then. Until then the API shows only counts: how many pending forecasts a forecaster has, and on
  how many markets.
- After its cutoff it shows in the forecaster's record. It is written into the daily record of the UTC day its
  cutoff falls on, which closes at 00:05 UTC the next day and never changes after.
- It is **resolved** once Hyperliquid settles its outcome. The board counts only resolved forecasts that are in a
  closed daily record, so every row can be rebuilt from the published records and Hyperliquid's public data.

## Recorded with each forecast

At acceptance the server records, from its own live state at that moment:

| Field | Meaning |
|---|---|
| `fairBps` | Hyperodds' fair line for side 0, in basis points (0 to 10000, rounded), or null |
| `fairNote` | Why `fairBps` is null: `no-line` (Hyperodds has no line for the market) or `low-confidence` (the line's confidence is under 0.5). Null when `fairBps` is set |
| `midBps` | The book's mid for side 0 (halfway between best bid and best ask), in basis points (0 to 10000, rounded), or null when either side of the book is empty or the spread is wider than 10 points: a mid between a 1¢ bid and a 99¢ ask is no price anyone trades at |
| `bookTime` | When that book was last updated, or null with `midBps` |

## HTTP

Base URL `https://api.usehyperodds.com` (locally the API's port). Requests and answers are JSON (`content-type:
application/json`) except the daily records. Every refusal is:

```json
{ "error": "A plain sentence for a person.", "code": "entries_refused", "entries": [ { "index": 2, "outcome": 42400, "code": "past_close", "error": "This market has closed for forecasts: entries close an hour before its cutoff." } ] }
```

`entries` appears only when entries were refused. Codes and statuses:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | the body isn't JSON, or doesn't match the shapes below (a key the signer didn't sign included) |
| 400 | `batch_size` | fewer than 1 or more than 50 entries |
| 400 | `duplicate_outcome` | an outcome appears twice in one batch |
| 400 | `stale_time` | `time` is outside the window above |
| 401 | `bad_signature` | the signature isn't 65 bytes, has a high `s`, or doesn't recover to `forecaster` |
| 404 | `not_found` | no such draft, address or record day (an impossible date included), and any other path under `/forecasts`, with any method |
| 409 | `replayed` | this forecaster already used this nonce |
| 409 | `draft_mismatch` | `draft` names a draft for other forecasts or another wallet |
| 410 | `draft_expired` | the draft is past its 30 minutes or already signed |
| 413 | `too_large` | the body passed 64 KB (the server stops reading there) |
| 422 | `entries_refused` | one or more entries refused, each with its own code: `not_listed`, `fallback`, `no_event_time`, `touch_market`, `past_close`, `past_cutoff`, `out_of_order` |
| 422 | `mixed_days` | the batch's cutoffs fall on more than one UTC day |
| 429 | `rate_limited` | over a rate limit below; `retry-after` says when to try again |
| 429 | `daily_cap` | the forecaster has 1,000 forecasts accepted today (UTC); `retry-after` points at 00:00 UTC |
| 429 | `ip_daily_cap` | 2,000 forecasts were accepted from this IP address today (UTC); `retry-after` points at 00:00 UTC |
| 429 | `day_full` | 200,000 forecasts are recorded with cutoffs on that UTC day; no `retry-after`, the day takes no more |
| 500 | `internal` | `Something went wrong on our side. Try again in a minute.` |
| 503 | `loading` | markets are still loading after a restart |

Limits, all per UTC day or per rolling window as named:

| What | Limit |
|---|---|
| Submissions and drafts, per IP address | 1 a second, in bursts of 10 |
| Submissions, per forecaster | 10 a minute, in bursts of 10 |
| Accepted forecasts, per forecaster | 1,000 a UTC day (`daily_cap`) |
| Accepted forecasts, per IP address | 2,000 a UTC day (`ip_daily_cap`) |
| Recorded forecasts, per cutoff day, all forecasters | 200,000 (`day_full`) |
| Drafts, per IP address | 600 an hour |
| Drafts naming a forecaster, per forecaster | 60 an hour |
| Drafts, all clients | 20,000 an hour |
| Reads (`GET`), per IP address | 10 a second, in bursts of 60 |
| Body | 64 KB |

A refused or unreadable body still counts toward its IP address's limit on submissions and drafts.

### `POST /forecasts`: record a signed forecast or batch

```json
{
  "type": "ForecastBatch",
  "message": {
    "forecaster": "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    "forecasts": [
      { "outcome": 42400, "probabilityBps": 6200 },
      { "outcome": 42501, "probabilityBps": 3100 }
    ],
    "time": 1763719200,
    "nonce": "1763719200001"
  },
  "signature": "0xf905…cd71b",
  "draft": "optional: the draft id when signing from a sign link"
}
```

For one forecast, `type` is `"Forecast"` and `message` is
`{ "forecaster", "outcome", "probabilityBps", "time", "nonce" }`. Answer `201`:

```json
{
  "batch": 17,
  "forecaster": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  "day": "2025-11-22",
  "forecasts": [
    {
      "id": 101,
      "outcome": 42400,
      "probabilityBps": 6200,
      "acceptedAt": "2025-11-21T10:00:01.234Z",
      "cutoff": "2025-11-22T06:00:00.000Z",
      "fairBps": 5810,
      "fairNote": null,
      "midBps": 6050,
      "bookTime": "2025-11-21T10:00:00.950Z",
      "replaces": null
    }
  ]
}
```

`replaces` is the id of the forecast this one replaced (same forecaster and outcome), or null.

### `POST /forecasts/drafts`: a sign link for a wallet to sign

For clients that hold no key (remote connectors). The draft keeps the entries for 30 minutes; the forecaster's own
wallet signs them in the browser at the link. Hyperodds never holds a forecaster's key.

```json
{ "forecasts": [ { "outcome": 42400, "probabilityBps": 6200 } ], "forecaster": "optional 0x… address" }
```

Entries are checked as a submission would be (listed, before the close, one UTC day, distinct, 1 to 50), so a draft
that would be refused is refused now. The close is checked again when the wallet signs: a sign link whose entries
have passed their close by then is refused as `past_close`, and the page asks for a new draft. Without
`forecaster`, any wallet can sign the link. With `forecaster`, only that wallet can, and the answer also carries
`typedData`, ready for a local signer to sign as is (its `time` is now and its `nonce` random). The draft keeps that
nonce: it reads `signed` as soon as that forecaster's forecast with that nonce is accepted, whether or not the
submission names the draft. Anyone holding an open link sees its drafted probabilities. Answer `201`:

```json
{
  "draft": "kq3Vb6l0R2m8x1Yp9TzQwA",
  "url": "https://usehyperodds.com/forecasts/sign/kq3Vb6l0R2m8x1Yp9TzQwA",
  "expiresAt": "2025-11-21T10:30:00.000Z",
  "forecaster": null,
  "day": "2025-11-22",
  "forecasts": [
    { "outcome": 42400, "probabilityBps": 6200, "title": "BTC above 55,765 on Nov 22 at 06:00 UTC", "sides": ["Yes", "No"], "cutoff": "2025-11-22T06:00:00.000Z", "closesAt": "2025-11-22T05:00:00.000Z" }
  ],
  "typedData": null
}
```

`typedData`, when present, is `{ "domain", "types", "primaryType", "message" }` with `nonce` as a decimal string;
send its `message` back unchanged as the submission's `message`.

### `GET /forecasts/drafts/<draft>`

`{ "draft", "status": "open" | "signed" | "expired", "expiresAt", "forecaster", "day", "forecasts", "batch",
"signer", "recorded", "serverTime" }`.

- `forecasts` is the draft's entries while it is open and `[]` once it is signed or expired (they are pending
  forecasts by then). Each entry's `closesAt` is its close as above, recorded cutoffs on that outcome included.
- `batch` is the recorded batch id once signed, else null; `signer` the address that signed it, else null.
- `recorded`, once signed, is what Hyperodds saw for each market when the forecasts arrived, without the
  probabilities: `[{ "outcome", "title", "sides", "cutoff", "fairBps", "fairNote", "midBps" }]` in the signed
  order. Otherwise `[]`.
- `serverTime` is the server's clock when it answered: a signer that uses it signs a `time` inside the window even
  when its own clock is off.
- Drafts are deleted a day after they expire.

### `GET /forecasts/board?limit=50&offset=0`

`limit` 1 to 200 (default 50).

```json
{
  "asOf": "2025-11-23T00:05:00.000Z",
  "through": "2025-11-22",
  "records": 2,
  "settled": 131,
  "settlementsRoot": "5f0c…e2a1",
  "baselines": [
    { "key": "fair", "label": "Hyperodds fair line", "n": 120, "brier": 0.189302, "nFair": 120, "skillFair": 0, "nMarket": 118, "skillMarket": 0.004211 },
    { "key": "market", "label": "Market price", "n": 131, "brier": 0.185514, "nFair": 118, "skillFair": -0.004211, "nMarket": 131, "skillMarket": 0 }
  ],
  "total": 4,
  "resolved": 214,
  "established": 1,
  "rows": [
    { "rank": 1, "forecaster": "0x…", "n": 61, "brier": 0.170112, "nFair": 58, "skillFair": 0.012009, "nMarket": 61, "skillMarket": 0.003961, "early": false }
  ]
}
```

- `asOf` is the newest record's `closedAt` (null before the first record): the board changes only when a record
  closes or a settlement arrives.
- `through` is the newest closed day that has a record; `records` how many records exist.
- `settled` is how many settlements the board used: one per outcome of a counted forecast whose outcome has settled.
  `settlementsRoot` is the SHA-256 (hex) of their lines `<outcome>:<settleFraction>\n`, sorted by outcome id
  ascending, concatenated (`settleFraction` exactly as Hyperliquid answers it). A rebuild from the same records and
  settlements matches the board exactly; when the two differ, the roots show whether the settlements are the cause.
- `total`, `resolved` and `established` cover all rows, whichever page is answered: `total` is the number of rows,
  `resolved` the sum of their `n`, and `established` the number that aren't `early`. A rebuild produces all three
  from the rows.
- Aggregates are defined under Scoring.

### `GET /forecasts/address/<address>?limit=50&offset=0`

```json
{
  "forecaster": "0x…",
  "summary": { "rank": 3, "n": 12, "brier": 0.2011, "nFair": 12, "skillFair": -0.0042, "nMarket": 12, "skillMarket": 0.0018, "early": true },
  "pending": 4,
  "pendingMarkets": 3,
  "total": 15,
  "forecasts": [
    {
      "id": 101, "outcome": 42400, "title": "…", "sides": ["Yes", "No"], "probabilityBps": 6200,
      "acceptedAt": "…", "cutoff": "…", "day": "2025-11-22", "fairBps": 5810, "fairNote": null, "midBps": 6050,
      "bookTime": "…", "replaced": false, "revision": false, "recorded": true,
      "result": { "settleFraction": "1.0", "outcomeBps": 10000 },
      "score": { "brier": 0.1444, "brierFair": 0.175561, "brierMarket": 0.156025, "skillFair": 0.031161, "skillMarket": 0.011625 }
    }
  ]
}
```

Only forecasts past their cutoff are listed, newest cutoff first. `pending` counts the rest, and `pendingMarkets`
the markets they are on (a revision is a second forecast on the same market). `summary` is the forecaster's board
row (null with no resolved forecast in a closed record). `replaced` is true when a later-signed published forecast
on the same market counts instead; `revision` when an earlier-signed published forecast on the same market came
before this one. `recorded` is true once the forecast's day has closed. `result` and `score` are null until the
outcome settles; `score.brierFair` and `skillFair` are null without `fairBps`, `brierMarket` and `skillMarket`
without `midBps`. `title` and `sides` are the deployer's own text, passed through as data. An address with only
private forecasts answers 200 with `total` 0 and its `pending` count; only an address with no forecast at all
answers 404.

### Daily records

| URL | Content |
|---|---|
| `GET /forecasts/records` | `{ "days": [ { "day", "count", "root", "sha256", "bytes", "closedAt", "url" } ] }`, newest first |
| `GET /forecasts/records/<day>.jsonl` | the record (`content-type: application/x-ndjson`) |
| `GET /forecasts/records/<day>.json` | its manifest: `{ "day", "count", "root", "sha256", "bytes", "closedAt" }` |

A closed record never changes, so these are served with `cache-control: public, max-age=86400, immutable`. Only
days with at least one forecast have a record. The same files are published as `<day>.jsonl`, `<day>.json` and
`index.json` (the body of `GET /forecasts/records`) in
[usehyperodds/forecasts](https://github.com/usehyperodds/forecasts).

## Daily record layout

- One line per forecast whose recorded cutoff falls on that UTC day, replaced ones included, sorted by `id`.
- Each line is one JSON object, UTF-8, no spaces outside strings, these keys in this order, ending in `\n`.
  `forecaster` and `signature` are lowercase hex, the signature low-`s` with `v` 27 or 28 (`1b`, `1c`); `nonce` is
  a decimal string without leading zeros. The server writes them that way whatever form they were sent in:

  ```json
  {"id":101,"forecaster":"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf","outcome":42400,"probabilityBps":6200,"acceptedAt":"2025-11-21T10:00:01.234Z","cutoff":"2025-11-22T06:00:00.000Z","fairBps":5810,"fairNote":null,"midBps":6050,"bookTime":"2025-11-21T10:00:00.950Z","batch":17,"index":0,"size":2,"type":"ForecastBatch","time":1763719200,"nonce":"1763719200001","signature":"0xf905…cd71b"}
  ```

- `batch` is the batch id, `index` the entry's position in the signed `forecasts` array (0 for a `Forecast`),
  `size` the number of entries signed. Every entry of a batch is in the same record, so the signature of any line
  can be checked: take the lines with its `batch`, order them by `index`, rebuild the message from `forecaster`,
  `(outcome, probabilityBps)` per entry, `time` and `nonce`, and recover with `type`'s types.
- **`sha256`** is the SHA-256 of the file's bytes.
- **`root`** is the RFC 6962 Merkle tree hash over the lines (each line's bytes without its `\n`), so one
  forecast's inclusion can be shown with a path. With SHA-256 as H: the root of no lines is `H("")`; of one line
  `H(0x00 ‖ line)`; of n > 1 lines `H(0x01 ‖ root(first k) ‖ root(rest))`, k the largest power of two below n.
  Test vectors, lines `a`, `b`, `c`:

  | Lines | Root |
  |---|---|
  | none | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
  | `a` | `022a6979e6dab7aa5ae4c3e5e45f7e977112a7e63593820dbec1ec738a24f93c` |
  | `a`, `b` | `b137985ff484fb600db93107c77b0365c80d78f5b429ded0fd97361d077999eb` |
  | `a`, `b`, `c` | `36642e73c2540ab121e3a6bf9545b0a24982cd830eb13d3cd19de3ce6c021ec1` |

## The settled result

Hyperliquid's public info endpoint, no key:

```sh
curl -s https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"settledOutcome","outcome":42400}'
```

The field is **`settleFraction`**: a decimal string, the share of $1 that side 0 paid at settlement. `"1.0"`: side 0
won; `"0.0"`: side 1 won; a standalone outcome can settle in between (a draw at `"0.5"`). The answer is `null` while
the outcome is unsettled. Hyperodds reads the same value as each market settles; a question outcome settled to 0
through the question's `settledNamedOutcomes` has `settleFraction` `"0.0"`.

`outcomeBps` = `settleFraction` × 10000, rounded half away from zero, computed on the decimal string (no floats).

## Scoring

All arithmetic is in integers, so any implementation gets the same digits. With p the forecast's `probabilityBps`,
f its `fairBps`, m its `midBps` and o the outcome's `outcomeBps`:

- **Brier** of the forecast: `B = (p − o)²`, in units of 10⁻⁸ (so 0 to 10⁸); shown as `B / 10⁸`.
- **Brier of the fair line** `Bf = (f − o)²` when f is set; **of the market** `Bm = (m − o)²` when m is set.
- **Skill over the fair line**: `Bf − B`. **Skill over the market**: `Bm − B`. Positive means the forecast beat
  that baseline. A forecast's own scores are exact (`B / 10⁸` has at most 8 decimals); only means are rounded.

Example: p = 6200, f = 5810, m = 6050, o = 10000 gives B = 0.1444, Bf = 0.175561, Bm = 0.156025, skill over the
fair line 0.031161, skill over the market 0.011625.

A forecaster's row, over their counted (latest per outcome) forecasts that are resolved and in closed records. The
board has a row for every forecaster with at least one.

| Field | Definition |
|---|---|
| `n` | how many there are |
| `brier` | mean of B |
| `nFair`, `skillFair` | how many have f, and the mean of `Bf − B` over those |
| `nMarket`, `skillMarket` | how many have m, and the mean of `Bm − B` over those |
| `early` | `nFair < 50`; a small advantage takes a few hundred resolved forecasts to tell apart from luck |

A mean is the exact sum divided by its count, rounded half away from zero to 6 decimals; it is null when its count
is 0.

Two **baseline rows** score the reference prices on the same forecasts, pooled across every forecaster:

| `key` | `label` | Pools | Fields |
|---|---|---|---|
| `fair` | Hyperodds fair line | every counted, resolved, recorded forecast that has f | `n` = `nFair` = that count, `brier` the mean of Bf, `skillFair` 0, `nMarket`/`skillMarket` the mean of `Bm − Bf` over those that also have m |
| `market` | Market price | every counted, resolved, recorded forecast that has m | `n` = `nMarket` = that count, `brier` the mean of Bm, `skillMarket` 0, `nFair`/`skillFair` the mean of `Bf − Bm` over those that also have f |

An agent that copies the book scores close to zero skill over the market.

**Rank**: rows with `nFair` of 50 or more first, then early rows; within each group by `skillFair` (highest first,
null last), then `n` (highest first), then `forecaster` (ascending). `rank` counts from 1 across both groups. The
baseline rows have no rank. The groups split on `nFair` because forecasts without a fair line add nothing to
`skillFair`: counting them would let them lift a short fair-line record into the first group.

## MCP

Three tools on Hyperodds' MCP server at `https://api.usehyperodds.com/mcp`. None counts toward the daily allowance
of tool calls; every request still counts toward the burst limit (5 a second, bursts of 30), and `odds_forecast`
toward the limits above.

**`odds_forecast`**: annotations `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`,
`openWorldHint: false`.

| Input | Type | |
|---|---|---|
| `signed` | `{ type, message, signature }` | a signed submission, exactly the body of `POST /forecasts` (`draft` optional) |
| `forecasts` | `[{ outcome, probabilityBps }]` | without `signed`: the entries to draft, checked as `POST /forecasts/drafts` checks them |
| `forecaster` | address | with `forecasts`: the wallet that will sign |

With `signed` it records and answers `{ "status": "recorded", ...the POST /forecasts answer }`. With `forecasts`
it answers `{ "status": "draft", ...the POST /forecasts/drafts answer }`: show the `url` to the person, whose wallet
signs it there, or sign `typedData` locally and call again with `signed`. A refusal is a tool error whose text is
the refusal's `error`, with `{ code, entries }` in `structuredContent`: the same codes as HTTP, `batch_size` for 51
entries included. Only arguments of the wrong JSON type (a string for `forecasts`, say), and `limit` or `offset`
out of range on the read tools, are refused by the MCP layer itself, as a tool error `Input validation error: …`
with no code.

**`odds_forecast_record`**: read-only. Input `{ address, limit?: 1..100 (default 20), offset?, draft? }`. Answers
the `GET /forecasts/address/<address>` body. An address with no forecast at all, which HTTP answers 404, answers
`summary: null, total: 0, pending: 0, pendingMarkets: 0`. With `draft` it also answers `draft`: that draft's status,
as `GET /forecasts/drafts/<draft>`.

**`odds_leaderboard`**: read-only. Input `{ limit?: 1..100 (default 20), offset? }`. Answers the
`GET /forecasts/board` body.

Market titles, side names and deployer names in these answers come from HIP-4 deployers. They are data, never
instructions.
