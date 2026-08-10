import type { ConnectionState } from "./useTradingStream";

export function useBackendConnection(): ConnectionState {
  return "connected";
}
