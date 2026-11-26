import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOMAIN_SEPARATOR,
  digest,
  domainSeparatorV2,
  encodeType,
  recover,
  saltOf,
  TYPES,
  TYPES_V2,
  toHex,
  typeHash,
} from "../scripts/lib/eip712.mjs";
import { key, sign } from "./keys.mjs";

const ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

const single = {
  forecaster: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  outcome: 42400,
  probabilityBps: 6200,
  time: 1763719200,
  nonce: "1763719200000",
};
const batch = {
  forecaster: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  forecasts: [
    { outcome: 42400, probabilityBps: 6200 },
    { outcome: 42501, probabilityBps: 3100 },
  ],
  time: 1763719200,
  nonce: "1763719200001",
};
const SINGLE_SIG =
  "0x4d8ddebb9cfe6cfcc6d870809f19364c56e134039c1200cf74004ce6aac7a1ed09c333b798001f1c2cd2d8aa37630592e3d5333abc30b6a479c0db8bd213cd651c";
const BATCH_SIG =
  "0xf905beb040b0c94625daeb3318c3be48580ec010fec6400f70493dcd3e74c6165dd78927190c61761f03214a1b8a2d065b393ae106adf26edd0b359a2ba1bcd71b";

test("the domain separator matches the spec", () => {
  assert.equal(toHex(DOMAIN_SEPARATOR), "0x8c35fadb67824908e8f620e61384ee244830a28d798764768569090f3d929e37");
});

test("type strings and type hashes match the spec", () => {
  assert.equal(
    encodeType("Forecast", TYPES.Forecast),
    "Forecast(address forecaster,uint32 outcome,uint16 probabilityBps,uint64 time,uint64 nonce)",
  );
  assert.equal(
    encodeType("ForecastBatch", TYPES.ForecastBatch),
    "ForecastBatch(address forecaster,ForecastEntry[] forecasts,uint64 time,uint64 nonce)ForecastEntry(uint32 outcome,uint16 probabilityBps)",
  );
  assert.equal(toHex(typeHash("Forecast", TYPES.Forecast)), "0xa8d516c0479c1166e3591b894d95ba27b4c73b848308820d52435e923bd368e6");
  assert.equal(
    toHex(typeHash("ForecastBatch", TYPES.ForecastBatch)),
    "0xff5ca7ea63ac690bc636955ac4763383f2c84c4803111d26b74195eba18aa6f9",
  );
  assert.equal(
    toHex(typeHash("ForecastEntry", TYPES.ForecastBatch)),
    "0x36e1078a25cea9e34eff3e4b746daee80ce54e7d5b97256dbf173dade80130bc",
  );
});

test("digests match the spec", () => {
  assert.equal(toHex(digest("Forecast", single)), "0x9d68b0769b49c457471adea46b361ce9f832bb2e5bbf8199689d357766c9e754");
  assert.equal(toHex(digest("ForecastBatch", batch)), "0x8628ebe750cec7b7704023cfeb8cbfde075fde486849a3ae9c8931fabc83c139");
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
  const moved = { ...batch, forecasts: [batch.forecasts[0], { outcome: 42501, probabilityBps: 3101 }] };
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

test("version 2's salts, domain separators and test vectors match the spec", () => {
  assert.equal(saltOf("mainnet"), "0xc39792a05cff7539d2e0315b8f48f8ba52d0d5633867ed004c25a66c4160eeb4");
  assert.equal(saltOf("testnet"), "0xbefd4257376df87b4238d51baa58cb42138b258e25473b94ced4e206b6acd863");
  assert.equal(toHex(domainSeparatorV2("mainnet")), "0x12e0f52833f9791dcb35db09d561aacc84ec21766e497c7618c159a931379d43");
  assert.equal(toHex(domainSeparatorV2("testnet")), "0xf43fd5402336e8b029dfcac295e17ed1c11f178e45b23c23aada958b01bb18cb");
  assert.equal(
    toHex(typeHash("Forecast", TYPES_V2.Forecast)),
    "0xf17e0807d1ad95830c7ed23f72a0c650744e9d7f4f2b66c28de313920555c836",
  );
  assert.equal(
    toHex(typeHash("ForecastBatch", TYPES_V2.ForecastBatch)),
    "0x5445b9122c3debdb9e5817cea50eac968ca3861f9ad1195f83830640f7579970",
  );
  const btc = { outcome: 42400, market: "BTC above 55,765 on Nov 22 at 06:00 UTC", side: "Yes" };
  const one = { forecaster: single.forecaster, ...btc, probabilityBps: 6200, time: 1763719200, nonce: "1763719200000" };
  const two = {
    forecaster: single.forecaster,
    forecasts: [
      { ...btc, probabilityBps: 6200 },
      { outcome: 42501, market: "ETH above 3,000 on Nov 22 at 06:00 UTC", side: "Yes", probabilityBps: 3100 },
    ],
    time: 1763719200,
    nonce: "1763719200001",
  };
  assert.equal(toHex(digest("Forecast", one, 2)), "0xae6aa9a3a6ef3b2fd8759906d59e200797d8aa2167778389e728d6ab282b5547");
  assert.equal(toHex(digest("ForecastBatch", two, 2)), "0x46fc072d89b2ed1df1c1c97f00b9afb522deba6f8379065c0de10fcc759f7a6f");
  assert.equal(
    sign(digest("Forecast", one, 2), key(1)),
    "0xd16082f21b0a948afb6b6989797d76a8998907650777363ca2311c2912e5c5f3492b0b8d51db819b08f072e57e96d1f2533adc9c441b28bbbdde9f190926e4061c",
  );
  assert.equal(
    sign(digest("ForecastBatch", two, 2), key(1)),
    "0xc1188ccdbc21875662dbb6d048b5a2c6eb160cb54333574cbe91339b98aa59aa5666002a6f785cd2e948bb76d8f2e522c88a592b646ec876e0248ce4a1f45ee11b",
  );
  // The same message on the other network is another digest.
  assert.notEqual(toHex(digest("Forecast", one, 2, "testnet")), toHex(digest("Forecast", one, 2)));
});
