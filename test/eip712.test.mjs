import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMAIN_SEPARATOR, digest, encodeType, recover, toHex, TYPES, typeHash } from "../scripts/lib/eip712.mjs";
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

test("domain separator", () => {
  assert.equal(toHex(DOMAIN_SEPARATOR), "0x8c35fadb67824908e8f620e61384ee244830a28d798764768569090f3d929e37");
});

test("type strings and hashes", () => {
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

test("digests", () => {
  assert.equal(toHex(digest("Forecast", single)), "0x9d68b0769b49c457471adea46b361ce9f832bb2e5bbf8199689d357766c9e754");
  assert.equal(toHex(digest("ForecastBatch", batch)), "0x8628ebe750cec7b7704023cfeb8cbfde075fde486849a3ae9c8931fabc83c139");
});

test("the test key signs the contract's signatures", () => {
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
