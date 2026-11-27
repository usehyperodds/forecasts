import assert from "node:assert/strict";
import { test } from "node:test";
import {
  digest,
  domainSeparator,
  encodeType,
  recover,
  saltOf,
  TYPES,
  toHex,
  typeHash,
} from "../scripts/lib/eip712.mjs";
import { key, sign } from "./keys.mjs";

const ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

const btc = { outcome: 42400, market: "BTC above 55,765 on Nov 22 at 06:00 UTC", side: "Yes" };
const eth = { outcome: 42501, market: "ETH above 3,000 on Nov 22 at 06:00 UTC", side: "Yes" };
const single = {
  forecaster: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  ...btc,
  probabilityBps: 6200,
  time: 1763719200,
  nonce: "1763719200000",
};
const batch = {
  forecaster: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  forecasts: [
    { ...btc, probabilityBps: 6200 },
    { ...eth, probabilityBps: 3100 },
  ],
  time: 1763719200,
  nonce: "1763719200001",
};
const SINGLE_SIG =
  "0xd16082f21b0a948afb6b6989797d76a8998907650777363ca2311c2912e5c5f3492b0b8d51db819b08f072e57e96d1f2533adc9c441b28bbbdde9f190926e4061c";
const BATCH_SIG =
  "0xc1188ccdbc21875662dbb6d048b5a2c6eb160cb54333574cbe91339b98aa59aa5666002a6f785cd2e948bb76d8f2e522c88a592b646ec876e0248ce4a1f45ee11b";

test("salts and domain separators match the spec", () => {
  assert.equal(saltOf("mainnet"), "0xc39792a05cff7539d2e0315b8f48f8ba52d0d5633867ed004c25a66c4160eeb4");
  assert.equal(saltOf("testnet"), "0xbefd4257376df87b4238d51baa58cb42138b258e25473b94ced4e206b6acd863");
  assert.equal(toHex(domainSeparator("mainnet")), "0x12e0f52833f9791dcb35db09d561aacc84ec21766e497c7618c159a931379d43");
  assert.equal(toHex(domainSeparator("testnet")), "0xf43fd5402336e8b029dfcac295e17ed1c11f178e45b23c23aada958b01bb18cb");
});

test("type strings and type hashes match the spec", () => {
  assert.equal(
    encodeType("Forecast", TYPES.Forecast),
    "Forecast(address forecaster,uint32 outcome,string market,string side,uint16 probabilityBps,uint64 time,uint64 nonce)",
  );
  assert.equal(
    encodeType("ForecastBatch", TYPES.ForecastBatch),
    "ForecastBatch(address forecaster,ForecastEntry[] forecasts,uint64 time,uint64 nonce)ForecastEntry(uint32 outcome,string market,string side,uint16 probabilityBps)",
  );
  assert.equal(toHex(typeHash("Forecast", TYPES.Forecast)), "0xf17e0807d1ad95830c7ed23f72a0c650744e9d7f4f2b66c28de313920555c836");
  assert.equal(
    toHex(typeHash("ForecastBatch", TYPES.ForecastBatch)),
    "0x5445b9122c3debdb9e5817cea50eac968ca3861f9ad1195f83830640f7579970",
  );
  assert.equal(
    toHex(typeHash("ForecastEntry", TYPES.ForecastBatch)),
    "0xb7b2fc97c148a7c38b4d821a7c4fabf1c9d2e7ff7d356597adab119bef4af363",
  );
});

test("digests match the spec", () => {
  assert.equal(toHex(digest("Forecast", single)), "0xae6aa9a3a6ef3b2fd8759906d59e200797d8aa2167778389e728d6ab282b5547");
  assert.equal(toHex(digest("ForecastBatch", batch)), "0x46fc072d89b2ed1df1c1c97f00b9afb522deba6f8379065c0de10fcc759f7a6f");
  // The same message on the other network is another digest.
  assert.notEqual(toHex(digest("Forecast", single, "testnet")), toHex(digest("Forecast", single)));
});

test("the test key signs the spec's signatures", () => {
  assert.equal(sign(digest("Forecast", single), key(1)), SINGLE_SIG);
  assert.equal(sign(digest("ForecastBatch", batch), key(1)), BATCH_SIG);
});

test("signatures recover to the forecaster, with v as 27/28 or 0/1", () => {
  assert.equal(recover(digest("Forecast", single), SINGLE_SIG), ADDRESS);
  assert.equal(recover(digest("ForecastBatch", batch), BATCH_SIG), ADDRESS);
  assert.equal(recover(digest("Forecast", single), `${SINGLE_SIG.slice(0, -2)}01`), ADDRESS);
  assert.equal(recover(digest("ForecastBatch", batch), `${BATCH_SIG.slice(0, -2)}00`), ADDRESS);
  assert.equal(recover(digest("Forecast", single), `0x${SINGLE_SIG.slice(2).toUpperCase()}`), ADDRESS);
  assert.notEqual(recover(digest("Forecast", single), BATCH_SIG), ADDRESS);
});

test("a nonce as a decimal string or a number hashes the same", () => {
  assert.deepEqual(digest("Forecast", { ...single, nonce: 1763719200000 }), digest("Forecast", single));
});

test("a changed field recovers someone else", () => {
  const moved = { ...batch, forecasts: [batch.forecasts[0], { ...eth, probabilityBps: 3101 }] };
  assert.notEqual(recover(digest("ForecastBatch", moved), BATCH_SIG), ADDRESS);
});

test("malformed signatures are refused", () => {
  const d = digest("Forecast", single);
  assert.throws(() => recover(d, SINGLE_SIG.slice(0, -2)), /65-byte/);
  assert.throws(() => recover(d, `${SINGLE_SIG.slice(0, -2)}1d`), /v is 29/);
  assert.throws(() => recover(d, `0x${"00".repeat(64)}1b`));
});

test("values that do not fit their type are refused", () => {
  assert.throws(() => digest("Forecast", { ...single, probabilityBps: 65536 }), /uint16/);
  assert.throws(() => digest("Forecast", { ...single, nonce: (1n << 64n).toString() }), /uint64/);
  assert.throws(() => digest("Forecast", { ...single, forecaster: "0x1234" }), /address/);
});
