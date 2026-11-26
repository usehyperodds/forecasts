import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Version 1 (legacy): the same domain on every deployment, markets by number only. */
export const DOMAIN = { name: "Hyperodds Forecasts", version: "1" };

const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
};

const DOMAIN_V2_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "salt", type: "bytes32" },
  ],
};

/** Version 2's salt is keccak256("hyperodds:" + network). usehyperodds.com's records are mainnet's. */
export function saltOf(network) {
  return toHex(keccak_256(new TextEncoder().encode(`hyperodds:${network}`)));
}

export function domainV2(network = "mainnet") {
  return { name: "Hyperodds Forecasts", version: "2", salt: saltOf(network) };
}

export const TYPES = {
  Forecast: {
    Forecast: [
      { name: "forecaster", type: "address" },
      { name: "outcome", type: "uint32" },
      { name: "probabilityBps", type: "uint16" },
      { name: "time", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
  },
  ForecastBatch: {
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
  },
};

/** Version 2: each forecast also names its market's title and the side its probability is for. */
export const TYPES_V2 = {
  Forecast: {
    Forecast: [
      { name: "forecaster", type: "address" },
      { name: "outcome", type: "uint32" },
      { name: "market", type: "string" },
      { name: "side", type: "string" },
      { name: "probabilityBps", type: "uint16" },
      { name: "time", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
  },
  ForecastBatch: {
    ForecastBatch: [
      { name: "forecaster", type: "address" },
      { name: "forecasts", type: "ForecastEntry[]" },
      { name: "time", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
    ForecastEntry: [
      { name: "outcome", type: "uint32" },
      { name: "market", type: "string" },
      { name: "side", type: "string" },
      { name: "probabilityBps", type: "uint16" },
    ],
  },
};

const utf8 = new TextEncoder();

export function toHex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function fromHex(hex) {
  return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}

function concat(parts) {
  return Uint8Array.from(Buffer.concat(parts));
}

function word(n) {
  const out = new Uint8Array(32);
  for (let i = 31; n > 0n; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

function dependencies(type, types, found = new Set()) {
  if (found.has(type) || !types[type]) return found;
  found.add(type);
  for (const field of types[type]) dependencies(field.type.replace(/\[\]$/, ""), types, found);
  return found;
}

export function encodeType(primary, types) {
  const [, ...rest] = dependencies(primary, types);
  return [primary, ...rest.sort()]
    .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

export function typeHash(primary, types) {
  return keccak_256(utf8.encode(encodeType(primary, types)));
}

function encodeValue(type, value, types) {
  if (type.endsWith("[]")) {
    const inner = type.slice(0, -2);
    return keccak_256(concat(value.map((v) => encodeValue(inner, v, types))));
  }
  if (types[type]) return hashStruct(type, value, types);
  if (type === "string") return keccak_256(utf8.encode(value));
  if (type === "bytes32") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`not 32 bytes: ${value}`);
    return fromHex(value);
  }
  if (type === "address") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`not an address: ${value}`);
    return word(BigInt(value));
  }
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) {
    const n = BigInt(value);
    if (n < 0n || n >> BigInt(uint[1]) !== 0n) throw new Error(`${value} does not fit ${type}`);
    return word(n);
  }
  throw new Error(`unsupported type ${type}`);
}

export function hashStruct(primary, data, types) {
  const fields = types[primary].map((f) => encodeValue(f.type, data[f.name], types));
  return keccak_256(concat([typeHash(primary, types), ...fields]));
}

export const DOMAIN_SEPARATOR = hashStruct("EIP712Domain", DOMAIN, DOMAIN_TYPES);

export function domainSeparatorV2(network = "mainnet") {
  return hashStruct("EIP712Domain", domainV2(network), DOMAIN_V2_TYPES);
}

/**
 * The EIP-712 digest a forecaster signs for a `Forecast` or `ForecastBatch` message: under version 2's
 * domain for `network` and its types when `version` is 2, else version 1's.
 */
export function digest(type, message, version = 1, network = "mainnet") {
  const types = (version === 2 ? TYPES_V2 : TYPES)[type];
  if (!types) throw new Error(`unknown message type ${type}`);
  const separator = version === 2 ? domainSeparatorV2(network) : DOMAIN_SEPARATOR;
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), separator, hashStruct(type, message, types)]));
}

/**
 * The lowercase address that produced a 65-byte `r ‖ s ‖ v` signature over a digest, `v` 27/28 or
 * 0/1. Throws when the bytes are not a signature that recovers.
 */
export function recover(hash, signature) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("not a 65-byte hex signature");
  const bytes = fromHex(signature);
  const v = bytes[64];
  const bit = v >= 27 ? v - 27 : v;
  if (bit !== 0 && bit !== 1) throw new Error(`v is ${v}; expected 27, 28, 0 or 1`);
  const point = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), "compact")
    .addRecoveryBit(bit)
    .recoverPublicKey(hash);
  return toHex(keccak_256(point.toBytes(false).subarray(1)).subarray(12));
}
