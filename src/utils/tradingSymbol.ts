/**
 * Converts user input and legacy persisted values into one canonical Binance
 * futures pair. It also repairs the old demo bug that produced values such as
 * BTCUSDTUSDT by appending the quote asset more than once.
 */
export function canonicalizeTradingSymbol(value: string): string {
  const cleaned = value.trim().toUpperCase().replace(/[\s/_-]+/g, "");
  if (!cleaned) return "";

  const withoutRepeatedUsdt = cleaned.replace(/(?:USDT)+$/, "");
  if (withoutRepeatedUsdt !== cleaned) return `${withoutRepeatedUsdt}USDT`;

  if (cleaned.endsWith("USD")) {
    return `${cleaned.slice(0, -3)}USDT`;
  }

  return `${cleaned}USDT`;
}

export function baseAssetFromTradingSymbol(value: string): string {
  const canonical = canonicalizeTradingSymbol(value);
  return canonical.endsWith("USDT") ? canonical.slice(0, -4) : canonical;
}
