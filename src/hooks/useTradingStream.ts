import type { OrderExecutedEvent } from "../trading/types";

export type ConnectionState = "connecting" | "connected" | "disconnected";
type UseTradingStreamOptions = { onOrderExecuted: (event: OrderExecutedEvent) => void };

/** Demo mode uses browser events and never opens an authenticated trading socket. */
export function useTradingStream(_options: UseTradingStreamOptions): ConnectionState {
  return "connected";
}
