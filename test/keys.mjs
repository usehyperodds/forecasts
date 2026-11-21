// Well-known test keys (0x00…01 and up). They must never hold funds.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { toHex } from "../scripts/lib/eip712.mjs";

export function key(n) {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
}

export function addressOf(k) {
  return toHex(keccak_256(secp256k1.getPublicKey(k, false).subarray(1)).subarray(12));
}

/** An `eth_signTypedData_v4`-style r ‖ s ‖ v signature, v 27 or 28. */
export function sign(hash, k) {
  const sig = secp256k1.sign(hash, k, { prehash: false, format: "recovered" });
  return toHex(Buffer.concat([sig.subarray(1), Buffer.of(27 + sig[0])]));
}
