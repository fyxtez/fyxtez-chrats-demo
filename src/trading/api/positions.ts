import type { BinanceOrderResponse, TradeOrderType } from "../types";
import {
  addDemoOrder,
  clearDemoOrders,
  closeDemoPosition,
  demoId,
  demoPrice,
  demoPositions,
  openDemoPosition,
  reduceDemoPosition,
} from "../demoStore";

export type PositionSide = "LONG" | "SHORT";
export type OpenPosition = {
  symbol: string; side: PositionSide; leverage: number; quantity: number;
  entry_price: number; mark_price: number; liquidation_price: number | null;
  margin: number; unrealized_pnl: number; roi_pct: number;
};

export type PositionIntentRequest = {
  symbol: string; intent: "ADD" | "REDUCE" | "REVERSE"; orderType?: TradeOrderType;
  price?: number; quantity?: number; leverage?: number; reducePct?: number;
};

export type PositionIntentResponse = {
  intent: "ADD" | "REDUCE" | "REVERSE"; order_type?: TradeOrderType;
  side: "BUY" | "SELL"; submitted_quantity?: number; submitted_price?: number;
  closed_quantity?: number; opened_quantity?: number; remaining_quantity?: number;
  remaining_position_pct?: number; reduce_pct?: number; warning?: string;
  order?: BinanceOrderResponse; close_order?: BinanceOrderResponse; open_order?: BinanceOrderResponse;
};

function orderResponse(symbol: string, side: "BUY" | "SELL", quantity: number, price: number, status = "FILLED"): BinanceOrderResponse {
  const id = demoId();
  return {
    orderId: id, symbol: symbol.toUpperCase(), status, clientOrderId: `demo-${id}`,
    price: String(price), avgPrice: status === "FILLED" ? String(price) : "0",
    origQty: String(quantity), executedQty: status === "FILLED" ? String(quantity) : "0",
    updateTime: Date.now(), transactTime: Date.now(),
  };
}

export function invalidatePositionsCache(): void {}

export async function getPositions(_signal?: AbortSignal, _force = false): Promise<OpenPosition[]> {
  return demoPositions();
}

export async function executePositionIntent(request: PositionIntentRequest, _signal?: AbortSignal): Promise<PositionIntentResponse> {
  const symbol = request.symbol.toUpperCase();
  const current = demoPositions().find((item) => item.symbol === symbol);
  const quantity = Math.max(0, request.quantity ?? current?.quantity ?? 0);
  const price = demoPrice(symbol, request.price);
  const side: "BUY" | "SELL" = current?.side === "SHORT" ? "SELL" : "BUY";

  if (request.intent === "REVERSE") {
    if (!current) throw new Error("No demo position to reverse");
    const reverseSide: "BUY" | "SELL" = current.side === "LONG" ? "SELL" : "BUY";
    const reverseQuantity = current.quantity;
    const closeSide: "BUY" | "SELL" = reverseSide;
    const close_order = orderResponse(symbol, closeSide, current.quantity, price);
    closeDemoPosition(symbol);
    const reversed = openDemoPosition(symbol, reverseSide, reverseQuantity, price, request.leverage);
    const open_order = orderResponse(symbol, reverseSide, reversed.quantity, price);
    return {
      intent: request.intent,
      order_type: request.orderType,
      side: reverseSide,
      closed_quantity: current.quantity,
      opened_quantity: reversed.quantity,
      close_order,
      open_order,
    };
  }

  if (request.intent === "REDUCE") {
    const reducePct = request.reducePct ?? 100;
    const closeSide: "BUY" | "SELL" = current?.side === "LONG" ? "SELL" : "BUY";
    const closedQuantity = (current?.quantity ?? 0) * reducePct / 100;
    if (request.orderType === "LIMIT") {
      const order = orderResponse(symbol, closeSide, closedQuantity, price, "NEW");
      addDemoOrder({
        orderId: order.orderId!, clientOrderId: `fe-red-p${reducePct}-r${100 - reducePct}-${order.orderId}`,
        symbol, side: closeSide, type: "LIMIT", origType: "LIMIT", status: "NEW",
        price: String(price), origQty: String(closedQuantity), timeInForce: "GTC",
        executedQty: "0", avgPrice: "0", time: Date.now(), updateTime: Date.now(), reduceOnly: true,
      });
      return { intent: request.intent, order_type: request.orderType, side: closeSide, submitted_quantity: closedQuantity, submitted_price: price, reduce_pct: reducePct, order };
    }
    reduceDemoPosition(symbol, reducePct);
    const closeOrder = orderResponse(symbol, closeSide, closedQuantity, price);
    return { intent: request.intent, order_type: request.orderType, side: closeSide, submitted_quantity: closedQuantity, closed_quantity: closedQuantity, reduce_pct: reducePct, order: closeOrder, close_order: closeOrder };
  }

  if (request.orderType === "LIMIT") {
    const order = orderResponse(symbol, side, quantity, price, "NEW");
    addDemoOrder({
      orderId: order.orderId!, clientOrderId: `fe-add-${order.orderId}`, symbol, side,
      type: "LIMIT", origType: "LIMIT", status: "NEW", price: String(price), origQty: String(quantity),
      timeInForce: "GTC", executedQty: "0", avgPrice: "0", time: Date.now(), updateTime: Date.now(), reduceOnly: false,
    });
    return { intent: request.intent, order_type: request.orderType, side, submitted_quantity: quantity, submitted_price: price, order };
  }

  openDemoPosition(symbol, side, quantity, price, request.leverage);
  return { intent: request.intent, order_type: request.orderType, side, submitted_quantity: quantity, opened_quantity: quantity, order: orderResponse(symbol, side, quantity, price) };
}

export async function closePositionMarket(symbol: string, _signal?: AbortSignal): Promise<any> {
  const closed = closeDemoPosition(symbol);
  const side: "BUY" | "SELL" = closed?.side === "LONG" ? "SELL" : "BUY";
  const price = closed?.mark_price ?? demoPrice(symbol);
  return { side, order: orderResponse(symbol, side, closed?.quantity ?? 0, price) };
}

export type CloseEverythingResponse = {
  completed: boolean; cancelled_symbols: string[];
  closed_positions: Array<{ symbol: string; closed_quantity: number; side: "BUY" | "SELL"; avg_price: number | null }>;
  errors: Array<{ stage: string; symbol: string; error: string }>;
};

export async function closeEverything(symbol?: string, _signal?: AbortSignal): Promise<CloseEverythingResponse> {
  const targets = demoPositions().filter((position) => !symbol || position.symbol === symbol.toUpperCase());
  const closed_positions = targets.map((position) => {
    closeDemoPosition(position.symbol);
    return { symbol: position.symbol, closed_quantity: position.quantity, side: (position.side === "LONG" ? "SELL" : "BUY") as "BUY" | "SELL", avg_price: position.mark_price };
  });
  const cancelled_symbols = clearDemoOrders(symbol);
  return { completed: true, cancelled_symbols, closed_positions, errors: [] };
}
