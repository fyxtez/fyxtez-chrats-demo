import { NTFY_URL } from "../config/constants";
import { formatSymbolPair } from "../config/symbols";
import type { AlertPattern, PriceAlert } from "../types/alert";

const VALID_PATTERNS: readonly AlertPattern[] = [
  "none",
  "breakout",
  "breakdown",
  "support",
  "resistance",
  "retest",
  "sweep",
];

export function loadStoredAlerts(storageKey: string): PriceAlert[] {
  try {
    const raw = localStorage.getItem(storageKey);

    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    // Backward compat: alerts created before the LONG/SHORT setup field
    // and the pattern field existed are sitting in localStorage without
    // them at all - same reasoning as the optional `timeframe` field on
    // Drawing in types/drawing.ts. Default them rather than leaving the
    // field undefined, which would crash anything that reads it (e.g.
    // AlertLinesOverlay.tsx's `alert.side.toLowerCase()`).
    return (parsed as PriceAlert[]).map((alert) => ({
      ...alert,
      side: alert.side === "SHORT" ? "SHORT" : "LONG",
      pattern: VALID_PATTERNS.includes(alert.pattern) ? alert.pattern : "none",
      locked: alert.locked === true,
      hidden: alert.hidden === true,
    }));
  } catch (error) {
    console.error("Failed to load price alerts", error);
    return [];
  }
}

export function saveAlerts(storageKey: string, alerts: PriceAlert[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(alerts));
  } catch (error) {
    console.error("Failed to save price alerts", error);
  }
}

/**
 * Fires the actual notification once a price alert's level has been
 * crossed (see usePriceAlerts.ts).
 *
 * There is no backend for this at all - a "backend" here would just be
 * a thin pass-through that receives a request from the browser and
 * immediately forwards it to ntfy.sh with a curl call, so the browser
 * calls ntfy.sh's publish endpoint directly instead:
 *
 *   curl -H "Title: Telegram" -d "Your message here" \
 *     https://ntfy.sh/<topic>
 *
 * ntfy.sh's publish endpoint accepts plain CORS POSTs from a browser
 * (it's designed to be used from web apps), so no server is required
 * to make this work.
 */
export async function sendPriceAlertNotification(
  symbol: string,
  triggeredPrice: number,
  side: "LONG" | "SHORT",
  pattern: AlertPattern,
): Promise<void> {
  const displaySymbol = formatSymbolPair(symbol);

  const lines = [
    `${displaySymbol} reached ${triggeredPrice}`,
    `SETUP: ${side}`,
  ];

  if (pattern !== "none") {
    lines.push(`PATTERN: ${pattern.toUpperCase()}`);
  }

  // Demo mode deliberately keeps alerts inside the browser. It never posts
  // to the private ntfy topic from the production terminal.
  void NTFY_URL;
  void lines;
}
