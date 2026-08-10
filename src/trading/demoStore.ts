import type { OpenOrder } from "./api/orders";
import type { OpenPosition } from "./api/positions";
import type { SizingConfig } from "./api/sizing";
import { loadSavedStop, saveStop } from "./stopLoss";

const STORAGE_KEY = "fyxtez-demo-trading-state-v1";
const STARTING_BALANCE = 10_000;

type DemoState = {
  balance: number;
  positions: OpenPosition[];
  orders: OpenOrder[];
  leverage: Record<string, number>;
  sizing: SizingConfig;
};

const fallbackPrices: Record<string, number> = {
  BTCUSDT: 118_500,
  ETHUSDT: 4_250,
  SOLUSDT: 182,
  XRPUSDT: 3.15,
  ZECUSDT: 42,
  PLUMEUSDT: 0.13,
};

const defaultState = (): DemoState => ({
  balance: STARTING_BALANCE,
  positions: [],
  orders: [],
  leverage: {},
  sizing: { margin_pct: 0.02, leverage_safety: 0.98, max_leverage: 50 },
});

function load(): DemoState {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<DemoState> | null;
    if (!parsed) return defaultState();
    return {
      ...defaultState(),
      ...parsed,
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      leverage: parsed.leverage ?? {},
      sizing: { ...defaultState().sizing, ...(parsed.sizing ?? {}) },
    };
  } catch {
    return defaultState();
  }
}

let state = load();
let nextId = Date.now();

