import type { Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ENV } from "../config/env";
import { apiPost } from "./api";
import { encodeLeverage, encodeOrder, type OrderParams } from "./orderEncoding";
import { getNonceState, type NonceState } from "./risex";

/**
 * RiseX order/action permits and the write calls that use them — the
 * `ExchangeClient` equivalent (docs/design.md, docs/tasks.md task 6).
 *
 * PROVENANCE: the `VerifyWitness` permit construction (nonce rollover at
 * `MAX_BITMAP_INDEX`, the base64 signature encoding, the "fix v" step) is
 * ported line-for-line from `risex-client`'s `src/signing/permit.ts`
 * (github.com/SmoothBot/risex-ts) — NOT reimplemented from prose. See
 * `lib/orderEncoding.ts`'s provenance note; the same caveat applies here:
 * `risex-client` is "unofficial, not production ready" per its own README.
 *
 * IMPORTANT: order permits use a DIFFERENT nonce convention than
 * `lib/agent.ts`'s session-key registration. Registration always advances to a
 * fresh anchor (`current + 1`, bitmap `0`). Order/action permits instead reuse
 * the account's CURRENT anchor/bitmap position, only rolling over to the next
 * anchor (bitmap reset to 0) once the current anchor's bitmap is exhausted
 * (index > 207).
 */

const MAX_BITMAP_INDEX = 207;
const DEFAULT_DEADLINE_SECONDS = 300;

const VERIFY_WITNESS_TYPES = {
  VerifyWitness: [
    { name: "account", type: "address" },
    { name: "target", type: "address" },
    { name: "hash", type: "bytes32" },
    { name: "nonceAnchor", type: "uint48" },
    { name: "nonceBitmap", type: "uint8" },
    { name: "deadline", type: "uint32" },
  ],
} as const;

export interface PermitParams {
  account: Address;
  signer: Address;
  nonce_anchor: number;
  nonce_bitmap_index: number;
  deadline: number;
  signature: string;
  is_erc1271?: boolean;
}

/** Convert a 0x-hex signature to the base64 wire format RiseX expects (matches
 * `risex-client`'s `hexToBase64` — the API does not accept hex signatures).
 * Uses `btoa` (not Node's `Buffer`) since this runs in the browser. */
function hexSignatureToBase64(hex: `0x${string}`): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  let binary = "";
  for (let i = 0; i < clean.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/** Normalize a signature's trailing `v` byte to 27/28 (some signers emit 0/1). */
function fixSignatureV(hex: `0x${string}`): `0x${string}` {
  if (hex.length !== 132) return hex; // not a standard 65-byte r+s+v signature
  const vByte = Number.parseInt(hex.slice(130, 132), 16);
  if (vByte >= 27) return hex;
  const fixed = (vByte + 27).toString(16).padStart(2, "0");
  return (hex.slice(0, 130) + fixed) as `0x${string}`;
}

/**
 * Sign a `VerifyWitness` permit over `hash` with the session key, using the
 * account's CURRENT nonce position (rolling to a fresh anchor only once the
 * bitmap is exhausted — see module doc comment).
 */
export async function buildPermit(
  hash: `0x${string}`,
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
  nonceState: NonceState,
  deadlineSeconds = DEFAULT_DEADLINE_SECONDS,
): Promise<PermitParams> {
  const domain = ENV.eip712Domain;
  if (!domain) throw new Error(`No EIP-712 domain configured for network "${ENV.network}"`);

  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  let nonceAnchor = Number(nonceState.nonce_anchor);
  let nonceBitmap = nonceState.current_bitmap_index;
  if (nonceBitmap > MAX_BITMAP_INDEX) {
    nonceAnchor += 1;
    nonceBitmap = 0;
  }

  const signature = fixSignatureV(
    await signerAccount.signTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: VERIFY_WITNESS_TYPES,
      primaryType: "VerifyWitness",
      message: {
        account: masterAddress,
        target: ENV.routerAddress,
        hash,
        nonceAnchor,
        nonceBitmap,
        deadline,
      },
    }),
  );

  return {
    account: masterAddress,
    signer: signerAccount.address,
    nonce_anchor: nonceAnchor,
    nonce_bitmap_index: nonceBitmap,
    deadline,
    signature: hexSignatureToBase64(signature),
  };
}

async function createPermitForHash(
  hash: `0x${string}`,
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
  nonce?: NonceState,
): Promise<PermitParams> {
  const nonceState = nonce ?? (await getNonceState(masterAddress));
  return buildPermit(hash, signerAccount, masterAddress, nonceState);
}

export interface OrderResponse {
  order_id: string;
  tx_hash: string;
  block_number: string;
  sc_order_id: string;
  filled_quantity: string;
  message?: string;
  filled_percent?: string;
}

/** `POST /v1/orders/place` — signs and submits an order permit. */
export async function placeOrder(
  orderParams: OrderParams,
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
  nonce?: NonceState,
): Promise<OrderResponse> {
  const hash = encodeOrder(orderParams);
  const permit = await createPermitForHash(hash, signerAccount, masterAddress, nonce);

  return apiPost<OrderResponse>("/v1/orders/place", {
    market_id: orderParams.market_id,
    side: orderParams.side,
    order_type: orderParams.order_type,
    price_ticks: orderParams.price_ticks,
    size_steps: orderParams.size_steps,
    time_in_force: orderParams.time_in_force,
    post_only: orderParams.post_only,
    reduce_only: orderParams.reduce_only,
    stp_mode: orderParams.stp_mode,
    ttl_units: orderParams.ttl_units,
    client_order_id: orderParams.client_order_id ?? "0",
    builder_id: orderParams.builder_id ?? 0,
    permit,
  });
}

/**
 * `POST /v1/account/leverage` — signs and submits a leverage-update permit.
 *
 * NOTE: unlike `placeOrder`, this endpoint's signed-permit field is named
 * `permit_params`, not `permit`. Confirmed two ways: the live API's own error
 * ("permit_params is required") when a user hit this in testing, and
 * developer.rise.trade's OpenAPI-derived reference for this endpoint
 * specifically. `risex-client`'s source (the basis for this file's permit
 * logic) uses `permit` here too — this is a real bug in that community SDK,
 * not just a naming choice; the API is inconsistent field-naming across
 * endpoints (`/v1/orders/place` really does use `permit`, confirmed
 * separately), so don't assume this generalizes without checking each
 * endpoint's own reference page.
 */
export async function updateLeverage(
  marketId: number,
  leverage: number,
  signerAccount: PrivateKeyAccount,
  masterAddress: Address,
  nonce?: NonceState,
): Promise<unknown> {
  const hash = encodeLeverage(marketId, leverage);
  const permit_params = await createPermitForHash(hash, signerAccount, masterAddress, nonce);

  return apiPost("/v1/account/leverage", {
    market_id: marketId,
    leverage: String(leverage),
    permit_params,
  });
}
