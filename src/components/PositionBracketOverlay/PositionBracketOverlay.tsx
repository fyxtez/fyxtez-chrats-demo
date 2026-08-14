import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import {
  closePositionMarket,
  executePositionIntent,
  getPositions,
  type OpenPosition,
} from "../../trading/api/positions";
import {
  cancelConditionalOrder,
  placeFullStopLoss,
  repriceReduceOrder,
} from "../../trading/api/orders";
import {
  loadSavedStop,
  saveStop,
  type SavedStop,
} from "../../trading/stopLoss";
import type { TradeMarker, TradeSide, TradeToastState } from "../../trading/types";
import { startPacedLoop } from "../../utils/pacedLoop";
import "./PositionBracketOverlay.css";

type DragKind = "TAKE_PROFIT" | "STOP_LOSS";
// Only the right edge is resizable now - the zone's left edge is pinned
// exactly to the entry anchor and can no longer be extended backward in
// time (see the zone-edge-handle section below for why).
type EdgeDragKind = "ZONE_RIGHT";

type ZonePad = {
  right: number;
};

type PositionBracketOverlayProps = {
  /**
   * The currently selected trading symbol (e.g. "BTCUSDT", "SOLUSDT").
   * EVERYTHING in this component - the open position lookup, the saved
   * stop-loss, and the persisted entry-anchor candle - is scoped to
   * this one symbol. The parent (ChartPanel) renders this component with
   * `key={symbol}`, so a symbol switch fully remounts it instead of
   * needing every ref/state below reset by hand; `symbol` is still
   * threaded through explicitly (rather than left as a stale closure)
   * for correctness even if that key ever gets removed.
   */
  symbol: string;
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  /**
   * The real, live traded market price for `symbol` - NOT wherever the
   * mouse happens to be hovering. Used to validate that a dragged SL/TP
   * price is on the correct side of the current market.
   */
  marketPriceRef: MutableRefObject<number | null>;
  /**
   * Price of the confirmed 100%-reduce (full take-profit) limit order, if
   * any - sourced from open orders in App.tsx. Drives the persistent green
   * profit-zone rectangle between entry and TP, and hides the TP FULL
   * button once one already exists.
   */
  fullTakeProfitPrice: number | null;
  /**
   * Real Binance orderId of the confirmed full-TP order, if any. Clicking
   * that order's row in PositionsPanel's Open Orders tab sets
   * highlightedOrderIdRef to this same value - matched below to blink the
   * TP zone the same way the SL zone already blinks for its own
   * (synthetic, negated-algoId) row.
   */
  fullTakeProfitOrderId: string | null;
  /**
   * Converts a real bar timestamp into its current on-screen X coordinate
   * (native lookup + calibrated fallback, same as drawings use). Needed so
   * the TP/SL zone can be pinned to the candle the trade was actually
   * opened on, rather than to whatever the latest candle happens to be.
   */
  coordTimeToX: (time: UTCTimestamp) => number | null;
  /**
   * Set by App.tsx's focusOrderLine when an order row is clicked in
   * PositionsPanel. PositionsPanel's synthetic stop-loss row passes its
   * negated algoId as its orderId (see buildSyntheticStopOrder there) -
   * this component checks for that same negated value to know when the
   * stop-loss specifically (as opposed to some other order) should
   * blink.
   */
  highlightedOrderIdRef: MutableRefObject<string | null>;
  highlightedOrderUntilRef: MutableRefObject<number>;
  /**
   * Set by App.tsx's focusPosition whenever a row in the Positions tab
   * (as opposed to Open Orders) is clicked. A position has no single
   * Binance orderId to match against - there's only ever one open
   * position per symbol - so this is a bare timestamp rather than an
   * id+timestamp pair like highlightedOrderIdRef/highlightedOrderUntilRef
   * above. When active, it blinks the entry line together with
   * whichever TP/SL zones currently exist, in addition to (not instead
   * of) their own individual order-level highlighting.
   */
  highlightedPositionUntilRef: MutableRefObject<number>;
  /**
   * WHICH position ("SYMBOL-SIDE") is currently highlighted - see the
   * comment on this same ref in useChartRefs.ts. Without this, ANY
   * position row clicked in the (account-wide) Positions panel - for
   * ANY symbol - would blink whichever chart happened to be on screen,
   * regardless of whether it was actually that position.
   */
  highlightedPositionKeyRef: MutableRefObject<string | null>;
  /**
   * The same trade-marker list the chart canvas already renders its "B"/"S"
   * fill badges from (see useTradeMarkers/useDrawingCanvas). Used to anchor
   * the TP/SL zone to the candle the position was ACTUALLY filled on,
   * instead of "whichever candle happened to be latest" at the moment our
   * 1s position poll first noticed the new position - polling lag meant
   * that could already be one or more candles later than the real entry.
   */
  tradeMarkersRef: MutableRefObject<TradeMarker[]>;
  /**
   * Decimal precision for the active symbol's real tick size (see
   * trading/api/exchangeInfo.ts / useMarketData.ts). Used for every price
   * shown by this overlay - the drag preview, the SL FULL label, and the
   * placement confirmation toasts - so a symbol needing several decimals
   * (XRP, for instance) doesn't get every price rounded down to 1
   * decimal, which made it impossible to tell where the SL/TP actually
   * was while placing it.
   */
  pricePrecision: number;
  /**
   * Pushes a submitting/success/error message into the shared TradeToast
   * (rendered once, bottom-center of the canvas, by ChartPanel) instead of
   * this component showing its own separate confirmation box - keeps
   * SL/TP submission feedback visually and mechanically unified with every
   * other trade notification rather than being a second, differently
   * styled toast. Live drag-validation hints (e.g. "must be above current
   * price") stay local since they're tied directly to the in-progress
   * drag, not a one-shot event.
   */
  onToast: (toast: TradeToastState | null) => void;
  /**
   * Notifies the parent when the quick-close X (next to the TP FULL /
   * STOP LOSS buttons - see closePositionNow below) actually closes the
   * position, so it can record the trade marker/clear the PNL card the
   * same way PositionsPanel's own Market-close button already does.
   * Same signature, same shared handler in App.tsx.
   */
  onPositionClosed: (side: TradeSide, symbol: string, price?: number) => void;
};

// If the saved stop-loss line renders within this many pixels of the entry
// line, its label/cancel button are flipped to sit below the line instead
// of above it, so they never collide with the entry row's TP FULL / STOP
// LOSS buttons that always float above the entry line.
const STOP_LABEL_COLLISION_THRESHOLD_PX = 34;

// While actively placing a TP/SL (see handlePointerMove below), the
// preview price is hard-clamped to stay strictly on the correct side of
// the current market price rather than only complaining about it at
// confirm time. This small buffer keeps the clamped price from resting
// exactly ON the market price - validatePrice treats an exact match as
// invalid too, since a TP/SL sitting exactly at market isn't meaningful.
const PRICE_BOUNDARY_EPSILON = 0.1;

// Safety net: if the confirmed TP order never shows up in open orders
// (e.g. the "trading-state-changed" refresh is unusually slow or fails
// silently), stop showing the optimistic zone as "pending" after this long
// so it doesn't look stuck forever. It stays visible either way - this
// only affects the pending/dashed styling.
const OPTIMISTIC_TAKE_PROFIT_TIMEOUT_MS = 8_000;

// How long a settled status message (a placement/cancel confirmation or
// error) stays visible before it clears itself. Live validation feedback
// shown while actively placing a TP/SL is exempt - see the effect below.
const MESSAGE_AUTO_DISMISS_MS = 4_000;

// Default rightward extent of the zone (pixels) from its anchor, before
// the user drags an edge handle to resize it.
const DEFAULT_ZONE_RIGHT_PAD_PX = 220;

// Width/height of the pixel handles used to resize the zone horizontally.
const ZONE_EDGE_HANDLE_WIDTH_PX = 6;

// When a position is first detected, only trust a trade marker as "the"
// entry fill if it landed within this many seconds of right now. Without
// a bound, a stale marker from an old (already-closed) position sitting
// in the 3-day marker retention window could otherwise get picked up as
// if it were this new position's entry.
const ENTRY_MARKER_LOOKBACK_SECONDS = 120;

