import { encodeAbiParameters, keccak256, toHex } from "viem";

/**
 * RiseX order/action encoding — the `hash` that goes into a `VerifyWitness`
 * permit (docs/tasks.md task 6).
 *
 * PROVENANCE: ported line-for-line from `risex-client`'s
 * `src/signing/encoder.ts` (github.com/SmoothBot/risex-ts), translated from
 * `ethers` to `viem` (this app's stack) — NOT reimplemented from a written
 * description. The bit-packing scheme below is exact, security-critical
 * arithmetic; getting it subtly wrong would silently sign the wrong order.
 * Cross-checked before trusting it: a throwaway script ran the ORIGINAL
 * `ethers`-based logic to produce known hash outputs for fixed inputs, and
 * `orderEncoding.test.ts` asserts this viem port reproduces those exact
 * hashes byte-for-byte (see that file's `ETHERS_CROSS_CHECK` fixtures).
 * `risex-client` itself is "unofficial, not production ready" per its own
 * README — this is the best available evidence, not an official spec.
 */

export enum Side {
  Long = 0,
  Short = 1,
}

export enum OrderType {
  Market = 0,
  Limit = 1,
}

export enum TimeInForce {
  GoodTillCancelled = 0,
  GoodTillTime = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 3,
}

export enum StpMode {
  ExpireMaker = 0,
  ExpireTaker = 1,
  ExpireBoth = 2,
  None = 3,
}

export enum MarginMode {
  Cross = 0,
  Isolated = 1,
}

export interface OrderParams {
  market_id: number;
  size_steps: number;
  price_ticks: number;
  side: Side;
  order_type: OrderType;
  time_in_force: TimeInForce;
  post_only: boolean;
  reduce_only: boolean;
  stp_mode: StpMode;
  ttl_units: number;
  builder_id?: number;
  client_order_id?: string;
}

const ACTION_PLACE_ORDER_HASH = keccak256(toHex("RISE_PERPS_PLACE_ORDER_V1"));

const V3_FLAG_PERMIT = 0x01;
const V3_FLAG_BUILDER = 0x02;
const V3_FLAG_CLIENT_ID = 0x04;
const V3_FLAG_PERMIT_ERC1271 = 0x09;
const V3_FLAG_TTL = 0x10;

/**
 * Pack order fields into the 88-bit compressed format (big-endian bit layout):
 * `[87:70] marketId(16) | [69:38] sizeSteps(32) | [37:14] priceTicks(24) |
 * [13:6] orderFlags(8) | [5:1] headerVersion(5, always 1) | [0] reserved(1)`.
 */
function encodeOrderData(p: OrderParams): bigint {
  let orderFlags = 0;
  if (p.side & 1) orderFlags |= 0x01;
  if (p.post_only) orderFlags |= 0x02;
  if (p.reduce_only) orderFlags |= 0x04;
  orderFlags |= (p.stp_mode & 3) << 3;
  orderFlags |= (p.order_type & 1) << 5;
  orderFlags |= (p.time_in_force & 3) << 6;

  const headerVersion = 1;

  let data = 0n;
  data |= BigInt(p.market_id & 0xffff) << 70n;
  data |= BigInt(p.size_steps & 0xffffffff) << 38n;
  data |= BigInt(p.price_ticks & 0xffffff) << 14n;
  data |= BigInt(orderFlags & 0xff) << 6n;
  data |= BigInt((headerVersion & 0x1f) << 1);

  return data;
}

function computeHeaderFlags(
  builderId: number,
  clientOrderId: bigint,
  ttlUnits: number,
  isErc1271 = false,
): number {
  let flags = isErc1271 ? V3_FLAG_PERMIT_ERC1271 : V3_FLAG_PERMIT;
  if (builderId !== 0) flags |= V3_FLAG_BUILDER;
  if (clientOrderId !== 0n) flags |= V3_FLAG_CLIENT_ID;
  if (ttlUnits !== 0) flags |= V3_FLAG_TTL;
  return flags;
}

/** `hash = keccak256(abi.encode(actionTypeHash, headerFlags, orderData, builderId, clientOrderId, ttlUnits))`. */
export function encodeOrder(p: OrderParams, isErc1271 = false): `0x${string}` {
  const orderData = encodeOrderData(p);
  const clientOrderId = BigInt(p.client_order_id ?? "0");
  const headerFlags = computeHeaderFlags(p.builder_id ?? 0, clientOrderId, p.ttl_units, isErc1271);

  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint8" },
      { type: "uint256" },
      { type: "uint16" },
      { type: "uint64" },
      { type: "uint16" },
    ],
    [ACTION_PLACE_ORDER_HASH, headerFlags, orderData, p.builder_id ?? 0, clientOrderId, p.ttl_units],
  );

  return keccak256(encoded);
}

const ACTION_UPDATE_LEVERAGE_HASH = keccak256(toHex("RISE_PERPS_UPDATE_LEVERAGE_V1"));

/**
 * `hash = keccak256(abi.encode(actionTypeHash, uint16(marketId), uint8(leverage)))`.
 *
 * CORRECTED from `risex-client`'s version (`uint256(marketId) + uint128(leverage)`,
 * with no action-type-hash prefix at all) — that was a real bug in the community
 * SDK, not a stylistic difference. Found live: a real "permit signature mismatch"
 * error on `/v1/account/leverage` (the signature recovered to a different
 * address than the actual signer, because the signed hash didn't match what the
 * server independently reconstructs for the same action). The correct formula
 * is sourced from developer.rise.trade's documented reference for this specific
 * endpoint, not re-derived from the SDK — see docs/tasks.md task 6's addendum.
 * `leverage` must be an integer 1-255 (uint8) per that same reference.
 */
export function encodeLeverage(marketId: number, leverage: number): `0x${string}` {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint16" }, { type: "uint8" }],
    [ACTION_UPDATE_LEVERAGE_HASH, marketId, leverage],
  );
  return keccak256(encoded);
}