function save(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

export function demoId(): string {
  nextId += 1;
  return String(nextId);
}

export function demoPrice(symbol: string, preferred?: number): number {
  if (Number.isFinite(preferred) && Number(preferred) > 0) return Number(preferred);
  const position = state.positions.find((item) => item.symbol === symbol.toUpperCase());
  return position?.mark_price || fallbackPrices[symbol.toUpperCase()] || 100;
}

export function demoBalance(): number { return state.balance; }
export function demoSizing(): SizingConfig { return { ...state.sizing }; }
export function setDemoSizing(value: SizingConfig): SizingConfig {
  state.sizing = { ...value };
  save();
  return demoSizing();
}

export function demoLeverage(symbol: string): number {
  return state.leverage[symbol.toUpperCase()] ?? 2;
}
export function setDemoLeverage(symbol: string, leverage: number): number {
  state.leverage[symbol.toUpperCase()] = Math.max(1, Math.round(leverage));
  save();
  return state.leverage[symbol.toUpperCase()];
}

export function demoPositions(): OpenPosition[] {
  for (const position of state.positions) ensureDemoProtection(position);
  save();
  return state.positions.map((position) => ({ ...position }));
}

export function openDemoPosition(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  price?: number,
  leverage?: number,
): OpenPosition {
  const normalized = symbol.toUpperCase();
  const mark = demoPrice(normalized, price);
  const lev = Math.max(1, Math.round(leverage ?? demoLeverage(normalized)));
  const direction = side === "BUY" ? "LONG" : "SHORT";
  const existing = state.positions.find((item) => item.symbol === normalized);
  const nextQty = Math.max(0, quantity);

  if (existing && existing.side === direction) {
    const total = existing.quantity + nextQty;
    existing.entry_price = total > 0
      ? ((existing.entry_price * existing.quantity) + (mark * nextQty)) / total
      : mark;
    existing.quantity = total;
    existing.mark_price = mark;
    existing.leverage = lev;
    existing.margin = (total * mark) / lev;
    existing.unrealized_pnl = 0;
    existing.roi_pct = 0;
    ensureDemoProtection(existing);
    save();
    return { ...existing };
  }

  if (existing) state.positions = state.positions.filter((item) => item !== existing);
  const margin = (nextQty * mark) / lev;
  const position: OpenPosition = {
    symbol: normalized,
    side: direction,
    leverage: lev,
    quantity: nextQty,
    entry_price: mark,
    mark_price: mark,
    liquidation_price: direction === "LONG" ? mark * (1 - 0.9 / lev) : mark * (1 + 0.9 / lev),
    margin,
    unrealized_pnl: 0,
    roi_pct: 0,
  };
  state.positions.push(position);
  ensureDemoProtection(position);
  save();
  return { ...position };
}

export function reduceDemoPosition(symbol: string, pct = 100): OpenPosition | null {
  const normalized = symbol.toUpperCase();
  const position = state.positions.find((item) => item.symbol === normalized);
  if (!position) return null;
  const remaining = position.quantity * Math.max(0, 1 - pct / 100);
  if (remaining <= 1e-8) {
    state.positions = state.positions.filter((item) => item !== position);
    state.orders = state.orders.filter((order) => order.symbol !== normalized || !order.reduceOnly);
    saveStop(null, normalized);
    save();
    return null;
  }
  position.quantity = remaining;
  position.margin = (remaining * position.mark_price) / position.leverage;
  ensureDemoProtection(position);
  save();
  return { ...position };
}

export function closeDemoPosition(symbol: string): OpenPosition | null {
  const existing = state.positions.find((item) => item.symbol === symbol.toUpperCase());
  reduceDemoPosition(symbol, 100);
  return existing ? { ...existing } : null;
}

export function demoOrders(symbol?: string): OpenOrder[] {
  const normalized = symbol?.toUpperCase();
  return state.orders
    .filter((order) => !normalized || order.symbol === normalized)
    .map((order) => ({ ...order }));
}

export function addDemoOrder(order: OpenOrder): OpenOrder {
  state.orders.push(order);
  save();
  return { ...order };
}

export function updateDemoOrder(orderId: string, patch: Partial<OpenOrder>): OpenOrder {
  const order = state.orders.find((item) => item.orderId === orderId);
  if (!order) throw new Error("Demo order no longer exists");
  Object.assign(order, patch, { updateTime: Date.now() });
  save();
  return { ...order };
}

export function removeDemoOrder(orderId: string): void {
  state.orders = state.orders.filter((item) => item.orderId !== orderId);
  save();
}

export function clearDemoOrders(symbol?: string): string[] {
  const normalized = symbol?.toUpperCase();
  const removed = state.orders.filter((order) => !normalized || order.symbol === normalized);
  state.orders = state.orders.filter((order) => normalized && order.symbol !== normalized);
  save();
  return [...new Set(removed.map((order) => order.symbol))];
}

function ensureDemoProtection(position: OpenPosition): void {
  const closeSide = position.side === "LONG" ? "SELL" : "BUY";
  const existingTp = state.orders.find(
    (order) => order.symbol === position.symbol && order.reduceOnly,
  );

  if (!existingTp) {
    const id = demoId();
    const takeProfit = position.side === "LONG"
      ? position.entry_price * 1.02
      : position.entry_price * 0.98;
    state.orders.push({
      orderId: id,
      clientOrderId: `fe-red-p100-r0-${id}`,
      symbol: position.symbol,
      side: closeSide,
      type: "LIMIT",
      origType: "LIMIT",
      status: "NEW",
      price: String(takeProfit),
      origQty: String(position.quantity),
      timeInForce: "GTC",
      executedQty: "0",
      avgPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: true,
    });
  } else {
    existingTp.origQty = String(position.quantity);
    existingTp.updateTime = Date.now();
  }

  const savedStop = loadSavedStop(position.symbol);
  if (!savedStop || savedStop.side !== closeSide) {
    const stop = position.side === "LONG"
      ? position.entry_price * 0.99
      : position.entry_price * 1.01;
    saveStop({
      symbol: position.symbol,
      side: closeSide,
      triggerPrice: stop,
      algoId: demoId(),
    }, position.symbol);
  }
}

/**
 * Feeds public market prices into the browser-local paper engine. Besides
 * keeping PNL alive, this fills crossed demo limits and triggers demo stops.
 */
export function processDemoMarketPrice(symbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const normalized = symbol.toUpperCase();
  const position = state.positions.find((item) => item.symbol === normalized);

  if (position) {
    position.mark_price = price;
    const direction = position.side === "LONG" ? 1 : -1;
    position.unrealized_pnl = (price - position.entry_price) * position.quantity * direction;
    position.roi_pct = position.margin > 0 ? position.unrealized_pnl / position.margin * 100 : 0;

    const stop = loadSavedStop(normalized);
    const stopTriggered = stop && (
      (position.side === "LONG" && price <= stop.triggerPrice) ||
      (position.side === "SHORT" && price >= stop.triggerPrice)
    );
    if (stopTriggered) {
      reduceDemoPosition(normalized, 100);
      saveStop(null, normalized);
      save();
      window.dispatchEvent(new Event("account-state-changed"));
      window.dispatchEvent(new Event("orders-state-changed"));
      window.dispatchEvent(new Event("trading-state-changed"));
      return;
    }
  }

  const crossed = state.orders.filter((order) => {
    if (order.symbol !== normalized || order.status !== "NEW") return false;
    const limit = Number(order.price);
    return order.side === "BUY" ? price <= limit : price >= limit;
  });

  for (const order of crossed) {
    const quantity = Math.max(0, Number(order.origQty) - Number(order.executedQty));
    if (order.reduceOnly) {
      const current = state.positions.find((item) => item.symbol === normalized);
      const pct = current && current.quantity > 0
        ? Math.min(100, quantity / current.quantity * 100)
        : 100;
      reduceDemoPosition(normalized, pct);
    } else {
      openDemoPosition(normalized, order.side, quantity, Number(order.price), demoLeverage(normalized));
    }
    state.orders = state.orders.filter((item) => item.orderId !== order.orderId);
  }

  save();
  if (crossed.length > 0) {
    window.dispatchEvent(new Event("account-state-changed"));
    window.dispatchEvent(new Event("orders-state-changed"));
    window.dispatchEvent(new Event("trading-state-changed"));
  }
}

export function clearDemoTradingState(): void {
  state = defaultState();
  save();
  window.dispatchEvent(new Event("account-state-changed"));
  window.dispatchEvent(new Event("orders-state-changed"));
}