const POSITION_ANCHOR_STORAGE_PREFIX = "fyxtez:position-anchor-v2:";

type SavedPositionAnchor = {
  symbol: string;
  side: "LONG" | "SHORT";
  time: number;
};

function positionAnchorStorageKey(symbol: string): string {
  return `${POSITION_ANCHOR_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

function loadPositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
): UTCTimestamp | null {
  try {
    const raw = localStorage.getItem(positionAnchorStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedPositionAnchor>;
    const time = Number(parsed.time);

    if (
      parsed.symbol !== symbol.toUpperCase() ||
      parsed.side !== side ||
      !Number.isFinite(time) ||
      time <= 0
    ) {
      return null;
    }

    return time as UTCTimestamp;
  } catch {
    return null;
  }
}

function savePositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
  time: UTCTimestamp,
): void {
  const value: SavedPositionAnchor = {
    symbol: symbol.toUpperCase(),
    side,
    time: Number(time),
  };

  localStorage.setItem(positionAnchorStorageKey(symbol), JSON.stringify(value));
}

function clearPositionAnchor(symbol: string): void {
  localStorage.removeItem(positionAnchorStorageKey(symbol));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function PositionBracketOverlay({
  symbol,
  chartWrapRef,
  chartRef,
  candleRef,
  lastDataTimeRef,
  marketPriceRef,
  fullTakeProfitPrice,
  fullTakeProfitOrderId,
  coordTimeToX,
  highlightedOrderIdRef,
  highlightedOrderUntilRef,
  highlightedPositionUntilRef,
  highlightedPositionKeyRef,
  tradeMarkersRef,
  pricePrecision,
  onToast,
  onPositionClosed,
}: PositionBracketOverlayProps) {
  const [position, setPosition] = useState<OpenPosition | null>(null);
  const [isClosingPosition, setIsClosingPosition] = useState(false);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [savedStop, setSavedStop] = useState<SavedStop | null>(() =>
    loadSavedStop(symbol),
  );

  // Optimistic placements: set the instant a TP/SL submission starts, so
  // the zone/line stays visible through the network round-trip instead of
  // disappearing until the request resolves. Cleared immediately on
  // failure (reverting to nothing); for stop-loss, cleared on success too
  // since savedStop takes over at that point. For take-profit, cleared
  // once the real order price arrives via the fullTakeProfitPrice prop
  // (or the timeout above, as a safety net).
  const [optimisticTakeProfit, setOptimisticTakeProfit] = useState<
    number | null
  >(null);
  const [optimisticStopLoss, setOptimisticStopLoss] = useState<number | null>(
    null,
  );

  // Manually adjustable horizontal extent of the TP/SL zone, in pixels,
  // to the right of the anchor point (the entry candle's own time
  // coordinate). The left edge is always pinned exactly to the anchor -
  // see EdgeDragKind above. Purely horizontal - never affects
  // entryY/stopY/takeProfitY, which stay computed from price alone.
  const [zonePad, setZonePad] = useState<ZonePad>({
    right: DEFAULT_ZONE_RIGHT_PAD_PX,
  });
  const zonePadRef = useRef<ZonePad>(zonePad);
  zonePadRef.current = zonePad;

  const [edgeDrag, setEdgeDrag] = useState<EdgeDragKind | null>(null);
  const edgeDragRef = useRef<EdgeDragKind | null>(null);
  const edgeDragStartRef = useRef<{ pointerX: number; pad: number } | null>(
    null,
  );

  const [coordinates, setCoordinates] = useState({
    entryY: 0,
    previewY: 0,
    stopY: 0,
    takeProfitY: 0,
    paneLeft: 0,
    paneWidth: 0,
    // Width of the entry line itself. Unlike paneWidth (the TP/SL zone's
    // own manually-resizable width, driven by zonePad), this always
    // reaches whichever candle is CURRENTLY the latest one - see the
    // "entry line width" section inside recomputeCoordinates below.
    entryLineWidth: 0,
    ready: false,
    isStopHighlighted: false,
    isTakeProfitHighlighted: false,
    isPositionHighlighted: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dragKindRef = useRef<DragKind | null>(null);
  const placementPointerRef = useRef<{
    pointerId: number;
    pointerType: string;
  } | null>(null);
  const previewPriceRef = useRef<number | null>(null);
  const positionRef = useRef<OpenPosition | null>(null);
  const savedStopRef = useRef<SavedStop | null>(savedStop);

  /*
   * FIX (TP FULL / STOP LOSS / close-X reappearing for a few seconds
   * after a successful close): closePositionNow optimistically calls
   * setPosition(null) the instant the market-close order confirms, but
   * refreshPosition below always trusts whatever getPositions() returns
   * - and Binance's own account/position data takes a beat to actually
   * reflect a fill that was JUST placed. So the very next poll (either
   * the self-heal interval or an account-state-changed burst) could
   * re-fetch, still see the position "open" from Binance's own
   * perspective, and overwrite the optimistic null right back to the
   * old position - reviving the TP FULL/STOP LOSS/close buttons for
   * however long that lag lasts. The existing request-id guard in
   * refreshPosition only protects against responses resolving out of
   * order; it does nothing here, since each poll's response is
   * genuinely the latest one, just still factually stale relative to
   * an order we KNOW just filled. This tracks "we just confirmed this
   * position closed, ignore contrary poll results until" - refreshPosition
   * treats the position as gone regardless of what a poll returns until
   * this window passes, then trusts Binance's data normally again.
   */
  const suppressReviveUntilRef = useRef(0);
  const fullTakeProfitPriceRef = useRef<number | null>(fullTakeProfitPrice);
  const fullTakeProfitOrderIdRef = useRef<string | null>(fullTakeProfitOrderId);
  const optimisticTakeProfitRef = useRef<number | null>(optimisticTakeProfit);
  const optimisticStopLossRef = useRef<number | null>(optimisticStopLoss);

  // The candle time the currently open position was detected on. Captured
  // once when a position first appears, and cleared when it closes - the
  // zone's left edge is pinned to this, never to "whatever the latest
  // candle is right now".
  const entryAnchorTimeRef = useRef<UTCTimestamp | null>(null);

  // Last successfully-resolved on-screen X for the anchor candle. Held
  // onto across frames where coordTimeToX momentarily can't resolve one
  // (e.g. right after switching timeframe, while candle data reloads) so
  // the zone holds its position instead of flashing to pane-center.
  const lastKnownAnchorXRef = useRef<number | null>(null);

  // Same purpose as lastKnownAnchorXRef above, but tracks the on-screen X
  // of whichever candle is CURRENTLY the latest one, used to size the
  // entry line's own width (see recomputeCoordinates below). Kept
  // separate from lastKnownAnchorXRef since the two can legitimately
  // resolve on different frames (e.g. right after a timeframe switch, one
  // may resolve before the other).
  const lastKnownLatestXRef = useRef<number | null>(null);

  positionRef.current = position;
  savedStopRef.current = savedStop;
  fullTakeProfitPriceRef.current = fullTakeProfitPrice;
  fullTakeProfitOrderIdRef.current = fullTakeProfitOrderId;
  optimisticTakeProfitRef.current = optimisticTakeProfit;
  optimisticStopLossRef.current = optimisticStopLoss;

  // A stop created by another workflow (notably AUTO MARKET) is persisted
  // through trading/stopLoss.ts and followed by a trading-state-changed event.
  // Reload it here immediately so this mounted overlay shows the red SL zone
  // and hides the create STOP LOSS button without requiring a page refresh.
  useEffect(() => {
    const refreshSavedStop = () => {
      setSavedStop(loadSavedStop(symbol));
    };

    window.addEventListener("trading-state-changed", refreshSavedStop);
    window.addEventListener("storage", refreshSavedStop);

    return () => {
      window.removeEventListener("trading-state-changed", refreshSavedStop);
      window.removeEventListener("storage", refreshSavedStop);
    };
  }, [symbol]);

  // Order lines live on the canvas and have their own click-move-click flow.
  // Follow its live full-TP preview directly so the green bracket rectangle
  // moves on the same frame as the yellow order line, before order polling
  // has had any chance to confirm the new price.
  useEffect(() => {
    const followOrderLinePreview = (event: Event) => {
      const detail = (event as CustomEvent<{ symbol?: string; price?: number | null }>).detail;
      if (detail?.symbol?.toUpperCase() !== symbol.toUpperCase()) return;

      const price = detail.price;
      setOptimisticTakeProfit(
        typeof price === "number" && Number.isFinite(price) && price > 0
          ? price
          : null,
      );
    };

    window.addEventListener(
      "full-take-profit-preview-changed",
      followOrderLinePreview,
    );

    return () => {
      window.removeEventListener(
        "full-take-profit-preview-changed",
        followOrderLinePreview,
      );
    };
  }, [symbol]);

  // FIX (snap-back bug, take-profit): same root cause as the stop-loss fix
  // below - `fullTakeProfitPrice ?? optimisticTakeProfit` meant that while
  // MOVING an already-placed take-profit, the `??` never reached
  // optimisticTakeProfit at all, since fullTakeProfitPrice was still the
  // OLD (pre-move) confirmed price for the whole cancel+replace round-trip.
  // The zone snapped back to the old price the instant the drag was
  // released, then jumped to the new price once the open-orders refresh
  // finally caught up. Prioritizing optimisticTakeProfit whenever it's set
  // keeps the zone exactly where it was dropped the whole time; see the
  // matching fix in the clear-it-out effect below, which used to drop
  // optimisticTakeProfit the instant *any* confirmed price existed rather
  // than waiting for it to actually match the moved-to price.
  const displayedTakeProfitPrice = optimisticTakeProfit ?? fullTakeProfitPrice;

  // FIX (snap-back bug): previously this was
  //   savedStop?.triggerPrice ?? optimisticStopLoss
  // which meant that while MOVING an already-existing stop loss, the
  // `??` never reached optimisticStopLoss at all - savedStop was still
  // the OLD (pre-move) confirmed stop for the entire cancel+replace
  // network round-trip, so the line snapped back to the old price the
  // instant you released the drag, then jumped to the new price once the
  // request finally resolved. Prioritizing optimisticStopLoss whenever
  // it's set (i.e. a placement/move is in flight) means the line stays
  // exactly where you dropped it the whole time; savedStop only takes
  // over again once the optimistic value is cleared (on success or
  // failure - see finishDrag below).
  const displayedStopPrice = optimisticStopLoss ?? savedStop?.triggerPrice ?? null;

  // FIX (snap-back bug, same pattern as isStopPending below): previously
  // `fullTakeProfitPrice == null && optimisticTakeProfit != null`, which
  // only ever counted as "pending" for a brand-new TP placement (no prior
  // fullTakeProfitPrice). Moving an existing TP also goes through the
  // optimistic phase, so the dashed "pending" styling should show then
  // too - it's simply "is an optimistic TP currently in flight".
  const isTakeProfitPending = optimisticTakeProfit != null;

  // FIX: previously `savedStop == null && optimisticStopLoss != null`,
  // which only ever counted as "pending" for a brand-new stop-loss
  // placement (no prior savedStop). Moving an existing stop also goes
  // through the optimistic phase (cancel old -> place new), so the
  // dashed "pending" styling should show then too - it's simply "is an
  // optimistic stop currently in flight".
  const isStopPending = optimisticStopLoss != null;

  const findBestEntryMarker = useCallback(
    (currentPosition: OpenPosition, recentOnly: boolean): TradeMarker | null => {
      const entrySide = currentPosition.side === "LONG" ? "BUY" : "SELL";
      const nowSeconds = Date.now() / 1000;

      const candidates = tradeMarkersRef.current.filter((marker) => {
        if (marker.side !== entrySide) return false;

        const markerTime = Number(marker.time);
        if (!Number.isFinite(markerTime) || markerTime > nowSeconds + 5) {
          return false;
        }

        return !recentOnly || nowSeconds - markerTime <= ENTRY_MARKER_LOOKBACK_SECONDS;
      });

      if (candidates.length === 0) return null;

      // On a reload there may be several retained B/S markers. The original
      // entry fill is normally the marker whose fill price is closest to the
      // position's current average entry price. Use time as the tie-breaker.
      return candidates
        .slice()
        .sort((left, right) => {
          const leftDistance = Math.abs(left.price - currentPosition.entry_price);
          const rightDistance = Math.abs(right.price - currentPosition.entry_price);

          if (leftDistance !== rightDistance) {
            return leftDistance - rightDistance;
          }

          return Number(left.time) - Number(right.time);
        })[0];
    },
    [tradeMarkersRef],
  );

  const persistEntryAnchor = useCallback(
    (currentPosition: OpenPosition, time: UTCTimestamp) => {
      entryAnchorTimeRef.current = time;
      lastKnownAnchorXRef.current = null;
      savePositionAnchor(symbol, currentPosition.side, time);
    },
    [symbol],
  );

  // FIX (stale close/reopen race - the actual bug behind "TP FULL / STOP
  // LOSS buttons missing until page refresh"):
  //
  // refreshPosition is invoked from an "account-state-changed" listener
  // that debounces bursts of events into a single call 100ms later (see
  // the effect below) - but nothing here has EVER guarded against two
  // overlapping refreshPosition CALLS resolving out of order. Closing a
  // position and opening a new one within a couple of seconds (e.g.
  // AUTO MARKET -> close -> plain MARKET, as reported) fires two
  // separate "account-state-changed" bursts close together. If the
  // slower of the two network round-trips (typically the one checking
  // whether the OLD position closed) resolves AFTER the faster one that
  // already reflects the NEW position, it would silently clobber
  // `position` back to null and wipe savedStop/optimistic TP-SL state
  // for the position that is actually still open right now - and
  // nothing re-runs to fix it until a full page reload re-reads
  // everything from scratch (which is exactly why refreshing "fixed"
  // it). A monotonically increasing request id - the same pattern this
  // codebase already uses elsewhere (usePositions.ts, useTradeMenu.ts) -
  // makes sure only the MOST RECENTLY ISSUED call is allowed to commit
  // state, so a stale response is simply discarded instead of undoing
  // more current, correct state.
  const positionRequestIdRef = useRef(0);

  const refreshPosition = useCallback(async (force = false) => {
    const requestId = ++positionRequestIdRef.current;

    try {
      const positions = await getPositions(undefined, force);

      if (requestId !== positionRequestIdRef.current) {
        // A newer refreshPosition call has already started (or
        // finished) since this one began - this response is stale and
        // must not overwrite whatever more current state exists.
        return;
      }

      const fetchedNext =
        positions.find(
          (item) => item.symbol.toUpperCase() === symbol.toUpperCase(),
        ) ?? null;

      const next =
        fetchedNext && Date.now() < suppressReviveUntilRef.current
          ? null
          : fetchedNext;

      if (next && !positionRef.current) {
        // Restore the original entry candle after a page refresh. Previously
        // this component always started with an empty ref, and if the marker
        // was not available on that exact poll it permanently fell back to
        // lastDataTimeRef (the newest candle), relocating both rectangles.
        const persistedAnchor = loadPositionAnchor(symbol, next.side);
        const entryMarker =
          persistedAnchor == null ? findBestEntryMarker(next, true) : null;
        const restoredMarker =
          persistedAnchor == null && entryMarker == null
            ? findBestEntryMarker(next, false)
            : null;
        const markerTime = entryMarker?.time ?? restoredMarker?.time ?? null;
        const anchorTime =
          persistedAnchor ??
          (markerTime == null ? null : (markerTime as UTCTimestamp)) ??
          lastDataTimeRef.current;

        if (anchorTime != null) {
          persistEntryAnchor(next, anchorTime);
        }

        // FIX: a brand-new position must never inherit stale in-flight
        // TP/SL placeholder state left over from whichever position
        // previously occupied this symbol. Normally the `!next` branch
        // below already clears these the moment the old position
        // closes - but if that detection got raced/skipped (see the big
        // comment above), these would otherwise sit non-null forever
        // and keep the TP FULL / STOP LOSS buttons hidden. Reloading
        // savedStop straight from localStorage (rather than trusting
        // whatever this component's React state currently holds) is
        // what actually self-heals the reported bug without requiring a
        // page reload.
        setOptimisticTakeProfit(null);
        setOptimisticStopLoss(null);
        setSavedStop(loadSavedStop(symbol));

        // Reset any manual width tweaks left over from a previous trade
        // on this symbol.
        setZonePad({ right: DEFAULT_ZONE_RIGHT_PAD_PX });
      }

      setPosition(next);

      if (!next) {
        entryAnchorTimeRef.current = null;
        lastKnownAnchorXRef.current = null;
        lastKnownLatestXRef.current = null;
        clearPositionAnchor(symbol);

        // A close can happen while a TP/SL placement is armed or while a
        // success/error message is still visible. Clear every position-scoped
        // interaction immediately so stale TP FULL / STOP LOSS controls and
        // "no open position" errors cannot survive after the position is gone.
        dragKindRef.current = null;
        previewPriceRef.current = null;
        setDragKind(null);
        setPreviewPrice(null);
        setMessage(null);
        setIsSubmitting(false);

        if (savedStopRef.current) {
          setSavedStop(null);
          // FIX: this used to be `saveStop(null)` with NO symbol
          // argument - stopLoss.ts's old default parameter silently
          // fell back to DEFAULT_SYMBOL ("BTCUSDT"), so closing a
          // position on any OTHER symbol cleared BTCUSDT's saved stop
          // instead of this symbol's. `symbol` is now required, so this
          // must (and does) pass it explicitly.
          saveStop(null, symbol);

          // PositionsPanel keeps its own independent copy of the saved
          // stop-loss (read from the same localStorage key). The native
          // `storage` event does NOT fire in the tab that made the write,
          // so without this, PositionsPanel would never learn the stop
          // was cleared here and would keep showing a synthetic "ghost"
          // SL row in Open Orders for a position that no longer exists.
          // Guarded on savedStopRef.current so this only fires once, on
          // the actual open->closed transition, not every poll tick.
          window.dispatchEvent(new Event("trading-state-changed"));
        }
        // The position is gone (closed) - drop any leftover optimistic
        // placements so they can't linger into a future position.
        setOptimisticTakeProfit(null);
        setOptimisticStopLoss(null);
      }
    } catch {
      // Connection indicators already surface backend failures.
    }
  }, [
    findBestEntryMarker,
    lastDataTimeRef,
    persistEntryAnchor,
    symbol,
  ]);

  useEffect(() => {
    void refreshPosition(true);

    let refreshTimer: number | null = null;
    const handleTradingStateChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshPosition(true);
      }, 100);
    };

    window.addEventListener("account-state-changed", handleTradingStateChanged);

    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("account-state-changed", handleTradingStateChanged);
    };
  }, [refreshPosition]);

  // FIX: refreshPosition used to run ONLY in reaction to the
  // "account-state-changed" event above - if that event (or whatever
  // upstream it depends on: the local trading websocket, or the
  // backend's own connection to Binance's user-data stream) is ever
  // missed, this component had no other way to notice a position
  // opened, closed, or changed. This session has already confirmed real
  // network unreliability for persistent connections on this setup (the
  // chart's kline WebSocket silently dropped data; the backend logged
  // an outright failed Binance REST call) - the exact symptom reported
  // ("Binance shows 0 positions but the app still shows one open", and
  // separately "TP FULL / STOP LOSS buttons missing until refresh") is
  // consistent with a missed update somewhere in that chain. A quiet
  // periodic poll, independent of any push notification, guarantees
  // this overlay can never drift out of sync with reality for more than
  // one poll interval - the same fix already applied to the chart's own
  // live price feed (see useMarketData.ts) and to usePositions.ts /
  // useOpenOrders.ts.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshPosition();
    }, 4_000);

    return () => window.clearInterval(intervalId);
  }, [refreshPosition]);

  // Once the real take-profit order price shows up (via open orders) AND
  // it actually matches the price we optimistically set, the placeholder
  // has served its purpose - drop it so displayedTakeProfitPrice reads
  // from the confirmed source only.
  //
  // FIX (snap-back bug): previously this cleared as soon as
  // `fullTakeProfitPrice != null`, with no check that it matched. That's
  // fine for a brand-new placement (fullTakeProfitPrice starts null), but
  // when MOVING an existing take-profit, fullTakeProfitPrice is already
  // non-null (the OLD, pre-move price) the instant optimisticTakeProfit is
  // set - so this effect fired immediately and cleared the optimistic
  // value before the open-orders refresh had even landed, and
  // displayedTakeProfitPrice fell back to the stale confirmed price for
  // the rest of the round-trip (the actual snap-back the user saw).
  // Waiting for the two to match keeps the optimistic price displayed
  // until the confirmed data has genuinely caught up.
  useEffect(() => {
    if (optimisticTakeProfit == null) return;

    if (
      fullTakeProfitPrice != null &&
      fullTakeProfitPrice.toFixed(pricePrecision) ===
        optimisticTakeProfit.toFixed(pricePrecision)
    ) {
      setOptimisticTakeProfit(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setOptimisticTakeProfit(null);
    }, OPTIMISTIC_TAKE_PROFIT_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [optimisticTakeProfit, fullTakeProfitPrice, pricePrecision]);

  // Auto-dismiss a settled status message after a few seconds. Skipped
  // while a TP/SL placement is actively in progress (dragKind set), since
  // that's when `message` is being used for live validation feedback
  // ("must be above current price" etc.) that should stay up until the
  // placement itself changes or ends, not clear itself out from under the
  // user mid-placement.
  useEffect(() => {
    if (!message || dragKind) return;

    const timeoutId = window.setTimeout(() => {
      setMessage(null);
    }, MESSAGE_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message, dragKind]);

  // Computes entryY/previewY/stopY/takeProfitY plus the zone's horizontal
  // extent (paneLeft/paneWidth), and commits them to state. Called from
  // the RAF render loop every frame (so the zone tracks price changes and
  // pans/zooms smoothly), AND synchronously from a layout effect whenever
  // a value that should be reflected *immediately* changes (see below) -
  // without the layout-effect call, those changes would render one frame
  // late using stale coordinates, which is what caused the TP/SL zone to
  // visibly snap to the wrong spot for a frame right after a placement
  // was confirmed.
  const recomputeCoordinates = useCallback(() => {
    const wrap = chartWrapRef.current;
    const chart = chartRef.current;
    const series = candleRef.current;
    const currentPosition = positionRef.current;

    if (!wrap || !chart || !series || !currentPosition) {
      setCoordinates((current) =>
        current.ready ? { ...current, ready: false } : current,
      );
      return;
    }

    const entryY = series.priceToCoordinate(currentPosition.entry_price);
    const targetPreviewPrice = previewPriceRef.current;
    const previewY =
      targetPreviewPrice == null
        ? null
        : series.priceToCoordinate(targetPreviewPrice);

    // FIX (snap-back bug, take 2): this is the ACTUAL calculation that
    // drives the rectangle's on-screen top/height (via coordinates.stopY
    // below) - the `displayedStopPrice` fix elsewhere in this file only
    // controls label text / show-hide, not positioning. This had its own
    // separate copy of the same stale-priority bug: while moving an
    // existing stop loss, `savedStopRef.current` is still the OLD
    // confirmed stop for the entire cancel+replace network round-trip, so
    // `??` never reached the new optimistic price and the zone rendered
    // at the OLD position the whole time, then jumped once savedStop
    // finally updated. Prioritizing the optimistic price whenever one is
    // in flight fixes the actual rendered position, not just the label.
    const effectiveStopPrice =
      optimisticStopLossRef.current ?? savedStopRef.current?.triggerPrice ?? null;
    const stopY =
      effectiveStopPrice == null
        ? null
        : series.priceToCoordinate(effectiveStopPrice);

    // FIX (snap-back bug, take 2 - take-profit): same stale-priority bug
    // as effectiveStopPrice above, just on the take-profit side. While
    // moving an existing TP, fullTakeProfitPriceRef.current is still the
    // OLD confirmed price for the whole cancel+replace round-trip, so `??`
    // never reached the new optimistic price and the zone rendered at the
    // OLD position until fullTakeProfitPrice finally updated.
    const effectiveTakeProfitPrice =
      optimisticTakeProfitRef.current ?? fullTakeProfitPriceRef.current;
    const takeProfitY =
      effectiveTakeProfitPrice == null
        ? null
        : series.priceToCoordinate(effectiveTakeProfitPrice);

    if (entryY == null) return;

    const paneWidth = chart.paneSize().width;

    // Late recovery path: markers can become available after the first
    // position poll during page startup. Prefer the real fill marker and
    // persist it before resorting to the newest candle.
    if (entryAnchorTimeRef.current == null) {
      const persistedAnchor = loadPositionAnchor(symbol, currentPosition.side);
      const entryMarker = findBestEntryMarker(currentPosition, false);
      const recoveredTime =
        persistedAnchor ??
        (entryMarker?.time as UTCTimestamp | undefined) ??
        lastDataTimeRef.current;

      if (recoveredTime != null) {
        persistEntryAnchor(currentPosition, recoveredTime);
      }
    }

    const anchorTime = entryAnchorTimeRef.current;
    const resolvedAnchorX = anchorTime != null ? coordTimeToX(anchorTime) : null;

    // coordTimeToX briefly returns null right after switching timeframe
    // (the chart's candle data is momentarily empty while the new
    // interval reloads) or in other transient states. Hold the last
    // successfully-resolved position instead of defaulting to pane
    // center in that gap - otherwise the zone visibly flashes to the
    // middle of the screen for a frame during every timeframe switch.
    const anchorX =
      resolvedAnchorX ?? lastKnownAnchorXRef.current ?? paneWidth * 0.5;

    if (resolvedAnchorX != null) {
      lastKnownAnchorXRef.current = resolvedAnchorX;
    }

    const pad = zonePadRef.current;
    const anchoredX = anchorX;
    // The left edge is always pinned exactly to the anchor now (no more
    // pad.left) - the zone can never extend backward past the candle the
    // trade actually opened on.
    const rawLeft = anchoredX;
    const rawRight = anchoredX + pad.right;

    // Deliberately NOT clamped into [0, paneWidth]. Zooming/panning can
    // legitimately move the anchor candle off either edge of the visible
    // pane - clamping used to forcibly pin the zone to whichever edge it
    // crossed instead of letting it continue scrolling off-canvas, which
    // looked like the zone randomly relocating itself on every zoom.
    // .position-bracket-overlay already has `overflow: hidden`, so an
    // off-screen zone is simply clipped, exactly like every other
    // off-screen drawing on this chart already behaves.
    const paneLeft = rawLeft;
    const bracketWidth = Math.max(0, rawRight - rawLeft);

    // The entry line's width is intentionally independent of the TP/SL
    // zone's own resizable width (zonePad/bracketWidth above) - it should
    // always reach whichever candle is CURRENTLY the latest one, growing
    // on its own as new candles print, rather than stopping at a
    // manually-set (or default) pad. Same "hold the last known position
    // across a transient resolve miss" pattern as anchorX above, so a
    // timeframe switch doesn't collapse/flicker the line for a frame.
    const latestTime = lastDataTimeRef.current;
    const resolvedLatestX =
      latestTime != null ? coordTimeToX(latestTime) : null;
    const latestX =
      resolvedLatestX ?? lastKnownLatestXRef.current ?? rawRight;

    if (resolvedLatestX != null) {
      lastKnownLatestXRef.current = resolvedLatestX;
    }

    const entryLineWidth = Math.max(0, latestX - anchoredX);

    // PositionsPanel's synthetic stop-loss row passes
    // `synthetic-stop-${algoId}` as its orderId (see
    // buildSyntheticStopOrder in PositionsPanel.tsx - it used to be
    // -algoId, a negative-number trick, back when orderId was still a
    // number; now that every order id is a string end to end, a
    // non-numeric string prefix serves the same "can never collide with
    // a real orderId" purpose). Clicking that row sets these same refs
    // that real chart drawings already use for their own blink - match
    // against that same prefixed id to know it's specifically the
    // stop-loss being pinged.
    const currentSavedStop = savedStopRef.current;
    const isStopHighlighted =
      currentSavedStop != null &&
      highlightedOrderIdRef.current === `synthetic-stop-${currentSavedStop.algoId}` &&
      Date.now() < highlightedOrderUntilRef.current;

    const isTakeProfitHighlighted =
      fullTakeProfitOrderIdRef.current != null &&
      highlightedOrderIdRef.current === fullTakeProfitOrderIdRef.current &&
      Date.now() < highlightedOrderUntilRef.current;

    // Set by App.tsx's focusPosition when a row in the Positions tab
    // (rather than Open Orders) is clicked. Unlike the two checks above,
    // this isn't tied to any specific order id - a position has no
    // single Binance orderId, so it's matched by "SYMBOL-SIDE" instead.
    //
    // FIX: this used to be `Date.now() < highlightedPositionUntilRef.current`
    // with no symbol/side check at all - so clicking ANY position row in
    // the (now account-wide) Positions panel, for ANY symbol, blinked
    // whichever chart happened to be open, regardless of whether that
    // was actually the position that was clicked. Comparing against
    // highlightedPositionKeyRef (set to the clicked row's own
    // "SYMBOL-SIDE") is what scopes the blink to the position it
    // actually belongs to.
    const isPositionHighlighted =
      highlightedPositionKeyRef.current ===
        `${symbol}-${currentPosition.side}` &&
      Date.now() < highlightedPositionUntilRef.current;

    const nextCoordinates = {
      entryY,
      previewY: previewY ?? entryY,
      stopY: stopY ?? entryY,
      takeProfitY: takeProfitY ?? entryY,
      paneLeft,
      paneWidth: bracketWidth,
      entryLineWidth,
      ready: true,
      isStopHighlighted,
      isTakeProfitHighlighted,
      isPositionHighlighted,
    };

    setCoordinates((current) => {
      const unchanged =
        current.ready === nextCoordinates.ready &&
        Math.abs(current.entryY - nextCoordinates.entryY) <= 0.25 &&
        Math.abs(current.previewY - nextCoordinates.previewY) <= 0.25 &&
        Math.abs(current.stopY - nextCoordinates.stopY) <= 0.25 &&
        Math.abs(current.takeProfitY - nextCoordinates.takeProfitY) <= 0.25 &&
        Math.abs(current.paneLeft - nextCoordinates.paneLeft) <= 0.25 &&
        Math.abs(current.paneWidth - nextCoordinates.paneWidth) <= 0.25 &&
        Math.abs(current.entryLineWidth - nextCoordinates.entryLineWidth) <= 0.25 &&
        current.isStopHighlighted === nextCoordinates.isStopHighlighted &&
        current.isTakeProfitHighlighted === nextCoordinates.isTakeProfitHighlighted &&
        current.isPositionHighlighted === nextCoordinates.isPositionHighlighted;

      return unchanged ? current : nextCoordinates;
    });
  }, [
    chartWrapRef,
    chartRef,
    candleRef,
    lastDataTimeRef,
    coordTimeToX,
    findBestEntryMarker,
    persistEntryAnchor,
    highlightedOrderIdRef,
    highlightedOrderUntilRef,
    highlightedPositionUntilRef,
    highlightedPositionKeyRef,
    symbol,
  ]);

  useEffect(() => {
    return startPacedLoop(recomputeCoordinates);
  }, [recomputeCoordinates]);

  // Force an immediate, synchronous recompute the instant any of these
  // change, instead of waiting for the next RAF tick. This is what
  // eliminates the one-frame "snap to old position, then snap to correct
  // position" glitch when a TP/SL placement is confirmed (dragKind flips
  // to null and optimisticTakeProfit/optimisticStopLoss are set in the
  // same React commit).
  useLayoutEffect(() => {
    recomputeCoordinates();
  }, [
    dragKind,
    optimisticTakeProfit,
    optimisticStopLoss,
    savedStop,
    fullTakeProfitPrice,
    previewPrice,
    zonePad,
    recomputeCoordinates,
  ]);

  const getPriceFromClientY = useCallback(
    (clientY: number): number | null => {
      const wrap = chartWrapRef.current;
      const series = candleRef.current;
      if (!wrap || !series) return null;

      const rect = wrap.getBoundingClientRect();
      const paneHeight = chartRef.current?.paneSize().height ?? rect.height;
      const localY = clamp(clientY - rect.top, 0, Math.max(0, paneHeight - 1));
      const price = series.coordinateToPrice(localY);

      return price != null && Number.isFinite(price) ? price : null;
    },
    [chartWrapRef, chartRef, candleRef],
  );

  const validatePrice = useCallback(
    (kind: DragKind, price: number): string | null => {
      const currentPosition = positionRef.current;
      if (!currentPosition) return "No open position";

      const market =
        marketPriceRef.current ??
        currentPosition.mark_price;

      if (currentPosition.side === "LONG") {
        if (kind === "TAKE_PROFIT" && price <= market) {
          return "LONG full TP must be above current price";
        }
        if (kind === "STOP_LOSS" && price >= market) {
          return "LONG stop loss must be below current price";
        }
      } else {
        if (kind === "TAKE_PROFIT" && price >= market) {
          return "SHORT full TP must be below current price";
        }
        if (kind === "STOP_LOSS" && price <= market) {
          return "SHORT stop loss must be above current price";
        }
      }

      return null;
    },
    [marketPriceRef],
  );

  const finishDrag = useCallback(async () => {
    const kind = dragKindRef.current;
    const price = previewPriceRef.current;
    const currentPosition = positionRef.current;

    dragKindRef.current = null;
    placementPointerRef.current = null;
    setDragKind(null);
    setPreviewPrice(null);
    previewPriceRef.current = null;

    if (!kind || price == null || !currentPosition) return;

    const validationError = validatePrice(kind, price);
    if (validationError) {
      setMessage(validationError);
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    onToast({ kind: "pending", message: "Submitting…" });

    // Show the placement optimistically right away, before the network
    // call resolves - the preview rectangle/line the user just confirmed
    // stays visible (now in a "pending" style) through the round-trip
    // instead of blanking out while waiting on Binance. Reverted in the
    // catch block below if the request actually fails.
    if (kind === "TAKE_PROFIT") {
      setOptimisticTakeProfit(price);
    } else {
      setOptimisticStopLoss(price);
    }

    // Let React paint the confirmed state before starting the network call.
    // This keeps the chart feeling immediate even when the backend is slow.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    try {
      if (kind === "TAKE_PROFIT") {
        const existingOrderId = fullTakeProfitOrderIdRef.current;

        if (existingOrderId) {
          // Moving an existing full TP must amend that order. Creating a new
          // reduce order here left the previous TP resting on the book and
          // therefore rendered both the old and new orange chart lines.
          await repriceReduceOrder(currentPosition.symbol, existingOrderId, {
            price,
            reduce_pct: 100,
          });
        } else {
          await executePositionIntent({
            symbol: currentPosition.symbol,
            intent: "REDUCE",
            orderType: "LIMIT",
            price,
            reducePct: 100,
          });
        }

        // Keep optimisticTakeProfit displayed - it's cleared once the real
        // order price arrives via the fullTakeProfitPrice prop (see effect
        // above), which avoids a flicker between "optimistic" and
        // "confirmed" render.
        setMessage(null);
        onToast({
          kind: "success",
          message: `Full TP set @ ${price.toFixed(pricePrecision)}`,
        });

        // The order acknowledgement can arrive slightly before Binance's
        // open-orders snapshot exposes the new limit order. Refresh now and
        // once more after a short propagation delay so the Open Orders panel
        // updates without requiring a page reload. These are user-action-only
        // refreshes, not polling.
        window.dispatchEvent(new Event("orders-state-changed"));
        window.setTimeout(
          () => window.dispatchEvent(new Event("orders-state-changed")),
          350,
        );
        window.setTimeout(
          () => window.dispatchEvent(new Event("orders-state-changed")),
          900,
        );
      } else {
        // This same path handles both a brand-new stop-loss placement
        // (savedStop is null, so there's nothing to cancel) and moving an
        // existing one (savedStop already set - cancel it first, Binance
        // doesn't support amending a conditional order's trigger price in
        // place).
        const oldStop = savedStopRef.current;
        if (oldStop?.algoId) {
          try {
            await cancelConditionalOrder(
              oldStop.symbol,
              oldStop.algoId,
            );
          } catch {
            // Continue: Binance may already have removed/triggered it.
          }
        }

        const closeSide =
          currentPosition.side === "LONG" ? "SELL" : "BUY";
        const response = await placeFullStopLoss({
          symbol: currentPosition.symbol,
          side: closeSide,
          triggerPrice: price,
        });

        const algoId = response.algo.algoId;
        // FIX: this used to be `Number(response.algo.algoId)` - converting
        // the (now correctly string-typed) algoId through JS's Number()
        // would silently reintroduce the exact precision loss this whole
        // fix exists to prevent (see safeJson.ts's big comment). Validate
        // it's a well-formed positive integer string without ever
        // actually converting it to a number for storage.
        if (
          typeof algoId !== "string" ||
          !/^\d+$/.test(algoId) ||
          algoId === "0"
        ) {
          throw new Error("Binance did not return a valid stop-loss algo id");
        }

        const nextStop: SavedStop = {
          symbol: currentPosition.symbol.toUpperCase(),
          side: closeSide,
          triggerPrice: response.trigger_price,
          algoId,
        };

        setSavedStop(nextStop);
        // FIX: this used to be `saveStop(nextStop)` with no symbol
        // argument. With `stop` truthy this happened to still work
        // (the implementation keys off `stop.symbol`, not the missing
        // param), but stopLoss.ts's `symbol` is now a required
        // parameter, so every call site passes it explicitly rather
        // than relying on implementation details to paper over it.
        saveStop(nextStop, symbol);
        // savedStop now covers this price directly - no need to keep the
        // optimistic placeholder around.
        setOptimisticStopLoss(null);
        setMessage(null);
        onToast({
          kind: "success",
          message: `Stop loss set @ ${response.trigger_price.toFixed(pricePrecision)}`,
        });
      }

      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      // Revert: the submission failed, so nothing was actually placed (or
      // in the "move" case, the previous stop loss may have been
      // cancelled but the replacement failed - savedStop/localStorage
      // still reflects whatever was last confirmed, and a fresh
      // refreshPosition/openOrders cycle will reconcile it).
      setOptimisticTakeProfit(null);
      setOptimisticStopLoss(null);

      setMessage(null);

      const rawMessage =
        error instanceof Error
          ? error.message
          : "Unable to create protection order";
      /*
       * Same translation as useDrawingCanvas.ts's reprice-reduce catch -
       * see the comment there for the full explanation. Binance rejects
       * a reduce-only TP/SL that sits beyond other pending same-side
       * orders it would have to pass through first, since those filling
       * first could leave the position flat/flipped before this order's
       * price is ever reached. A genuine exchange constraint, not a bug.
       */
      const reduceOnlyBlocked =
        rawMessage.includes("-2022") ||
        rawMessage.toLowerCase().includes("reduceonly order is rejected");

      onToast({
        kind: "error",
        message: reduceOnlyBlocked
          ? "Can't rest this order there - other pending orders on the same side would need to fill first, which could exceed your position size before this price is reached. Move it closer, or cancel/reduce those orders."
          : rawMessage,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [validatePrice, pricePrecision, symbol]);

  // Explicit cancel path for desktop's click-move-click placement and for
  // a cancelled mobile pointer gesture. Escape/right-click remain desktop
  // exits; pointercancel uses the same reset when the OS interrupts touch.
  const cancelDrag = useCallback(() => {
    dragKindRef.current = null;
    placementPointerRef.current = null;
    setDragKind(null);
    setPreviewPrice(null);
    previewPriceRef.current = null;
    setMessage(null);
  }, []);

  useEffect(() => {
    if (!dragKind) return;

    const updatePreviewFromPointer = (event: PointerEvent) => {
      const rawPrice = getPriceFromClientY(event.clientY);
      if (rawPrice == null) return false;

      const currentPosition = positionRef.current;
      const kind = dragKindRef.current;
      let nextPrice = rawPrice;

      // Hard-clamp the preview to the correct side of the current market
      // price while it's being placed, instead of letting it cross over
      // and only complaining once confirmed. A LONG's take profit (or a
      // SHORT's stop loss) simply can't be dragged below market, and
      // vice versa - it just stops following the cursor past that line,
      // same as this app already does for a plain reduce order line.
      if (currentPosition && kind) {
        const market = marketPriceRef.current ?? currentPosition.mark_price;

        if (currentPosition.side === "LONG") {
          nextPrice =
            kind === "TAKE_PROFIT"
              ? Math.max(nextPrice, market + PRICE_BOUNDARY_EPSILON)
              : Math.min(nextPrice, market - PRICE_BOUNDARY_EPSILON);
        } else {
          nextPrice =
            kind === "TAKE_PROFIT"
              ? Math.min(nextPrice, market - PRICE_BOUNDARY_EPSILON)
              : Math.max(nextPrice, market + PRICE_BOUNDARY_EPSILON);
        }
      }

      previewPriceRef.current = nextPrice;
      setPreviewPrice(nextPrice);
      setMessage(validatePrice(dragKindRef.current!, nextPrice));
      return true;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const placementPointer = placementPointerRef.current;

      if (placementPointer?.pointerType === "touch") {
        if (event.pointerId !== placementPointer.pointerId) return;

        /*
         * FIX (mobile TP/SL drag also panned the chart): intercept the
         * active finger before lightweight-charts receives its move. The
         * TP/SL preview owns this one-pointer gesture until release.
         */
        event.preventDefault();
        event.stopPropagation();
      }

      updatePreviewFromPointer(event);
    };

    /*
     * Desktop uses click-move-click placement:
     *
     *   1. The user clicks TP FULL / STOP LOSS (or grabs the existing
     *      stop-loss line) - that pointerdown is what set dragKind and
     *      ran BEFORE this effect exists, so it's never seen here.
     *   2. The mouse is now free to move without any button held; the
     *      preview line/zone above tracks it via handlePointerMove.
     *   3. The *next* left click anywhere - a fresh pointerdown - confirms
     *      the current preview price and submits the order.
     *
     * Touch deliberately differs: press-drag-release is handled below,
     * because requiring a second tap conflicts with normal phone gestures.
     * Escape or a right-click still cancels desktop placement.
     */
    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Touch confirms on release below; a second tap is desktop-only UX.
      if (placementPointerRef.current?.pointerType === "touch") return;
      void finishDrag();
    };

    const handleTouchRelease = (event: PointerEvent) => {
      const placementPointer = placementPointerRef.current;
      if (
        placementPointer?.pointerType !== "touch" ||
        event.pointerId !== placementPointer.pointerId
      ) return;

      /*
       * FIX (mobile TP/SL confirmation): finger release is the natural
       * final event for a drag. Use its last Y coordinate, block the chart
       * from consuming the release, then submit the selected price.
       */
      event.preventDefault();
      event.stopPropagation();
      updatePreviewFromPointer(event);
      void finishDrag();
    };

    const handleTouchCancel = (event: PointerEvent) => {
      const placementPointer = placementPointerRef.current;
      if (
        placementPointer?.pointerType !== "touch" ||
        event.pointerId !== placementPointer.pointerId
      ) return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
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

    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerdown", handleConfirmClick, { capture: true });
    window.addEventListener("pointerup", handleTouchRelease, { capture: true });
    window.addEventListener("pointercancel", handleTouchCancel, { capture: true });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerdown", handleConfirmClick, true);
      window.removeEventListener("pointerup", handleTouchRelease, true);
      window.removeEventListener("pointercancel", handleTouchCancel, true);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKind, finishDrag, cancelDrag, getPriceFromClientY, validatePrice]);

  /**
   * The X next to the TP FULL / STOP LOSS buttons - a shortcut to the
   * exact same market-close action as PositionsPanel's own "Market"
   * button (closePositionMarket under the hood), just reachable right
   * from the entry line instead of needing to open the Positions panel
   * first. Deliberately not wired through usePositions' own closeMarket
   * (that hook owns a whole live-polling positions list this component
   * doesn't need a second copy of) - calls the same underlying API
   * function directly instead.
   */
  const closePositionNow = async () => {
    if (isClosingPosition || !position) return;

    setIsClosingPosition(true);
    onToast({ kind: "pending", message: "Closing position…" });

    try {
      const result = await closePositionMarket(symbol);
      const avgPrice = Number(result?.order?.avgPrice);

      // See suppressReviveUntilRef's own comment above - this stops any
      // poll landing in the next few seconds from reviving the position
      // we just successfully closed, before Binance's own account data
      // has caught up to reflect it.
      suppressReviveUntilRef.current = Date.now() + 5_000;
      setPosition(null);
      onPositionClosed(
        result.side,
        symbol,
        Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined,
      );

      onToast({ kind: "success", message: "Position closed" });

      // FIX: this only ever dispatched "trading-state-changed", which
      // useOpenOrders.ts listens for - but usePositions.ts (the hook
      // behind PositionsPanel's own Positions table) listens for
      // "account-state-changed" specifically, a different event. So the
      // Positions table kept showing this position with its old data
      // for however long its own multi-second self-heal poll took to
      // notice on its own, instead of refreshing right away. Dispatching
      // both covers whichever hook is listening for which.
      window.dispatchEvent(new Event("account-state-changed"));
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      onToast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to close position",
      });
    } finally {
      setIsClosingPosition(false);
    }
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    kind: DragKind,
  ) => {
    if (isSubmitting || !position) return;

    // Already armed - this button shouldn't normally still be under the
    // cursor (it stays in a fixed spot on the entry line), but guard it
    // anyway rather than restarting the placement.
    if (dragKindRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    dragKindRef.current = kind;
    placementPointerRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    };
    setDragKind(kind);
    setMessage(null);

    previewPriceRef.current = position.entry_price;
    setPreviewPrice(position.entry_price);
  };

  // Grabbing the already-placed stop-loss line/badge itself, instead of
  // the STOP LOSS button on the entry row. Starts the same click-move-
  // click flow as beginDrag, but seeded from the stop's current price
  // instead of entry price, so the line doesn't jump before you've moved
  // the mouse.
  const beginMoveStop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isSubmitting || !position || !savedStop) return;
    if (dragKindRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    dragKindRef.current = "STOP_LOSS";
    placementPointerRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
    };
    setDragKind("STOP_LOSS");
    setMessage(null);

    previewPriceRef.current = savedStop.triggerPrice;
    setPreviewPrice(savedStop.triggerPrice);
  };

  const cancelStop = async (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const stop = savedStopRef.current;
    if (!stop || isSubmitting) return;

    setIsSubmitting(true);
    setMessage(null);
    onToast({ kind: "pending", message: "Submitting…" });

    // Let React paint the released drag state before starting the network call.
    // This keeps the chart feeling immediate even when the backend is slow.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    try {
      await cancelConditionalOrder(stop.symbol, stop.algoId);
      setSavedStop(null);
      saveStop(null, symbol);
      setMessage(null);
      onToast({ kind: "success", message: "Stop loss cancelled" });
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      setMessage(null);
      onToast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to cancel stop loss",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Zone edge (width) resize handle ----------------------------------
  // Purely horizontal: only ever mutates zonePad.right, which feeds
  // paneWidth above. entryY/stopY/takeProfitY are derived from price
  // alone and are never touched by this. Only the right edge is
  // resizable - the left edge is permanently pinned to the entry anchor
  // (see ZonePad/EdgeDragKind above), so there's nothing to arm there.
  // Same click-move-click flow as TP/SL placement above, for
  // consistency: the first click arms the handle, the zone edge tracks
  // the mouse with nothing held down, and the next click anywhere
  // confirms the new width. Escape or a right-click cancels back to the
  // width it had before this handle was grabbed.
  const beginEdgeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!position) return;

    // While the handle is already armed, its own position keeps tracking
    // the mouse every frame (that's how the moving preview works) - so
    // the confirm click almost always lands right back on top of this
    // same element. Without this guard, that click's pointerdown would
    // re-run beginEdgeDrag and call stopPropagation() below, which stops
    // the event from ever reaching the window-level listener that was
    // supposed to confirm the resize - it would look like the edge got
    // permanently stuck to the cursor, re-arming forever instead of ever
    // finishing. Bailing out here (without stopPropagation) lets that
    // click bubble up to the confirm listener normally instead.
    if (edgeDragRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    edgeDragRef.current = "ZONE_RIGHT";
    setEdgeDrag("ZONE_RIGHT");
    edgeDragStartRef.current = {
      pointerX: event.clientX,
      pad: zonePadRef.current.right,
    };
  };

  const cancelEdgeDrag = useCallback(() => {
    const start = edgeDragStartRef.current;

    if (start) {
      setZonePad((current) => ({ ...current, right: start.pad }));
    }

    edgeDragRef.current = null;
    edgeDragStartRef.current = null;
    setEdgeDrag(null);
  }, []);

  useEffect(() => {
    if (!edgeDrag) return;

    const handleMove = (event: PointerEvent) => {
      const start = edgeDragStartRef.current;
      if (!start) return;

      const delta = event.clientX - start.pointerX;
      const nextPad = Math.max(0, start.pad + delta);

      setZonePad((current) => ({ ...current, right: nextPad }));
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      edgeDragRef.current = null;
      edgeDragStartRef.current = null;
      setEdgeDrag(null);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelEdgeDrag();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelEdgeDrag();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
  }, [edgeDrag, cancelEdgeDrag]);

  const preview = useMemo(() => {
    if (!position || !dragKind || previewPrice == null) return null;

    const top = Math.min(coordinates.entryY, coordinates.previewY);
    const height = Math.abs(coordinates.previewY - coordinates.entryY);
    const distancePct =
      position.entry_price > 0
        ? ((previewPrice - position.entry_price) /
            position.entry_price) *
          100
        : 0;

    return {
      top,
      height,
      distancePct,
      valid: validatePrice(dragKind, previewPrice) == null,
    };
  }, [
    position,
    dragKind,
    previewPrice,
    coordinates.entryY,
    coordinates.previewY,
    validatePrice,
  ]);

  // When the saved stop-loss line renders very close to the entry line
  // (small % gap), flip its label/cancel button to sit below the line
  // instead of above - otherwise it collides with the entry row's TP
  // FULL / STOP LOSS buttons, which always float above the entry line.
  const stopControlsBelow =
    coordinates.ready &&
    displayedStopPrice != null &&
    Math.abs(coordinates.stopY - coordinates.entryY) <
      STOP_LABEL_COLLISION_THRESHOLD_PX;

  // Hide the confirmed/optimistic zone and stop-line while that same kind
  // is actively being placed - the live preview below already shows the
  // in-progress position, so showing both at once would just be two
  // overlapping rectangles/lines for the same bracket.
  const showTakeProfitZone =
    displayedTakeProfitPrice != null && dragKind !== "TAKE_PROFIT";
  const showStopZone = displayedStopPrice != null && dragKind !== "STOP_LOSS";
  const showStopLine = displayedStopPrice != null && dragKind !== "STOP_LOSS";

  // Keep TP FULL available after the order has been confirmed. The same
  // interaction reprices the existing full-TP order, so an orders refresh
  // (for example after editing SL) must not make this control disappear.
  const showTakeProfitButton = dragKind !== "TAKE_PROFIT";
  const showStopLossButton = displayedStopPrice == null;

  // Edge handles are only meaningful once at least one zone actually has
  // width to resize.
  const showEdgeHandles =
    coordinates.ready && (showTakeProfitZone || showStopZone);

  const edgeHandleBounds = useMemo(() => {
    if (!showEdgeHandles) return null;

    const ys = [coordinates.entryY];
    if (showTakeProfitZone) ys.push(coordinates.takeProfitY);
    if (showStopZone) ys.push(coordinates.stopY);

    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    return { top, height: Math.max(2, bottom - top) };
  }, [
    showEdgeHandles,
    showTakeProfitZone,
    showStopZone,
    coordinates.entryY,
    coordinates.takeProfitY,
    coordinates.stopY,
  ]);

  if (!position || !coordinates.ready) return null;

  return (
    <div className="position-bracket-overlay" aria-hidden="false">
      {showTakeProfitZone && (
        <div
          className={`position-bracket-zone profit persistent ${
            isTakeProfitPending ? "pending" : ""
          } ${
            coordinates.isTakeProfitHighlighted ||
            coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: Math.min(coordinates.entryY, coordinates.takeProfitY),
            height: Math.max(
              2,
              Math.abs(coordinates.takeProfitY - coordinates.entryY),
            ),
            width: coordinates.paneWidth,
          }}
        />
      )}

      {showStopZone && (
        <div
          className={`position-bracket-zone loss persistent ${
            isStopPending ? "pending" : ""
          } ${
            coordinates.isStopHighlighted || coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: Math.min(coordinates.entryY, coordinates.stopY),
            height: Math.max(
              2,
              Math.abs(coordinates.stopY - coordinates.entryY),
            ),
            width: coordinates.paneWidth,
          }}
        />
      )}

      {preview && (
        <div
          className={`position-bracket-zone ${
            dragKind === "TAKE_PROFIT" ? "profit" : "loss"
          }`}
          style={{
            left: coordinates.paneLeft,
            top: preview.top,
            height: Math.max(2, preview.height),
            width: coordinates.paneWidth,
          }}
        >
          <span>
            {dragKind === "TAKE_PROFIT" ? "FULL TP" : "STOP LOSS"}{" "}
            {previewPrice?.toFixed(pricePrecision)} ·{" "}
            {Math.abs(preview.distancePct).toFixed(2)}%
          </span>
        </div>
      )}

      <div
        className={`position-entry-line ${
          coordinates.isPositionHighlighted ? "highlighted" : ""
        }`}
        style={{
          left: coordinates.paneLeft,
          top: coordinates.entryY,
          width: coordinates.entryLineWidth,
        }}
      >
        {(showTakeProfitButton || showStopLossButton) && (
          <div className="position-entry-controls">
            <div className="position-bracket-handles">
              {showTakeProfitButton && (
                <button
                  className="position-bracket-handle take-profit"
                  disabled={isSubmitting}
                  onPointerDown={(event) => beginDrag(event, "TAKE_PROFIT")}
                  title={
                    displayedTakeProfitPrice == null
                      ? "Click, move the mouse, then click again to place full take profit"
                      : "Click, move the mouse, then click again to move full take profit"
                  }
                >
                  TP FULL
                </button>
              )}

              {showStopLossButton && (
                <button
                  className="position-bracket-handle stop-loss"
                  disabled={isSubmitting}
                  onPointerDown={(event) => beginDrag(event, "STOP_LOSS")}
                  title="Click, move the mouse, then click again to place stop loss"
                >
                  STOP LOSS
                </button>
              )}

              {position && (
                <button
                  className="position-bracket-close"
                  disabled={isClosingPosition}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void closePositionNow();
                  }}
                  title="Close this position at market - same as Positions panel's Market button"
                >
                  {isClosingPosition ? "…" : "×"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {showStopLine && (
        <div
          className={`position-stop-line ${
            stopControlsBelow ? "controls-below" : ""
          } ${isStopPending ? "pending" : ""} ${
            savedStop ? "draggable" : ""
          } ${
            coordinates.isStopHighlighted || coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: coordinates.stopY,
            width: coordinates.paneWidth,
          }}
        >
          {savedStop && !isSubmitting && (
            <div
              className="position-stop-grab"
              onPointerDown={beginMoveStop}
              title="Click, move the mouse, then click again to move the stop loss"
            />
          )}

          <span>SL FULL · {displayedStopPrice.toFixed(pricePrecision)}</span>

          {savedStop && (
            <button
              disabled={isSubmitting}
              onPointerDown={cancelStop}
              title="Cancel stop loss"
            >
              ×
            </button>
          )}
        </div>
      )}

      {showEdgeHandles && edgeHandleBounds && (
        <div
          className={`position-bracket-edge-handle right ${
            edgeDrag === "ZONE_RIGHT" ? "active" : ""
          }`}
          style={{
            left:
              coordinates.paneLeft +
              coordinates.paneWidth -
              ZONE_EDGE_HANDLE_WIDTH_PX / 2,
            top: edgeHandleBounds.top,
            height: edgeHandleBounds.height,
          }}
          onPointerDown={beginEdgeDrag}
          title="Click, move the mouse, then click again to resize the zone"
        />
      )}

      {message && (
        <div
          className={`position-bracket-message ${
            message.toLowerCase().includes("must") ||
            message.toLowerCase().includes("unable") ||
            message.toLowerCase().includes("error")
              ? "error"
              : ""
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}
