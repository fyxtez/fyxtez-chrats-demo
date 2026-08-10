import type { TradingStreamEvent } from "./types";
import { parseOrderJsonText } from "./api/safeJson";

export function getTradingWebSocketUrl(): string {
  throw new Error("Authenticated trading streams are disabled in demo mode");
}

export function parseTradingStreamEvent(raw: string): TradingStreamEvent | null {
  try {
    // FIX: this used to be a plain JSON.parse(raw), which silently
    // corrupts order_id in ORDER_EXECUTED events the exact same way
    // every other place in this app was hit by it - see
    // parseOrderJsonText's own comment for the full story. This is a
    // live push event carrying a fill's order_id in real time, so it's
    // just as exposed as any HTTP response.
    const event = parseOrderJsonText(raw) as Partial<TradingStreamEvent>;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      return null;
    }
    return event as TradingStreamEvent;
  } catch {
    return null;
  }
}
