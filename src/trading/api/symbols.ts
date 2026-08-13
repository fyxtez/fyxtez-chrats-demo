export type BackendSymbol = {
  symbol: string; display_symbol: string; market_symbol: string;
  data_source: "binance" | "mexc"; protected: boolean;
};
export type BackendIcon = { symbol: string; url: string; source_url: string; cached_at_ms: number };
type AddSymbolResponse = { created: boolean; symbol: BackendSymbol; icon: BackendIcon | null };
type DeleteSymbolResponse = { deleted: boolean; symbol: BackendSymbol };
type ListIconsResponse = { count: number; max: number; icons: BackendIcon[] };

const STORAGE_KEY = "fyxtez-demo-symbols-v1";
const protectedSymbols = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
const defaults = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "PLUMEUSDT", "ZECUSDT"];

function readSymbols(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const stored = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : defaults;
    const repaired = Array.from(new Set(stored.map(canonicalizeTradingSymbol).filter(Boolean)));
    if (JSON.stringify(repaired) !== JSON.stringify(stored)) writeSymbols(repaired);
    return repaired;
  } catch { return defaults; }
}
function writeSymbols(symbols: string[]): void { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols)); } catch {} }
function model(symbol: string): BackendSymbol {
  return { symbol, display_symbol: symbol, market_symbol: symbol, data_source: "binance", protected: protectedSymbols.has(symbol) };
}

export async function listSymbols(): Promise<BackendSymbol[]> { return readSymbols().map(model); }
export async function addSymbol(value: string): Promise<AddSymbolResponse> {
  const symbol = canonicalizeTradingSymbol(value);
if (!/^[A-Z0-9]{1,24}USDT$/.test(symbol))
    throw new Error("Enter a valid USDT symbol, for example ADAUSDT");
  try {
    await getSymbolFilters(symbol);
  } catch {
    throw new Error(`${symbol} is not available on Binance Futures`);
  }
  const symbols = readSymbols();
  const created = !symbols.includes(symbol);
  if (created) { symbols.push(symbol); writeSymbols(symbols); }
  return { created, symbol: model(symbol), icon: null };
}
export async function deleteSymbol(value: string): Promise<DeleteSymbolResponse> {
  const symbol = canonicalizeTradingSymbol(value);
  if (protectedSymbols.has(symbol)) throw new Error("Built-in demo symbols cannot be removed");
  writeSymbols(readSymbols().filter((item) => item !== symbol));
  return { deleted: true, symbol: model(symbol) };
}
export async function listIcons(): Promise<ListIconsResponse> { return { count: 0, max: 0, icons: [] }; }
export function iconImageUrl(_symbol: string, _cachedAtMs?: number): string { return ""; }
import { getSymbolFilters } from "./exchangeInfo";
import { canonicalizeTradingSymbol } from "../../utils/tradingSymbol";
