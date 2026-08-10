import btcIcon from "../assets/symbols/btc.svg";
import ethIcon from "../assets/symbols/eth.svg";
import solIcon from "../assets/symbols/sol.svg";
import xrpIcon from "../assets/symbols/xrp.svg";
import plumeIcon from "../assets/symbols/plume.svg";
import zecIcon from "../assets/symbols/zec.svg";
import powerIcon from "../assets/symbols/power.jpg";
import { listIcons, iconImageUrl } from "../trading/api/symbols";
import { TRADING_API_BASE_URL_CHANGED_EVENT } from "./constants";

/**
 * Maps a trading pair symbol (e.g. "BTCUSDT", "SOLUSDC") down to a short
 * display label ("BTC", "SOL") and its full name, by stripping the quote
 * asset suffix and looking up the remaining base asset.
 *
 * Only BTC is wired up right now (that's all the app trades), but the
 * mapping already works for any USDT/USDC/etc. pair - add more base
 * assets to BASE_ASSET_NAMES as they're supported.
 */

const QUOTE_ASSET_SUFFIXES = ["USDT", "USDC", "BUSD", "FDUSD", "USD"] as const;

const BASE_ASSET_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  PLUME: "Plume",
  ZEC: "Zcash",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  POWER: "Power Protocol",
};
const BASE_ASSET_ICONS: Record<string, string> = {
  BTC: btcIcon,
  ETH: ethIcon,
  SOL: solIcon,
  XRP: xrpIcon,
  PLUME: plumeIcon,
  ZEC: zecIcon,
  POWER: powerIcon,
};

type RuntimeAssetMetadata = {
  name?: string;
  icon?: string;
};

const runtimeAssetMetadata: Record<string, RuntimeAssetMetadata> = {};

// Deduped in-flight guard only - NOT a permanent cache. The previous
// implementation kept this promise around forever once resolved, so any
// symbol added after the very first refresh (e.g. via SymbolSwitcher's
// "Add" flow) never got its icon fetched again: every later call just
// returned the same already-resolved promise instead of re-hitting the
// backend. Clearing it in `finally` (same pattern already used for
// `backendSelectionCheck` in config/constants.ts) fixes that: concurrent
// callers still dedupe into one in-flight request, but the NEXT call
// after that genuinely re-fetches.
let iconRefreshPromise: Promise<void> | null = null;

/**
 * Best-effort enrichment for dynamically added symbols, using the
 * backend's own icon cache (see GET /api/icons) rather than calling
 * Binance directly from the browser. Calling Binance's asset directory
 * client-side (the previous implementation) depends on Binance sending
 * CORS headers for this app's origin, which it generally does not for
 * arbitrary third-party frontends - the backend, which faces no such
 * restriction, is the reliable source now. It also naturally covers
 * MEXC-sourced symbols staying icon-less consistently (no source ever
 * claims to have one), and every symbol this app can add, not just
 * Binance's general asset list.
 *
 * Failure here never blocks charts: bundled icons / ticker-label
 * fallbacks (see getSymbolInfo below) continue to work regardless.
 */
export async function refreshSymbolMetadata(): Promise<void> {
  if (iconRefreshPromise) return iconRefreshPromise;

  iconRefreshPromise = (async () => {
    try {
      const { icons } = await listIcons();
      for (const icon of icons) {
        const code = icon.symbol.trim().toUpperCase();
        if (!code) continue;
        runtimeAssetMetadata[code] = {
          ...runtimeAssetMetadata[code],
          // Include the cache version so a browser that previously cached a
          // 404/broken response for this symbol requests the repaired bytes.
          icon: iconImageUrl(code, icon.cached_at_ms),
        };
      }
    } catch {
      // Optional cosmetic enrichment only.
    }
  })().finally(() => {
    iconRefreshPromise = null;
  });

  return iconRefreshPromise;
}

// The backend switch (local <-> remote, see config/constants.ts) changes
// TRADING_API_BASE_URL, which iconImageUrl bakes into an ABSOLUTE URL -
// unlike Binance's own URLs, those are backend-specific. Without this,
// icons cached from the previously-selected backend would keep pointing
// at an origin that may now be unreachable (or, worse, coincidentally
// serving something else entirely) after a switch. Clearing the map and
// re-running the fetch keeps icons pointed at whichever backend is
// actually active.
if (typeof window !== "undefined") {
  window.addEventListener(TRADING_API_BASE_URL_CHANGED_EVENT, () => {
    for (const code of Object.keys(runtimeAssetMetadata)) {
      delete runtimeAssetMetadata[code].icon;
    }
    iconRefreshPromise = null;
    void refreshSymbolMetadata();
  });
}


export type SymbolInfo = {
  /** Short ticker to show in the UI, e.g. "BTC". */
  label: string;
  /** Full name, e.g. "Bitcoin" - falls back to the label if unknown. */
  name: string;
  /** Local asset icon URL when one is available. */
  icon?: string;
};

function getBaseAsset(symbol: string): string {
  const quote = QUOTE_ASSET_SUFFIXES.find((suffix) => symbol.endsWith(suffix));
  return quote ? symbol.slice(0, symbol.length - quote.length) : symbol;
}

export function getSymbolInfo(symbol: string): SymbolInfo {
  const base = getBaseAsset(symbol);

  const runtime = runtimeAssetMetadata[base];

  return {
    label: base,
    name: BASE_ASSET_NAMES[base] ?? runtime?.name ?? base,
    icon: BASE_ASSET_ICONS[base] ?? runtime?.icon,
  };
}

/**
 * Formats a trading pair symbol as "BASE/QUOTE" (e.g. "BTCUSDT" ->
 * "BTC/USDT") for places that want the more readable slashed form -
 * currently just the ntfy price-alert notification (see
 * utils/alerts.ts). Falls back to the symbol unchanged if its quote
 * suffix isn't recognized.
 */
export function formatSymbolPair(symbol: string): string {
  const quote = QUOTE_ASSET_SUFFIXES.find((suffix) => symbol.endsWith(suffix));
  if (!quote) return symbol;

  const base = symbol.slice(0, symbol.length - quote.length);
  return `${base}/${quote}`;
}
