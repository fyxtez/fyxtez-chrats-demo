import type {
  AutoMarketOrderResponse, ModifyLimitOrderRequest, ModifyLimitOrderResponse,
  OrderSide, PlaceLimitOrderResponse, PlaceMarketOrderResponse, RepriceReduceOrderResponse,
} from "../types";
import {
  addDemoOrder, demoId, demoOrders, demoPositions, demoPrice, openDemoPosition,
  reduceDemoPosition, removeDemoOrder, updateDemoOrder,
} from "../demoStore";

export type OpenOrder = {
  orderId: string; clientOrderId: string; symbol: string; side: OrderSide;
  type: string; origType: string; status: string; price: string; origQty: string;
  timeInForce: "GTC" | "IOC" | "FOK" | "GTX"; executedQty: string; avgPrice: string;
  time: number; updateTime: number; reduceOnly: boolean;
};

function responseOrder(symbol: string, side: OrderSide, quantity: number, price: number, status: string, clientOrderId: string) {
  return {
    orderId: demoId(), symbol: symbol.toUpperCase(), status, clientOrderId,
    price: String(price), avgPrice: status === "FILLED" ? String(price) : "0",
    origQty: String(quantity), executedQty: status === "FILLED" ? String(quantity) : "0",
    updateTime: Date.now(), transactTime: Date.now(),
  };
}

function pendingOrder(symbol: string, side: OrderSide, price: number, quantity: number, clientOrderId: string, reduceOnly = false): OpenOrder {
  return {
    orderId: demoId(), clientOrderId, symbol: symbol.toUpperCase(), side,
    type: "LIMIT", origType: "LIMIT", status: "NEW", price: String(price), origQty: String(quantity),
    timeInForce: "GTC", executedQty: "0", avgPrice: "0", time: Date.now(), updateTime: Date.now(), reduceOnly,
  };
}

export type PlaceMarketOrderInput = { symbol: string; side: OrderSide; quantity: number; leverage?: number; price?: number };
export async function placeMarketOrder({ symbol, side, quantity, leverage = 2, price }: PlaceMarketOrderInput): Promise<PlaceMarketOrderResponse> {
  const fillPrice = demoPrice(symbol, price);
  openDemoPosition(symbol, side, quantity, fillPrice, leverage);
  return { submitted_quantity: quantity, applied_leverage: leverage, sizing: { demo: true }, order: responseOrder(symbol, side, quantity, fillPrice, "FILLED", `demo-market-${Date.now()}`) };
}

export type PlaceLimitOrderInput = { symbol: string; side: OrderSide; price: number; quantity: number; leverage?: number };
export async function placeLimitOrder({ symbol, side, price, quantity, leverage = 2 }: PlaceLimitOrderInput): Promise<PlaceLimitOrderResponse> {
  const order = pendingOrder(symbol, side, price, quantity, `fe-entry-${side === "BUY" ? "long" : "short"}-${Date.now()}`);
  addDemoOrder(order);
  return { submitted_quantity: quantity, submitted_price: price, applied_leverage: leverage, sizing: { demo: true }, order: { ...responseOrder(symbol, side, quantity, price, "NEW", order.clientOrderId), orderId: order.orderId } };
}

export type PlaceAutoMarketOrderInput = { symbol: string; side: OrderSide; stopLoss: number; price?: number };
export async function placeAutoMarketOrder({ symbol, side, stopLoss, price }: PlaceAutoMarketOrderInput): Promise<AutoMarketOrderResponse> {
  const entry = demoPrice(symbol, price);
  const leverage = 5;
  const quantity = 50 / entry;
  openDemoPosition(symbol, side, quantity, entry, leverage);
  return {
    symbol: symbol.toUpperCase(), side, stop_loss: stopLoss, entry_reference_price: entry,
    stop_distance: Math.abs(entry - stopLoss), stop_distance_pct: Math.abs(entry - stopLoss) / entry * 100,
    margin_pct: 0.02, margin_used: 10, theoretical_max_leverage: leverage, safe_stop_leverage: leverage,
    exchange_max_leverage: 50, applied_leverage: leverage, submitted_quantity: quantity, notional: 50,
    estimated_loss_at_stop: quantity * Math.abs(entry - stopLoss), client_order_id: `demo-auto-${Date.now()}`,
    stop_order_created: false, order: responseOrder(symbol, side, quantity, entry, "FILLED", `demo-auto-${Date.now()}`),
  };
}

