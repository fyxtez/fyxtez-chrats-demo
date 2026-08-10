import { useEffect, useMemo, useRef, useState } from "react";
import { getSymbolInfo } from "../../config/symbols";
import {
  getSymbolConfig,
  type ExchangeSource,
  type TradingSymbol,
} from "../../config/constants";
import { addSymbol, deleteSymbol } from "../../trading/api/symbols";
import { clearSymbolLocalMetadata } from "../../utils/symbolMetadata";
import { useViewportClampOffset } from "../../hooks/useViewportClampOffset";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import { canonicalizeTradingSymbol } from "../../utils/tradingSymbol";
import "./SymbolSwitcher.css";

type SymbolSwitcherProps = {
  symbol: TradingSymbol;
  symbols: readonly TradingSymbol[];
  onChangeSymbol: (symbol: TradingSymbol) => void;
  onRegistryChanged: () => Promise<void>;
  /** Closes that symbol's chart tab (if open) once it's actually been deleted from the registry. */
  onSymbolDeleted: (symbol: TradingSymbol) => void;
  /** Keeps the symbol list open while the tutorial is explaining it. */
  tutorialOpen?: boolean;
};

const SOURCE_LABELS: Record<ExchangeSource, string> = {
  binance: "Binance Futures",
  mexc: "MEXC Futures",
};

/**
 * Which order the un-pinned remainder of the list falls back to - see
 * sortRemainder below. Pinned symbols (primary + user-starred) are never
 * affected by this: they always sit in their own fixed section at the top,
 * see orderedSymbols in the component below.
 */
type SortMode = "primary" | "mexc" | "binance" | "symbol" | "name";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "mexc", label: "MEXC" },
  { value: "binance", label: "Binance" },
  { value: "symbol", label: "Alphabet (symbol)" },
  { value: "name", label: "Alphabet (name)" },
];

const PINNED_SYMBOLS_STORAGE_KEY = "fyxtez:pinned-symbols";
const SORT_MODE_STORAGE_KEY = "fyxtez:symbol-sort-mode";

