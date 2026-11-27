import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLine, merkleRoot, sha256 } from "../scripts/lib/record.mjs";

test("RFC 6962 roots: the spec's vectors", () => {
  assert.equal(merkleRoot([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(merkleRoot(["a"]), "022a6979e6dab7aa5ae4c3e5e45f7e977112a7e63593820dbec1ec738a24f93c");
  assert.equal(merkleRoot(["a", "b"]), "b137985ff484fb600db93107c77b0365c80d78f5b429ded0fd97361d077999eb");
  assert.equal(merkleRoot(["a", "b", "c"]), "36642e73c2540ab121e3a6bf9545b0a24982cd830eb13d3cd19de3ce6c021ec1");
});

test("RFC 6962 roots split at the largest power of two below n", () => {
  const leaf = (s) => sha256(Buffer.of(0), Buffer.from(s));
  const node = (l, r) => sha256(Buffer.of(1), l, r);
  const four = node(node(leaf("a"), leaf("b")), node(leaf("c"), leaf("d")));
  assert.equal(merkleRoot(["a", "b", "c", "d"]), four.toString("hex"));
  assert.equal(merkleRoot(["a", "b", "c", "d", "e"]), node(four, leaf("e")).toString("hex"));
  assert.equal(merkleRoot(["€"]), leaf("€").toString("hex"));
});

test("a line has the spec's keys, in order, without spaces", () => {
  const line =
    '{"id":101,"forecaster":"0x7e5f4552091a69125d5dfcb7b8c2659029395bdf","outcome":42400,"probabilityBps":6200,"acceptedAt":"2025-11-21T10:00:01.234Z","cutoff":"2025-11-22T06:00:00.000Z","fairBps":5810,"fairNote":null,"midBps":6050,"bookTime":"2025-11-21T10:00:00.950Z","batch":17,"index":0,"size":2,"type":"ForecastBatch","time":1763719200,"nonce":"1763719200001","signature":"0xc118…ee11b","version":2,"market":"BTC above 55,765 on Nov 22 at 06:00 UTC","side":"Yes"}';
  const shuffled = Object.fromEntries(Object.entries(JSON.parse(line)).reverse());
  assert.equal(formatLine(shuffled), line);
});