export async function modifyLimitOrder(symbol: string, orderId: string, payload: ModifyLimitOrderRequest): Promise<ModifyLimitOrderResponse> {
  const order = updateDemoOrder(orderId, { side: payload.side, price: String(payload.price), origQty: String(payload.quantity), timeInForce: payload.time_in_force });
  return { submitted_quantity: payload.quantity, submitted_price: payload.price, order: { ...responseOrder(symbol, payload.side, payload.quantity, payload.price, "NEW", order.clientOrderId), orderId } };
}

export async function repriceReduceOrder(symbol: string, orderId: string, payload: { price: number; client_order_id?: string; reduce_pct?: number }): Promise<RepriceReduceOrderResponse> {
  const order = updateDemoOrder(orderId, { price: String(payload.price), ...(payload.client_order_id ? { clientOrderId: payload.client_order_id } : {}) });
  return { old_order_id: orderId, submitted_quantity: Number(order.origQty), submitted_price: payload.price, order: { ...responseOrder(symbol, order.side, Number(order.origQty), payload.price, "NEW", order.clientOrderId), orderId } };
}

export async function cancelOrder(_symbol: string, orderId: string): Promise<unknown> { removeDemoOrder(orderId); return { demo: true }; }
export function invalidateOpenOrdersCache(): void {}
export async function getOpenOrders(symbol?: string, _signal?: AbortSignal, _force = false): Promise<OpenOrder[]> { return demoOrders(symbol); }

export type UpdateReduceOrderResponse = {
  old_order_id: string; requested_reduce_pct?: number; reduce_pct: number; submitted_quantity: number;
  submitted_price: number; remaining_quantity: number; remaining_position_pct: number;
  order: { orderId?: string; clientOrderId?: string };
};
export async function updateReduceOrder(_symbol: string, orderId: string, reducePct: number): Promise<UpdateReduceOrderResponse> {
  const order = updateDemoOrder(orderId, { clientOrderId: `fe-red-p${reducePct}-r${100 - reducePct}-${orderId}` });
  return { old_order_id: orderId, requested_reduce_pct: reducePct, reduce_pct: reducePct, submitted_quantity: Number(order.origQty), submitted_price: Number(order.price), remaining_quantity: Number(order.origQty), remaining_position_pct: 100 - reducePct, order: { orderId, clientOrderId: order.clientOrderId } };
}

export type ChaseLimitOrderResponse = { chased_order_id: string; side: OrderSide; remaining_quantity: number; market_order: { orderId?: string; symbol?: string; status?: string; avgPrice?: string; price?: string; executedQty?: string; origQty?: string; updateTime?: number | null; transactTime?: number | null } };
export async function chaseLimitOrder(symbol: string, orderId: string): Promise<ChaseLimitOrderResponse> {
  const order = demoOrders().find((item) => item.orderId === orderId);
  if (!order) throw new Error("Demo order no longer exists");
  removeDemoOrder(orderId);
  const quantity = Math.max(0, Number(order.origQty) - Number(order.executedQty));
  const price = demoPrice(symbol);
  if (order.reduceOnly) {
    const current = demoPositions().find((item) => item.symbol === symbol.toUpperCase());
    const pct = current && current.quantity > 0
      ? Math.min(100, quantity / current.quantity * 100)
      : 100;
    reduceDemoPosition(symbol, pct);
  } else {
    openDemoPosition(symbol, order.side, quantity, price);
  }
  return { chased_order_id: orderId, side: order.side, remaining_quantity: quantity, market_order: { orderId: demoId(), symbol: symbol.toUpperCase(), status: "FILLED", avgPrice: String(price), price: String(price), executedQty: String(quantity), origQty: String(quantity), updateTime: Date.now(), transactTime: Date.now() } };
}

export type FullStopLossResponse = { symbol: string; side: OrderSide; trigger_price: number; close_position: true; algo: { algoId?: string | null; clientAlgoId?: string | null; algoStatus?: string | null; symbol?: string | null } };
export async function placeFullStopLoss(input: { symbol: string; side: OrderSide; triggerPrice: number }): Promise<FullStopLossResponse> {
  return { symbol: input.symbol.toUpperCase(), side: input.side, trigger_price: input.triggerPrice, close_position: true, algo: { algoId: demoId(), clientAlgoId: `demo-sl-${Date.now()}`, algoStatus: "NEW", symbol: input.symbol.toUpperCase() } };
}
export async function cancelConditionalOrder(_symbol: string, _algoId: string): Promise<unknown> { return { demo: true }; }
