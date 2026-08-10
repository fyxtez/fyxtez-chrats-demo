import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import type { ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { AutoMarketDraft } from "../../hooks/useTradeMenu";
import type { TradeSide } from "../../trading/types";
import { startPacedLoop } from "../../utils/pacedLoop";
import "./AutoMarketOverlay.css";

type AutoMarketOverlayProps = {
  draft: AutoMarketDraft;
  isSubmitting: boolean;
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  marketPriceRef: MutableRefObject<number | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  coordTimeToX: (time: UTCTimestamp) => number | null;
  /**
   * Decimal precision for the active symbol's real tick size (see
   * trading/api/exchangeInfo.ts / useMarketData.ts). BTC's price only
   * ever needed whole numbers, but that's wrong for lower-priced symbols
   * like XRP, which need several decimals to show a meaningful price.
   */
  pricePrecision: number;
  onStopLossChange: (price: number) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

type OverlayCoordinates = {
  left: number;
  width: number;
  entryY: number;
  stopY: number;
  marketPrice: number;
  valid: boolean;
};

// FIX: bumped from 220 - the compact "AUTO LONG/SHORT X.XX%" summary chip
// (shown when the zone is too short vertically to fit the full-size
// label + buttons) was getting its "%" ellipsized off the end because
// there wasn't enough leftover width once the EXECUTE/CANCEL button
// columns were subtracted. The extra 20px goes entirely to that summary
// column (see .auto-market-controls.compact's grid-template-columns in
// AutoMarketOverlay.css, which reserves fixed widths only for the two
// buttons and gives the summary whatever's left via minmax(0, 1fr)).
const AUTO_MARKET_ZONE_WIDTH_PX = 240;

function formatPrice(price: number, pricePrecision: number) {
  return price.toLocaleString(undefined, {
    minimumFractionDigits: pricePrecision,
    maximumFractionDigits: pricePrecision,
  });
}


function isValidStop(side: TradeSide, marketPrice: number, stopLoss: number) {
  return side === "BUY" ? stopLoss < marketPrice : stopLoss > marketPrice;
}

export default function AutoMarketOverlay({
  draft,
  isSubmitting,
  chartWrapRef,
  candleRef,
  marketPriceRef,
  lastDataTimeRef,
  coordTimeToX,
  pricePrecision,
  onStopLossChange,
  onSubmit,
  onCancel,
}: AutoMarketOverlayProps) {
  const [coordinates, setCoordinates] = useState<OverlayCoordinates | null>(null);
  const lastCoordinatesRef = useRef<OverlayCoordinates | null>(null);

  // --- Click-move-click stop-loss placement -----------------------------
  //
  // Previously a press-and-hold drag (pointerdown -> pointermove ->
  // pointerup with pointer capture on the element itself). Converted to
  // the same click-move-click flow used elsewhere in this app
  // (PositionBracketOverlay's TP/SL placement, order-line reprice, the
  // TP/SL zone edge-resize handle): one click arms it, the line then
  // tracks the mouse with nothing held down, and the next click anywhere
  // confirms the new price. Escape or a right-click cancels back to
  // whatever the stop was before this placement started.
  const [isPlacingStop, setIsPlacingStop] = useState(false);
  const isPlacingStopRef = useRef(false);
  const stopBeforePlacementRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      const wrap = chartWrapRef.current;
      const series = candleRef.current;
      const marketPrice = marketPriceRef.current;

      if (!wrap || !series || !marketPrice || marketPrice <= 0) {
        setCoordinates(null);
        return;
      }

      const entryY = series.priceToCoordinate(marketPrice);
      const stopY = series.priceToCoordinate(draft.stopLoss);
      const anchorTime = lastDataTimeRef.current;
      const anchorX = anchorTime ? coordTimeToX(anchorTime) : null;

      if (entryY === null || stopY === null) {
        setCoordinates(null);
        return;
      }

      const left = anchorX ?? wrap.clientWidth * 0.5;
      const width = AUTO_MARKET_ZONE_WIDTH_PX;

      const nextCoordinates = {
        left,
        width,
        entryY,
        stopY,
        marketPrice,
        valid: isValidStop(draft.side, marketPrice, draft.stopLoss),
      };
      const previous = lastCoordinatesRef.current;
      const changed =
        !previous ||
        Math.abs(previous.left - nextCoordinates.left) > 0.25 ||
        Math.abs(previous.width - nextCoordinates.width) > 0.25 ||
        Math.abs(previous.entryY - nextCoordinates.entryY) > 0.25 ||
        Math.abs(previous.stopY - nextCoordinates.stopY) > 0.25 ||
        Math.abs(previous.marketPrice - nextCoordinates.marketPrice) > 0.00000001 ||
        previous.valid !== nextCoordinates.valid;

      if (changed) {
        lastCoordinatesRef.current = nextCoordinates;
        setCoordinates(nextCoordinates);
      }

    };

    return startPacedLoop(update);
  }, [
    candleRef,
    chartWrapRef,
    coordTimeToX,
    draft.side,
    draft.stopLoss,
    lastDataTimeRef,
    marketPriceRef,
  ]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isSubmitting) return;
    // Already armed - ignore a stray extra pointerdown on the line/grab
    // strip rather than restarting the placement from here.
    if (isPlacingStopRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    stopBeforePlacementRef.current = draft.stopLoss;
    isPlacingStopRef.current = true;
    setIsPlacingStop(true);
  };

  const cancelDrag = () => {
    const before = stopBeforePlacementRef.current;

    if (before !== null) {
      onStopLossChange(before);
    }

    isPlacingStopRef.current = false;
    setIsPlacingStop(false);
  };

  useEffect(() => {
    if (!isPlacingStop) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = chartWrapRef.current;
      const series = candleRef.current;
      if (!wrap || !series) return;

      const rect = wrap.getBoundingClientRect();
      const price = series.coordinateToPrice(event.clientY - rect.top);

      if (price !== null && Number.isFinite(price) && price > 0) {
        onStopLossChange(price);
      }
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;
      isPlacingStopRef.current = false;
      setIsPlacingStop(false);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelDrag();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlacingStop, chartWrapRef, candleRef]);

  if (!coordinates) return null;

  const top = Math.min(coordinates.entryY, coordinates.stopY);
  const height = Math.max(2, Math.abs(coordinates.stopY - coordinates.entryY));
  const distancePct =
    (Math.abs(coordinates.marketPrice - draft.stopLoss) / coordinates.marketPrice) * 100;
  const isCompact = height < 72;
  const chartHeight = chartWrapRef.current?.clientHeight ?? 0;

  const normalControlsTop = Math.max(
    52,
    Math.min(top + height / 2, chartHeight - 52),
  );

  const preferredCompactTop =
    draft.side === "BUY" ? coordinates.stopY + 25 : coordinates.stopY - 25;
  const compactControlsTop = Math.max(18, Math.min(preferredCompactTop, chartHeight - 18));


  return (
    <div className="auto-market-overlay" onDoubleClick={(event) => event.stopPropagation()}>
      {coordinates.valid && (
        <div
          className={`auto-market-risk-zone valid ${isCompact ? "compact" : ""}`}
          style={{ left: coordinates.left, top, width: coordinates.width, height }}
        >
          {!isCompact && (
            <span>
              AUTO {draft.side === "BUY" ? "LONG" : "SHORT"} {distancePct.toFixed(2)}%
            </span>
          )}
        </div>
      )}

      <div
        className={`auto-market-entry-line ${isCompact ? "compact" : ""}`}
        style={{ left: coordinates.left, top: coordinates.entryY, width: coordinates.width }}
      >
        <span>MARKET {formatPrice(coordinates.marketPrice, pricePrecision)}</span>
      </div>

      {coordinates.valid && (
        <div
          className={`auto-market-stop-line ${isCompact ? "compact" : ""} ${
            isPlacingStop ? "armed" : ""
          }`}
          style={{ left: coordinates.left, top: coordinates.stopY, width: coordinates.width }}
          onPointerDown={beginDrag}
          title="Click, move the mouse, then click again to move the stop loss"
        >
          <span>SL {formatPrice(draft.stopLoss, pricePrecision)}</span>
          <div className="auto-market-stop-grab" aria-hidden="true" />
        </div>
      )}

      {coordinates.valid && (
      <div
        className={`auto-market-controls ${isCompact ? "compact" : ""}`}
        style={{
          left: isCompact
            ? coordinates.left
            : coordinates.left + Math.max(8, coordinates.width - 88),
          top: isCompact ? compactControlsTop : normalControlsTop,
          width: isCompact ? coordinates.width : undefined,
        }}
      >
        {isCompact && (
          <span className="auto-market-compact-summary">
            AUTO {draft.side === "BUY" ? "LONG" : "SHORT"} {distancePct.toFixed(2)}%
          </span>
        )}
        <button
          type="button"
          className="auto-market-confirm"
          disabled={isSubmitting || !coordinates.valid}
          onClick={(event) => {
            event.stopPropagation();
            onSubmit();
          }}
        >
          {isSubmitting ? (isCompact ? "WAIT…" : "EXECUTING…") : "EXECUTE"}
        </button>
        <button
          type="button"
          className="auto-market-cancel"
          disabled={isSubmitting}
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
        >
          CANCEL
        </button>
      </div>
      )}

      {!isPlacingStop && (
        <div className="auto-market-instruction">
          CLICK THE SL LINE, MOVE IT, THEN CLICK AGAIN TO CONFIRM
        </div>
      )}

      {!coordinates.valid && (
        <div className="auto-market-error">
          {draft.side === "BUY" ? "LONG stop must be below market" : "SHORT stop must be above market"}
        </div>
      )}
    </div>
  );
}
