import { apiGet } from "./api";

/**
 * RiseX read layer (InfoClient equivalent — docs/design.md, docs/tasks.md task 3).
 *
 * Implemented directly against RiseX's Full REST API (not the unofficial `risex-client`
 * SDK) since every shape here has been verified with a live request against
 * `ENV.apiUrl`, not copied from docs prose. `risex-client` is still on the table for
 * the write/signing layer (task 5) — revisit there.
 */

/** A single market's static configuration (`GET /v1/markets`). All numeric-looking
 * fields are decimal strings on the wire — do not `Number()` them without going
 * through the sizing module's step/tick rounding (docs/tasks.md task 4). */
export interface MarketConfig {
  name: string;
  quote: `0x${string}`;
  step_size: string;
  step_price: string;
  min_order_size: string;
  unlocked: boolean;
  max_leverage: string;
  maintenance_margin_factor: string;
  open_interest_limit: string;
}

export interface Market {
  market_id: string;
  base_asset_symbol: string;
  quote_asset_symbol: string;
  display_name: string;
  underlying: string;
  config: MarketConfig;
  last_price: string;
  mark_price: string;
  index_price: string;
  quote_volume_24h: string;
  change_24h: string;
  high_24h: string;
  low_24h: string;
  max_position_size: string;
  open_interest: string;
  current_funding_rate: string;
  funding_rate_8h: string;
  accumulated_funding: string;
  funding_interval: string;
  next_funding_time: string;
  active: boolean;
  post_only: boolean;
}

/** `GET /v1/markets` — all configured markets with live pricing/funding data. */
export async function getMarkets(): Promise<Market[]> {
  const { markets } = await apiGet<{ markets: Market[]; cached_at: number }>("/v1/markets");
  return markets;
}

/**
 * `GET /v1/nonce-state/{account}` — the account's current bitmap-nonce anchor and
 * next free bitmap index (docs/tasks.md task 0/5). `nonce_anchor` is a decimal
 * string (uint48 on the wire); `current_bitmap_index` ranges 0-207, or 208 when
 * the anchor's bitmap is exhausted (confirmed live + cross-checked against the
 * `risex-ts` community SDK's `MAX_BITMAP_INDEX = 207`).
 */
export interface NonceState {
  nonce_anchor: string;
  current_bitmap_index: number;
}

export async function getNonceState(account: `0x${string}`): Promise<NonceState> {
  return apiGet<NonceState>(`/v1/nonce-state/${account}`);
}

/**
 * A single order's full detail, notably `avg_price`/`filled_size` — fields
 * `POST /v1/orders/place`'s own response does NOT include (docs/tasks.md task
 * 6). This endpoint is the confirmed way to get the real fill price for lot
 * cost-basis accounting. NOT independently live-verified with a real order_id
 * (placing a real order requires a funded, signed session — out of reach
 * without the user's participation); implemented from
 * `developer.rise.trade/reference/getorder.md`'s documented response shape.
 * Path per that page is `/v1/orders/by-id/{order_id}` (the `llms.txt` index
 * lists it imprecisely as `/v1/orders/{order_id}` — yet another doc-summary
 * discrepancy on this project; the specific reference page is trusted over
 * the index here, but this whole endpoint still needs a real-order check).
 */
export interface Order {
  id: string;
  wide_order_id: string;
  resting_order_id: string;
  client_order_id: string;
  market_id: string;
  sender: `0x${string}`;
  price: string;
  size: string;
  avg_price: string;
  filled_size: string;
  fee_bps: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  time_in_force: "GTC" | "GTT" | "FOK" | "IOC";
  status: "ORDER_STATUS_OPEN" | "ORDER_STATUS_FILLED" | "ORDER_STATUS_CANCELLED" | "ORDER_STATUS_NONE";
}

export async function getOrder(orderId: string): Promise<Order> {
  const { order } = await apiGet<{ order: Order }>(`/v1/orders/by-id/${orderId}`);
  return order;
}

/**
 * `GET /v1/orderbook?market_id={id}&limit={n}` — resolves task 3's earlier gap.
 * The path guessed there (`/v1/markets/orderbook-levels`, various param shapes)
 * was wrong; the real path was found by reading `risex-client`'s `InfoClient`
 * source directly (docs/tasks.md task 9) and confirmed live.
 */
export interface OrderbookLevel {
  price: string;
  quantity: string;
  order_count: number;
}

export interface Orderbook {
  market_id: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  total_bids: string;
  total_asks: string;
}

export async function getOrderbook(marketId: number, limit = 20): Promise<Orderbook> {
  return apiGet<Orderbook>(`/v1/orderbook?market_id=${marketId}&limit=${limit}`);
}

/**
 * `GET /v1/account/position?market_id={id}&account={account}` — also resolves
 * task 3's gap (real path uses query params, not `/v1/account/position/{id}`
 * as originally guessed from doc prose). Confirmed live: an account with no
 * position returns a zeroed/blank position object, not a 404 or null.
 */
export interface Position {
  size: string;
  quote_amount: string;
  side: number;
  margin_mode: number;
  market_id: string;
  avg_entry_price: string;
  mark_price: string;
  leverage: string;
  unrealized_pnl: string;
  liquidation_price: string;
}

export async function getPosition(marketId: number, account: `0x${string}`): Promise<Position> {
  const { position } = await apiGet<{ position: Position }>(
    `/v1/account/position?market_id=${marketId}&account=${account}`,
  );
  return position;
}

/**
 * `GET /v1/account/cross-margin-balance?account={account}` — confirmed via
 * `risex-client`'s `InfoClient.getBalance` source (not independently
 * live-verified with a real funded account — the zero address returns an
 * Internal error rather than a clean zero balance, which reads as "no account
 * state on-chain yet" rather than a wrong endpoint, but this should be
 * re-checked against a real registered account before shipping).
 */
export async function getBalance(account: `0x${string}`): Promise<string> {
  const { balance } = await apiGet<{ balance: string }>(
    `/v1/account/cross-margin-balance?account=${account}`,
  );
  return balance;
}