function loadPinnedSymbols(): TradingSymbol[] {
  try {
    const raw = localStorage.getItem(PINNED_SYMBOLS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map(canonicalizeTradingSymbol)
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function savePinnedSymbols(pinned: readonly TradingSymbol[]): void {
  try {
    localStorage.setItem(PINNED_SYMBOLS_STORAGE_KEY, JSON.stringify(pinned));
  } catch {}
}

function loadSortMode(): SortMode {
  try {
    const saved = localStorage.getItem(SORT_MODE_STORAGE_KEY);
    if (
      saved === "primary" ||
      saved === "mexc" ||
      saved === "binance" ||
      saved === "symbol" ||
      saved === "name"
    ) {
      return saved;
    }
  } catch {}
  return "primary";
}

function saveSortMode(mode: SortMode): void {
  try {
    localStorage.setItem(SORT_MODE_STORAGE_KEY, mode);
  } catch {}
}

/**
 * Orders only the UN-pinned remainder of the list (pinned symbols never
 * reach this function - see orderedSymbols in the component below, which
 * splits pinned vs. remainder before this ever runs).
 */
function sortRemainder(
  remainder: readonly TradingSymbol[],
  mode: SortMode,
): TradingSymbol[] {
  // "Primary" is the baseline/no-special-sort option: the remainder is
  // whatever's left of the live registry order (which is itself already
  // alphabetical past the built-ins - see sortRegistry in useSymbol.ts),
  // so there's nothing extra to do here.
  if (mode === "primary") return [...remainder];

  const withMetadata = remainder.map((candidate) => ({
    candidate,
    info: getSymbolInfo(candidate),
    config: getSymbolConfig(candidate),
  }));

  if (mode === "symbol") {
    withMetadata.sort((a, b) => a.info.label.localeCompare(b.info.label));
  } else if (mode === "name") {
    withMetadata.sort((a, b) => a.info.name.localeCompare(b.info.name));
  } else {
    // "mexc" / "binance": that source grouped first, the other source
    // after - each group then falls back to alphabetical-by-symbol so
    // ordering within a group is still predictable rather than whatever
    // order the registry happened to return.
    const preferred: ExchangeSource = mode;
    withMetadata.sort((a, b) => {
      const aFirst = a.config.source === preferred ? 0 : 1;
      const bFirst = b.config.source === preferred ? 0 : 1;
      if (aFirst !== bFirst) return aFirst - bFirst;
      return a.info.label.localeCompare(b.info.label);
    });
  }

  return withMetadata.map((item) => item.candidate);
}

function ExchangeLogo({ source, executionEnabled }: { source: ExchangeSource; executionEnabled: boolean }) {
  const exchange = SOURCE_LABELS[source];
  const explanation = executionEnabled
    ? `${exchange} market data. Orders execute on ${exchange}.`
    : `${exchange} market data. View only — trading is disabled for this chart.`;

  return (
    <span className={`symbol-exchange-logo ${source}`} title={explanation} aria-label={explanation} role="img">
      {source === "binance" ? (
        // Official Binance logomark (four-diamond "B"), per Binance/BNB Chain brand guidelines.
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7.068 12-2.03 2.03L3.003 12l2.03-2.03zm4.935-4.935 3.482 3.483 2.03-2.03L12.003 3 6.485 8.518l2.03 2.03zm6.964 2.905L16.937 12l2.03 2.03 2.03-2.03zm-6.964 6.965L8.52 13.452l-2.03 2.03L12.003 21l5.512-5.518-2.03-2.03zm0-2.905 2.03-2.03-2.03-2.03L9.967 12z" />
        </svg>
      ) : (
        // Stylized MEXC "M" mark in MEXC's brand blue. No open-license vector of MEXC's exact
        // logomark was available to source verbatim, so this is a close hand-built approximation —
        // swap in MEXC's official SVG asset here if pixel-perfect brand accuracy is required.
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.2 17.8V8.7c0-1.5 1.2-2.7 2.7-2.7.9 0 1.7.4 2.2 1.1l3.9 5.2 3.9-5.2A2.7 2.7 0 0 1 20.8 8.7v9.1h-3.6v-6.4l-3.8 5a1.8 1.8 0 0 1-2.8 0l-3.8-5v6.4H3.2Z" />
        </svg>
      )}
    </span>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className={`symbol-pin-icon ${filled ? "filled" : ""}`}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5l3.09 6.26 6.91 1-5 4.87 1.18 6.87L12 17.9l-6.18 3.6 1.18-6.87-5-4.87 6.91-1z" />
    </svg>
  );
}

export default function SymbolSwitcher({ symbol, symbols, onChangeSymbol, onRegistryChanged, onSymbolDeleted, tutorialOpen = false }: SymbolSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinnedSymbols, setPinnedSymbols] = useState<TradingSymbol[]>(loadPinnedSymbols);
  const [sortMode, setSortMode] = useState<SortMode>(loadSortMode);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Keeps the menu on-screen if its 286px width would otherwise overflow
  // past the window edge (the app root clips overflow, so that portion
  // would just disappear instead of scrolling into view).
  const menuOffset = useViewportClampOffset(menuRef, isOpen);
  const info = getSymbolInfo(symbol);
  const activeConfig = getSymbolConfig(symbol);

  useEffect(() => { savePinnedSymbols(pinnedSymbols); }, [pinnedSymbols]);
  useEffect(() => { saveSortMode(sortMode); }, [sortMode]);
  useEffect(() => { setIsOpen(tutorialOpen); }, [tutorialOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (tutorialOpen) return;
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setIsOpen(false); };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, tutorialOpen]);

  /*
   * Pinned section (always first, in this fixed order) + the remainder
   * (sorted per sortMode). Primary/protected symbols are always pinned -
   * they never need to live in `pinnedSymbols` itself, they're pulled
   * straight from the live registry order every time, so this stays
   * correct even if which symbols are protected changes server-side.
   * User-pinned symbols come next, in the order they were pinned
   * (append-only - see togglePin) - clicking a new star always adds it
   * under the last pinned symbol, never re-sorts the pinned section.
   */
  const orderedSymbols = useMemo(() => {
    const protectedInOrder = symbols.filter((candidate) => getSymbolConfig(candidate).protected);
    const protectedSet = new Set(protectedInOrder);

    const userPinned = pinnedSymbols.filter(
      (candidate) => symbols.includes(candidate) && !protectedSet.has(candidate),
    );
    const pinnedSet = new Set([...protectedInOrder, ...userPinned]);

    const remainder = sortRemainder(
      symbols.filter((candidate) => !pinnedSet.has(candidate)),
      sortMode,
    );

    return [...protectedInOrder, ...userPinned, ...remainder];
  }, [symbols, pinnedSymbols, sortMode]);

  const togglePin = (candidate: TradingSymbol) => {
    if (getSymbolConfig(candidate).protected) return; // always pinned, not user-togglable

    setPinnedSymbols((current) =>
      current.includes(candidate)
        ? current.filter((item) => item !== candidate)
        : [...current, candidate], // appended to the end = under the last pinned symbol
    );
  };

  const handleAdd = async () => {
    const value = newSymbol.trim();
    if (!value || pending) return;
    setPending("add");
    setError(null);
    try {
      const result = await addSymbol(value);
      await onRegistryChanged();
      setNewSymbol("");
      onChangeSymbol(canonicalizeTradingSymbol(result.symbol.symbol));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add symbol");
    } finally { setPending(null); }
  };

  const handleDelete = async (candidate: TradingSymbol) => {
    if (pending) return;
    const candidateInfo = getSymbolInfo(candidate);
    setPending(candidate);
    setError(null);
    try {
      if (candidate === symbol) {
        const fallback = symbols.find((item) => item !== candidate);
        if (fallback) onChangeSymbol(fallback);
      }
      await deleteSymbol(candidateInfo.label);
      clearSymbolLocalMetadata(candidate);
      setPinnedSymbols((current) => current.filter((item) => item !== candidate));
      await onRegistryChanged();
      // Now that the delete is confirmed, actually close its tab (if any).
      // useChartTabs no longer auto-prunes tabs against the registry (see
      // its comments) since this app can be pointed at either of two
      // independent backends - so a symbol missing from a sync just means
      // "not on this backend", not "delete its tab". An explicit delete
      // here is the one case that really does mean the tab should go.
      onSymbolDeleted(candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete symbol");
    } finally { setPending(null); }
  };

  return (
    <div className="symbol-switcher" ref={rootRef}>
      <button className={`symbol-switcher-trigger ${isOpen ? "open" : ""}`} title="Switch chart market" onClick={(event) => { event.stopPropagation(); setIsOpen((open) => !open); }}>
        <SymbolIcon symbol={symbol} className="symbol-switcher-symbol-icon" />
        <span>{info.label}</span>
        <ExchangeLogo source={activeConfig.source} executionEnabled={activeConfig.executionEnabled} />
        <span className="symbol-switcher-caret" aria-hidden="true">▾</span>
      </button>

      {isOpen && (
        <div
          className="symbol-switcher-menu"
          ref={menuRef}
          style={menuOffset ? { transform: `translateX(${menuOffset}px)` } : undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="symbol-sort-row">
            <label htmlFor="symbol-sort-select">Sort by</label>
            <select
              id="symbol-sort-select"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="symbol-switcher-list">
            {orderedSymbols.map((candidate) => {
              const candidateInfo = getSymbolInfo(candidate);
              const config = getSymbolConfig(candidate);
              const isActive = candidate === symbol;
              const isPinned = config.protected || pinnedSymbols.includes(candidate);
              return (
                <div key={candidate} className={`symbol-switcher-option ${isActive ? "active" : ""}`}>
                  {config.protected ? (
                    <span
                      className="symbol-pin-button locked"
                      title="Primary market — always pinned"
                      aria-label={`${candidateInfo.label} is a primary market and is always pinned`}
                    >
                      <StarIcon filled />
                    </span>
                  ) : (
                    <button
                      className="symbol-pin-button"
                      title={isPinned ? `Unpin ${candidateInfo.label}` : `Pin ${candidateInfo.label}`}
                      aria-label={isPinned ? `Unpin ${candidateInfo.label}` : `Pin ${candidateInfo.label}`}
                      aria-pressed={isPinned}
                      onClick={(event) => { event.stopPropagation(); togglePin(candidate); }}
                    >
                      <StarIcon filled={isPinned} />
                    </button>
                  )}
                  <button className="symbol-switcher-select" onClick={() => { setIsOpen(false); if (!isActive) onChangeSymbol(candidate); }}>
                    <span className="symbol-switcher-option-symbol">
                      <SymbolIcon symbol={candidate} />
                      <span className="symbol-switcher-option-label">{candidateInfo.label}</span>
                    </span>
                    <span className="symbol-switcher-option-name">{candidateInfo.name}</span>
                  </button>
                  <div className="symbol-switcher-option-actions">
                    <ExchangeLogo source={config.source} executionEnabled={config.executionEnabled} />
                    {!config.protected && (
                      <button className="symbol-delete-button" title={`Delete ${candidateInfo.label}`} aria-label={`Delete ${candidateInfo.label}`} disabled={pending !== null} onClick={() => void handleDelete(candidate)}>
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="symbol-add-row">
            <input value={newSymbol} disabled={pending !== null} placeholder="Symbol (e.g. POWER)" aria-label="Symbol to add" onChange={(event) => setNewSymbol(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") void handleAdd(); }} />
            <button className="symbol-add-button" disabled={!newSymbol.trim() || pending !== null} onClick={() => void handleAdd()}>{pending === "add" ? "…" : "Add"}</button>
          </div>
          {error && <div className="symbol-switcher-error" title={error}>{error}</div>}
        </div>
      )}
    </div>
  );
}
