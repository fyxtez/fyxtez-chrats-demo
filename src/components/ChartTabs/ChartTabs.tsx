import { useEffect, useRef, useState } from "react";
import {
  getSymbolConfig,
  type TradingSymbol,
} from "../../config/constants";
import { getSymbolInfo } from "../../config/symbols";
import { useViewportClampOffset } from "../../hooks/useViewportClampOffset";
import SymbolIcon from "../SymbolIcon/SymbolIcon";
import "./ChartTabs.css";

type ChartTabsProps = {
  tabs: readonly TradingSymbol[];
  activeSymbol: TradingSymbol;
  availableToOpen: readonly TradingSymbol[];
  onActivate: (symbol: TradingSymbol) => void;
  onOpen: (symbol: TradingSymbol) => void;
  onClose: (symbol: TradingSymbol) => void;
  onCloseOthers: (symbol: TradingSymbol) => void;
  onReorder: (draggedSymbol: TradingSymbol, targetSymbol: TradingSymbol) => void;
};

export default function ChartTabs({
  tabs,
  activeSymbol,
  availableToOpen,
  onActivate,
  onOpen,
  onClose,
  onCloseOthers,
  onReorder,
}: ChartTabsProps) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [draggedSymbol, setDraggedSymbol] = useState<TradingSymbol | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addMenuPopoverRef = useRef<HTMLDivElement | null>(null);
  // With few tabs open, the "+" button (and this popover's anchor) can sit
  // far from the screen edge - see useViewportClampOffset for why that
  // otherwise clips the icon/ticker columns off-screen.
  const addMenuOffset = useViewportClampOffset(addMenuPopoverRef, isAddOpen);

  useEffect(() => {
    if (!isAddOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (
        addMenuRef.current &&
        !addMenuRef.current.contains(event.target as Node)
      ) {
        setIsAddOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsAddOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isAddOpen]);

  return (
    <div className="chart-tabs-bar" aria-label="Open chart tabs">
      <div className="chart-tabs-scroll">
        {tabs.map((symbol) => {
          const info = getSymbolInfo(symbol);
          const config = getSymbolConfig(symbol);
          const active = symbol === activeSymbol;

          return (
            <div
              key={symbol}
              className={`chart-tab ${active ? "active" : ""} ${draggedSymbol === symbol ? "dragging" : ""}`}
              draggable
              onDragStart={(event) => {
                setDraggedSymbol(symbol);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", symbol);
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (draggedSymbol && draggedSymbol !== symbol) {
                  onReorder(draggedSymbol, symbol);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggedSymbol(null);
              }}
              onDragEnd={() => setDraggedSymbol(null)}
              onDoubleClick={() => onCloseOthers(symbol)}
            >
              <button
                className="chart-tab-select"
                onClick={() => onActivate(symbol)}
                title={`${info.name} · ${config.source === "binance" ? "Binance" : "MEXC"}${active ? " · active" : ""}`}
              >
                <SymbolIcon symbol={symbol} className="chart-tab-symbol-icon" />
                <span>{info.label}</span>
              </button>

              <button
                className="chart-tab-close"
                aria-label={`Close ${info.label} chart tab`}
                title={tabs.length === 1 ? "At least one chart tab must remain open" : `Close ${info.label}`}
                disabled={tabs.length === 1}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(symbol);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="chart-tab-add-wrap" ref={addMenuRef}>
        <button
          className="chart-tab-add"
          aria-label="Open another chart tab"
          title="Open chart tab"
          disabled={availableToOpen.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            setIsAddOpen((open) => !open);
          }}
        >
          +
        </button>

        {isAddOpen && availableToOpen.length > 0 && (
          <div
            className="chart-tab-add-menu"
            ref={addMenuPopoverRef}
            style={addMenuOffset ? { transform: `translateX(${addMenuOffset}px)` } : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            {availableToOpen.map((symbol) => {
              const info = getSymbolInfo(symbol);
              const config = getSymbolConfig(symbol);
              return (
                <button
                  key={symbol}
                  onClick={() => {
                    setIsAddOpen(false);
                    onOpen(symbol);
                  }}
                >
                  <SymbolIcon symbol={symbol} className="chart-tab-add-icon" />
                  <span className="chart-tab-add-label">{info.label}</span>
                  <span className="chart-tab-add-name">{info.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
