import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { UTCTimestamp } from "lightweight-charts";
import {
  DEFAULT_BOX_COLOR,
  DEFAULT_LINE_COLOR,
  PENDING_LIMIT_LONG_COLOR,
  PENDING_LIMIT_SHORT_COLOR,
  alignTimeToInterval,
  type Interval,
} from "../config/constants";
import { hexToRgba, brightenColor } from "../utils/geometry";
import { cloneDrawing, getTextFontSize } from "../utils/drawings";
import { startPacedLoop } from "../utils/pacedLoop";
import { localDateTimeFormatter } from "../utils/time";
import type {
  ContextMenuState,
  DragState,
  Drawing,
  BoxDrawing,
  HorizontalDrawing,
  PenDrawing,
  ScreenPoint,
  TrendDrawing,
  TextDrawing,
} from "../types/drawing";
import type { TradeMarker } from "../trading/types";
import {
  cancelOrder,
  chaseLimitOrder,
  modifyLimitOrder,
  repriceReduceOrder,
} from "../trading/api/orders";
import { isStaleOrderError } from "../trading/errors";
import type { ChartRefs } from "./useChartRefs";
import type { CoordinateMapping } from "./useCoordinateMapping";
import type { DrawingsApi } from "./useDrawings";
import type { MarketDataApi } from "./useMarketData";
import type { TradeMenuApi } from "./useTradeMenu";

/**
 * Binance order lines (pending limit entries/adds/reduces) already get
 * their own hover UX - the cancel/chase tooltips handled elsewhere in
 * this file. The hover-info popup (see hoveredDrawingInfo below) is only
 * for drawings the user actually drew themselves, so it doesn't pile up
 * on top of that existing UI.
 */
function isOrderDrawing(drawing: Drawing): boolean {
  return (
    drawing.type === "horizontal" &&
    (drawing.orderId !== undefined || drawing.orderSide !== undefined)
  );
}

function isFullTakeProfitDrawing(drawing: HorizontalDrawing): boolean {
  const isReduceOrder =
    drawing.orderIntent === "REDUCE" ||
    drawing.clientOrderId?.startsWith("fe-red-") === true;

  return (
    isReduceOrder &&
    (drawing.orderReducePct === 100 ||
      drawing.orderRemainingPct === 0 ||
      /^fe-red-p100-r0-/i.test(drawing.clientOrderId ?? ""))
  );
}

function publishFullTakeProfitPreview(
  drawing: HorizontalDrawing,
  price: number | null,
): void {
  if (!isFullTakeProfitDrawing(drawing) || !drawing.orderSymbol) return;

  window.dispatchEvent(
    new CustomEvent("full-take-profit-preview-changed", {
      detail: { symbol: drawing.orderSymbol.toUpperCase(), price },
    }),
  );
}

/** How long the mouse has to sit still over a drawing before the info popup appears. */
const HOVER_INFO_DELAY_MS = 500;

/** The 8 resize-handle drag modes a Box supports - 4 corners + 4 edges. */
type BoxHandleMode = Extract<DragState["mode"], `box-${string}`>;

/**
 * Pure function computing a Box's next start/end from one resize handle
 * being dragged to `cursor` - shared by the click-move-click flow below
 * (armedBoxHandle's pointermove) so the math lives in exactly one place.
 * Corners move both dimensions together, pivoting on whichever corner is
 * diagonally opposite the one being dragged. Edge midpoints move only the
 * ONE dimension under the cursor - e.g. the top edge only changes the top
 * price, while both left/right times and the bottom price stay exactly
 * where they were - never both dimensions like a corner drag does.
 */
function computeBoxResize(
  original: BoxDrawing,
  mode: BoxHandleMode,
  cursor: { time: UTCTimestamp; price: number },
): { start: { time: UTCTimestamp; price: number }; end: { time: UTCTimestamp; price: number } } {
  const leftTime = Math.min(
    Number(original.start.time),
    Number(original.end.time),
  ) as UTCTimestamp;
  const rightTime = Math.max(
    Number(original.start.time),
    Number(original.end.time),
  ) as UTCTimestamp;
  const topPrice = Math.max(original.start.price, original.end.price);
  const bottomPrice = Math.min(original.start.price, original.end.price);

  if (
    mode === "box-top-left" ||
    mode === "box-top-right" ||
    mode === "box-bottom-left" ||
    mode === "box-bottom-right"
  ) {
    let opposite: { time: UTCTimestamp; price: number };

    if (mode === "box-top-left") {
      opposite = { time: rightTime, price: bottomPrice };
    } else if (mode === "box-top-right") {
      opposite = { time: leftTime, price: bottomPrice };
    } else if (mode === "box-bottom-left") {
      opposite = { time: rightTime, price: topPrice };
    } else {
      opposite = { time: leftTime, price: topPrice };
    }

    return { start: { ...cursor }, end: opposite };
  }

  let nextLeftTime = leftTime;
  let nextRightTime = rightTime;
  let nextTopPrice = topPrice;
  let nextBottomPrice = bottomPrice;

  if (mode === "box-left") nextLeftTime = cursor.time;
  if (mode === "box-right") nextRightTime = cursor.time;
  if (mode === "box-top") nextTopPrice = cursor.price;
  if (mode === "box-bottom") nextBottomPrice = cursor.price;

  return {
    start: { time: nextLeftTime, price: nextTopPrice },
    end: { time: nextRightTime, price: nextBottomPrice },
  };
}

/**
 * Everything that happens directly on the canvas overlay: the
 * paced render loop, all pointer-down/move/up capture
 * handling for creating/dragging/selecting drawings, the right-click
 * context menu trigger, and the double-click trade-ticket trigger.
 */
export function useDrawingCanvas(
  refs: ChartRefs,
  coord: CoordinateMapping,
  drawingsApi: DrawingsApi,
  marketData: MarketDataApi,
  tradeMenuApi: TradeMenuApi,
  isHotkeysOpen: boolean,
  setIsHotkeysOpen: (open: boolean) => void,
) {
  const [isHoveringDrawing, setIsHoveringDrawing] = useState(false);
  const [editingText, setEditingText] = useState<{
    drawingId: string;
    value: string;
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
    color: string;
    align: "left" | "center" | "right";
  } | null>(null);
  const editingTextRef = useRef<typeof editingText>(null);

  useEffect(() => {
    editingTextRef.current = editingText;
  }, [editingText]);

  // Whether the currently-hovered drawing is specifically a horizontal
  // (price) line - order lines, or a plain horizontal drawing. Tracked
  // separately from isHoveringDrawing so the chart can show the same
  // ns-resize cursor over these that the stop-loss line already uses
  // (dragging either one is a purely vertical price move), while other
  // drawing types (trend, box, pen, vertical) keep the generic pointer
  // cursor.
  const [isHoveringHorizontalDrawing, setIsHoveringHorizontalDrawing] =
    useState(false);

  // Position (wrap-relative) of the "Cancel order" tooltip shown while
  // hovering a pending order's cancel button; null when not hovering one.
  const [cancelTooltip, setCancelTooltip] = useState<ScreenPoint | null>(null);
  const [chaseTooltip, setChaseTooltip] = useState<ScreenPoint | null>(null);

  /*
   * The "hover a drawing for a moment to see its info" popup (currently
   * just the timeframe it was drawn on - see DrawingInfoTooltip.tsx).
   * `point` tracks the current mouse position so the popup keeps
   * following the cursor while it stays over the same drawing, but only
   * gets set (making the popup visible) after HOVER_INFO_DELAY_MS of
   * continuous hover over that one drawing - see the timer logic in
   * handlePointerMoveCapture below.
   */
  const [hoveredDrawingInfo, setHoveredDrawingInfo] = useState<{
    drawing: Drawing;
    point: ScreenPoint;
  } | null>(null);
  const hoverInfoTimerRef = useRef<number | null>(null);
  const hoverInfoDrawingIdRef = useRef<string | null>(null);

  const clearHoverInfoTimer = () => {
    if (hoverInfoTimerRef.current !== null) {
      window.clearTimeout(hoverInfoTimerRef.current);
      hoverInfoTimerRef.current = null;
    }
  };

  const clearHoveredDrawingInfo = () => {
    hoverInfoDrawingIdRef.current = null;
    clearHoverInfoTimer();
    setHoveredDrawingInfo(null);
  };

  useEffect(() => clearHoverInfoTimer, []);

  // Order lines (limit entries/adds/reduces) keep click-move-click repricing
  // for a mouse, while touch uses press-drag-release. This is the id of the
  // line currently armed by either interaction; the pointer ref below tells
  // the effect which confirmation model to use without changing desktop UX.
  const [armedOrderLineId, setArmedOrderLineId] = useState<string | null>(
    null,
  );
  const armedOrderLineBeforeRef = useRef<HorizontalDrawing | null>(null);
  const armedOrderLinePointerRef = useRef<{
    pointerId: number;
    pointerType: string;
  } | null>(null);

  /*
   * Same click-move-click interaction as the order-line reprice flow above,
   * applied to a trendline's own start/end handles - click a handle once
   * to pick it up, move the mouse freely (no button held) to reposition
   * it live, click again anywhere to drop it in place. Replaces the old
   * press-and-hold drag specifically for these two handles; a plain
   * whole-line move (grabbing the line itself, not an endpoint) still
   * uses the ordinary drag path via refs.dragRef.
   */
  const [armedTrendEndpoint, setArmedTrendEndpoint] = useState<{
    drawingId: string;
    end: "start" | "end";
  } | null>(null);
  const armedTrendEndpointBeforeRef = useRef<TrendDrawing | null>(null);

  /*
   * Same click-move-click interaction as the trend-endpoint/order-line
   * flows above, applied to a box's 8 resize handles (4 corners + 4 edge
   * midpoints) - click a handle once to pick it up, move the mouse freely
   * (no button held) to reposition/resize it live, click again anywhere
   * to drop it. A plain whole-box move (grabbing the box body, not a
   * handle) still uses the ordinary press-and-hold drag path via
   * refs.dragRef.
   */
  const [armedBoxHandle, setArmedBoxHandle] = useState<{
    drawingId: string;
    mode: BoxHandleMode;
  } | null>(null);
  const armedBoxHandleBeforeRef = useRef<BoxDrawing | null>(null);

  const getLocalPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;

    if (!wrap) return null;

    const rect = wrap.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const PENDING_ORDER_LABEL_HEIGHT = 20;
  const PENDING_ORDER_LABEL_PADDING_X = 8;
  const PENDING_ORDER_CANCEL_SIZE = 20;
  const PENDING_ORDER_CHASE_WIDTH = 48;
  const PENDING_ORDER_GAP = 4;
  const PENDING_ORDER_EDGE_MARGIN = 10;
  const PENDING_ORDER_FONT =
    "600 11px 'JetBrains Mono', ui-monospace, monospace";

  const baseAsset = (symbol?: string) =>
    symbol?.replace(/(?:USDT|USDC|BUSD)$/i, "") || "";

  const formatOrderQuantity = (quantity?: number) => {
    if (quantity == null || !Number.isFinite(quantity)) return "";
    return quantity.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
    });
  };

  const getPendingOrderLabelText = (drawing: HorizontalDrawing) => {
    if (drawing.orderIntent !== "REDUCE") {
      // FIX: was drawing.price.toFixed(1) - a flat 1 decimal place that
      // only ever looked right for BTC. For a symbol whose real tick
      // size needs several decimals (XRP, for instance), rounding the
      // displayed price to 1 decimal made every limit/entry order line
      // show the same label across a wide band of actual prices, making
      // it impossible to tell them apart or place one precisely.
      // marketData.pricePrecision is fetched per-symbol from Binance's
      // own exchangeInfo (see useMarketData.ts / exchangeInfo.ts).
      //
      // FIX 2: this then read `marketData.pricePrecision` directly -
      // fine in an ordinary render, but this function is called from
      // drawCanvas, which runs inside the paced drawing loop
      // kicked off by a mount-once (`useEffect(..., [])`) effect further
      // down. Because that loop re-schedules itself by calling
      // the next scheduled draw from within its own closure,
      // only the very FIRST render's version of drawCanvas (and
      // everything it closed over, including this whole marketData
      // object) ever actually runs, for the entire lifetime of the app -
      // any later update to the real pricePrecision, however long
      // afterward, was invisible to it. Every entry/limit order price
      // label was permanently stuck showing 0 decimals (whatever
      // pricePrecision defaults to before the very first exchangeInfo
      // fetch resolves), on every symbol, forever, only ever fixable by
      // a full page reload landing a lucky race. pricePrecisionRef is a
      // ref specifically for this - its `.current` is kept in sync by
      // useMarketData.ts on every real update, and reading `.current`
      // here (a property lookup at call time) sees that live value even
      // from inside an otherwise-frozen closure, unlike the plain
      // `pricePrecision` value itself would.
      return drawing.price.toFixed(marketData.pricePrecisionRef.current);
    }

    const pct = drawing.orderReducePct;
    const quantity = formatOrderQuantity(drawing.orderQuantity);
    const asset = baseAsset(drawing.orderSymbol);
    const remainingPct = drawing.orderRemainingPct;
    const left =
      remainingPct == null ? "" : ` · LEFT ${Math.max(0, remainingPct)}%`;
    const pctText = pct == null ? "TP" : `TP ${pct}%`;
    const quantityText = quantity ? ` · ${quantity}${asset ? ` ${asset}` : ""}` : "";

    return `${pctText}${quantityText}${left}`;
  };

  const getPendingOrderRects = (drawing: HorizontalDrawing) => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;
    const canvas = refs.canvasRef.current;

    if (!chart || !series || !canvas) return null;

    const y = series.priceToCoordinate(drawing.price);
    if (y == null) return null;

    const context = canvas.getContext("2d");
    if (!context) return null;

    const labelText = getPendingOrderLabelText(drawing);

    context.save();
    context.font = PENDING_ORDER_FONT;
    const textWidth = context.measureText(labelText).width;
    context.restore();

    const paneWidth = chart.paneSize().width;

    const cancelX =
      paneWidth - PENDING_ORDER_EDGE_MARGIN - PENDING_ORDER_CANCEL_SIZE;
    const isChaseable = drawing.orderIntent !== "REDUCE";
    const chaseX = isChaseable
      ? cancelX - PENDING_ORDER_GAP - PENDING_ORDER_CHASE_WIDTH
      : cancelX;
    const labelWidth = textWidth + PENDING_ORDER_LABEL_PADDING_X * 2;
    const labelX =
      (isChaseable ? chaseX : cancelX) -
      PENDING_ORDER_GAP -
      labelWidth;
    const boxY = y - PENDING_ORDER_LABEL_HEIGHT / 2;

    return {
      label: {
        x: labelX,
        y: boxY,
        width: labelWidth,
        height: PENDING_ORDER_LABEL_HEIGHT,
      },
      chase: isChaseable
        ? {
            x: chaseX,
            y: boxY,
            width: PENDING_ORDER_CHASE_WIDTH,
            height: PENDING_ORDER_LABEL_HEIGHT,
          }
        : null,
      cancel: {
        x: cancelX,
        y: boxY,
        width: PENDING_ORDER_CANCEL_SIZE,
        height: PENDING_ORDER_LABEL_HEIGHT,
      },
    };
  };

  const isPointInRect = (
    x: number,
    y: number,
    rect: { x: number; y: number; width: number; height: number },
  ) =>
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;

  const findPendingOrderCancelHit = (x: number, y: number) => {
    for (const drawing of refs.drawingsRef.current) {
      if (drawing.type !== "horizontal" || !drawing.orderSide) continue;

      const rects = getPendingOrderRects(drawing);
      if (!rects) continue;

      if (isPointInRect(x, y, rects.cancel)) {
        return { drawing, rects };
      }
    }

    return null;
  };


  const findPendingOrderChaseHit = (x: number, y: number) => {
    for (const drawing of refs.drawingsRef.current) {
      if (drawing.type !== "horizontal" || !drawing.orderSide) continue;

      const rects = getPendingOrderRects(drawing);
      if (!rects?.chase) continue;

      if (isPointInRect(x, y, rects.chase)) {
        return { drawing, rects };
      }
    }

    return null;
  };

  const findTouchOrderMoveHit = (x: number, y: number) => {
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;
    if (!chart || !series) return null;

    const paneWidth = chart.paneSize().width;
    const touchLineRadius = 22;
    const touchLabelPadding = 8;

    /*
     * FIX (mobile TP line could fall through and pan the chart): the
     * desktop hit test allows only 8px around a one-pixel order line.
     * That is too small for a fingertip, and the visible yellow label is
     * much taller than the line itself. Treat both a 44px-high line band
     * and the padded label rectangle as the same draggable TP target.
     */
    for (
      let index = refs.drawingsRef.current.length - 1;
      index >= 0;
      index -= 1
    ) {
      const drawing = refs.drawingsRef.current[index];
      if (drawing.type !== "horizontal" || !drawing.orderSide) continue;

      const lineY = series.priceToCoordinate(drawing.price);
      const onLine =
        lineY != null &&
        x >= 0 &&
        x < paneWidth &&
        Math.abs(y - lineY) <= touchLineRadius;

      const label = getPendingOrderRects(drawing)?.label;
      const onLabel =
        label != null &&
        x >= label.x - touchLabelPadding &&
        x <= label.x + label.width + touchLabelPadding &&
        y >= label.y - touchLabelPadding &&
        y <= label.y + label.height + touchLabelPadding;

      if (onLine || onLabel) return drawing;
    }

    return null;
  };

  const getTextRect = (drawing: TextDrawing) => {
    // Same model as Box: two REAL chart-space anchors, both converted to
    // screen pixels fresh every frame. This is what makes the box scale
    // with the chart under zoom instead of staying a fixed pixel size -
    // both corners track their own chart point exactly the way a Box's
    // corners do. MIN_BOX_SIZE is a floor only, for the degenerate case
    // where the two anchors collapse to (near) the same pixel at extreme
    // zoom-out - getTextFontSize's own clamp is the real defense against
    // unreadable text.
    const MIN_BOX_SIZE = 18;

    const start = coord.chartPointToScreen(drawing.start);
    const end = coord.chartPointToScreen(drawing.end);
    if (!start || !end) return null;

    return {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      width: Math.max(MIN_BOX_SIZE, Math.abs(end.x - start.x)),
      height: Math.max(MIN_BOX_SIZE, Math.abs(end.y - start.y)),
    };
  };

  /*
   * The DOM text-editor <input> (see ChartPanel.tsx) is a real element,
   * not canvas-clipped like the selection border drawn elsewhere in this
   * file - an oversized one is a genuine layout problem, not just a
   * visual one. A box resized while zoomed way out, then viewed again at
   * a normal zoom level, can be thousands of pixels wide (its on-screen
   * size now derives from real chart-space distance between two anchors -
   * see getTextRect above), and editing beyond the visible pane isn't
   * useful anyway - so this clamps the box actually handed to the editor
   * down to what's on-screen. Left/top are left alone (only width/height
   * are clamped) so the box still starts exactly where its anchor is;
   * this just stops it from extending absurdly far past the edge.
   */
  const clampToEditablePane = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) => {
    const paneSize = refs.chartRef.current?.paneSize();
    if (!paneSize) return rect;

    const maxWidth = Math.max(18, paneSize.width - Math.max(0, rect.left));
    const maxHeight = Math.max(18, paneSize.height - Math.max(0, rect.top));

    return {
      left: rect.left,
      top: rect.top,
      width: Math.min(rect.width, maxWidth),
      height: Math.min(rect.height, maxHeight),
    };
  };

  const beginTextEditing = (drawing: TextDrawing) => {
    const rawRect = getTextRect(drawing);
    if (!rawRect) return;
    const rect = clampToEditablePane(rawRect);
    const nextEditor = {
      drawingId: drawing.id,
      value: drawing.text,
      ...rect,
      fontSize: getTextFontSize(rect.width, rect.height, drawing.text),
      color: drawing.color,
      align: drawing.align ?? "left",
    };
    editingTextRef.current = nextEditor;
    setEditingText(nextEditor);
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const commitTextEditing = () => {
    const editor = editingTextRef.current;
    if (!editor) return;
    const current = refs.drawingsRef.current.find((drawing) => drawing.id === editor.drawingId);
    editingTextRef.current = null;
    setEditingText(null);
    if (!current || current.type !== "text" || current.text === editor.value) return;
    drawingsApi.updateDrawing(current.id, (drawing) =>
      drawing.type === "text" ? { ...drawing, text: editor.value || "text here..." } : drawing,
    );
  };

  const cancelTextEditing = () => {
    editingTextRef.current = null;
    setEditingText(null);
  };

  const drawCanvas = () => {
    const canvas = refs.canvasRef.current;
    const wrap = refs.chartWrapRef.current;
    const chart = refs.chartRef.current;
    const series = refs.candleRef.current;

    if (!canvas || !wrap || !chart || !series) {
      return;
    }

    const width = wrap.clientWidth;
    const height = wrap.clientHeight;

    const pixelRatio = window.devicePixelRatio || 1;

    const expectedWidth = Math.round(width * pixelRatio);
    const expectedHeight = Math.round(height * pixelRatio);

    if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
      canvas.width = expectedWidth;
      canvas.height = expectedHeight;

      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    /*
     * FIX: everything from here down used to run unguarded. A single bad
     * frame - a stale/NaN coordinate right after the tab or the whole
     * laptop wakes from sleep, the chart briefly not fully laid out yet
     * mid-symbol-switch, etc. - threw an uncaught exception straight out
     * of this rAF callback. Nothing ever caught it, so the
     * next scheduled draw never ran, permanently
     * killing this whole loop. Every drawing (trendlines, pen strokes,
     * boxes) and every order-line label they share this canvas with went
     * blank and stayed blank - only a full page reload restarted the
     * effect and brought them back. Catching here means one bad frame
     * just gets skipped and retried ~16ms later with fresh data instead
     * of taking the whole canvas down for the rest of the session.
     */
    try {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

    const paneSize = chart.paneSize();

    wrap.style.setProperty(
      "--pane-inset-right",
      `${Math.max(0, width - paneSize.width)}px`,
    );
    wrap.style.setProperty(
      "--pane-inset-bottom",
      `${Math.max(0, height - paneSize.height)}px`,
    );

    context.save();
    context.beginPath();
    context.rect(0, 0, paneSize.width, paneSize.height);
    context.clip();

    const drawLine = (
      start: ScreenPoint,
      end: ScreenPoint,
      color: string,
      selected: boolean,
      dashed = false,
      emphasized = false,
      // Independent from `selected` (which also controls line width, and
      // gets combined with the pending-order blink-highlight flag at that
      // call site) so the color only brightens for a TRUE selection, not
      // every time this happens to render a bit thicker.
      brighten = selected,
    ) => {
      context.save();
      context.beginPath();

      context.strokeStyle = brighten ? brightenColor(color) : color;
      context.lineWidth = emphasized ? 4 : selected ? 2.5 : 2;
      if (emphasized) {
        context.shadowColor = color;
        context.shadowBlur = 10;
      }
      context.lineCap = "round";
      context.setLineDash(dashed ? [7, 5] : []);

      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();

      context.restore();
    };

    const drawHandles = (
      start: ScreenPoint,
      end: ScreenPoint,
      color: string,
    ) => {
      context.save();
      context.fillStyle = color;

      context.fillRect(start.x - 4, start.y - 4, 8, 8);
      context.fillRect(end.x - 4, end.y - 4, 8, 8);

      context.restore();
    };

    const drawBoxHandles = (
      start: ScreenPoint,
      end: ScreenPoint,
      color: string,
    ) => {
      const left = Math.min(start.x, end.x);
      const right = Math.max(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);

      context.save();
      context.fillStyle = color;

      // 4 corners + 4 edge midpoints, matching the 8 drag modes a box now
      // supports (see the "box-*" DragState modes) - previously only the
      // corners were drawn here, so the edge-drag handles that now exist
      // functionally had no visual indicator at all.
      for (const point of [
        { x: left, y: top },
        { x: right, y: top },
        { x: left, y: bottom },
        { x: right, y: bottom },
        { x: (left + right) / 2, y: top },
        { x: right, y: (top + bottom) / 2 },
        { x: (left + right) / 2, y: bottom },
        { x: left, y: (top + bottom) / 2 },
      ]) {
        context.fillRect(point.x - 4, point.y - 4, 8, 8);
      }

      context.restore();
    };

    const drawPendingOrderLabel = (
      rect: { x: number; y: number; width: number; height: number },
      text: string,
      color: string,
    ) => {
      context.save();
      context.fillStyle = color;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);

      context.fillStyle = "#0b0e14";
      context.font = PENDING_ORDER_FONT;
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillText(
        text,
        rect.x + PENDING_ORDER_LABEL_PADDING_X,
        rect.y + rect.height / 2 + 1,
      );
      context.restore();
    };

    const drawPendingOrderCancelButton = (
      rect: { x: number; y: number; width: number; height: number },
      color: string,
    ) => {
      context.save();
      context.fillStyle = "#10141b";
      context.fillRect(rect.x, rect.y, rect.width, rect.height);

      context.strokeStyle = color;
      context.lineWidth = 1;
      context.strokeRect(
        rect.x + 0.5,
        rect.y + 0.5,
        rect.width - 1,
        rect.height - 1,
      );

      context.fillStyle = color;
      context.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(
        "×",
        rect.x + rect.width / 2,
        rect.y + rect.height / 2 + 1,
      );
      context.restore();
    };

    const drawPendingOrderChaseButton = (
      rect: { x: number; y: number; width: number; height: number },
      color: string,
      isChasing = false,
    ) => {
      context.save();
      context.fillStyle = "rgba(13, 16, 23, 0.96)";
      context.fillRect(rect.x, rect.y, rect.width, rect.height);

      context.strokeStyle = color;
      context.lineWidth = 1;
      context.strokeRect(
        rect.x + 0.5,
        rect.y + 0.5,
        rect.width - 1,
        rect.height - 1,
      );

      context.fillStyle = color;
      context.font = "700 8px 'JetBrains Mono', ui-monospace, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(
        isChasing ? "..." : "CHASE",
        rect.x + rect.width / 2,
        rect.y + rect.height / 2 + 0.5,
      );

      context.restore();
    };

    const drawTradeMarker = (
      anchor: ScreenPoint,
      side: TradeMarker["side"],
      color: string,
    ) => {
      const isBuy = side === "BUY";

      // FIX: this was a plain object literal, which only has the 6 keys
      // actually written out here - indexing it with the full Interval
      // union (which also includes "12h" and "1w") was a type error, even
      // though the runtime behavior was always correct: a missing key
      // just reads as undefined and falls through to the `?? 1` default
      // below. Marking it Partial<Record<Interval, number>> tells
      // TypeScript what was already true at runtime - not every interval
      // needs its own entry here, unlisted ones use the default 1 scale.
const markerScaleByInterval: Partial<
  Record<typeof refs.intervalRef.current, number>
> = {
  "1m": 0.9,
  "5m": 0.7,
  "15m": 0.6,
  "1h": 0.5,
  "4h": 0.5,
  "1d": 0.45,
};

      const intervalScale =
        markerScaleByInterval[refs.intervalRef.current] ?? 1;

      const visibleRange = refs.chartRef.current
        ?.timeScale()
        .getVisibleLogicalRange();
      const visibleBars = visibleRange
        ? Math.max(1, visibleRange.to - visibleRange.from)
        : 245;
      const zoomScale = Math.min(
        1.8,
        Math.max(0.55, Math.sqrt(245 / visibleBars)),
      );
      const markerScale = intervalScale * zoomScale;

      const badgeWidth = 20 * markerScale;
      const badgeHeight = 16 * markerScale;
      const tailSize = 6 * markerScale;
      const gap = 4 * markerScale;
      const radius = 4 * markerScale;
      const fontSize = Math.max(6, 10 * markerScale);

      const badgeCenterY = isBuy
        ? anchor.y + gap + tailSize + badgeHeight / 2
        : anchor.y - gap - tailSize - badgeHeight / 2;

      const left = anchor.x - badgeWidth / 2;
      const top = badgeCenterY - badgeHeight / 2;

      context.save();
      context.fillStyle = color;

      context.beginPath();
      context.moveTo(left + radius, top);
      context.arcTo(
        left + badgeWidth,
        top,
        left + badgeWidth,
        top + badgeHeight,
        radius,
      );
      context.arcTo(
        left + badgeWidth,
        top + badgeHeight,
        left,
        top + badgeHeight,
        radius,
      );
      context.arcTo(left, top + badgeHeight, left, top, radius);
      context.arcTo(left, top, left + badgeWidth, top, radius);
      context.closePath();
      context.fill();

      context.beginPath();
      if (isBuy) {
        context.moveTo(anchor.x - tailSize, top);
        context.lineTo(anchor.x + tailSize, top);
        context.lineTo(anchor.x, anchor.y);
      } else {
        context.moveTo(anchor.x - tailSize, top + badgeHeight);
        context.lineTo(anchor.x + tailSize, top + badgeHeight);
        context.lineTo(anchor.x, anchor.y);
      }
      context.closePath();
      context.fill();

      context.fillStyle = "#0b0e14";
      context.font = `700 ${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(isBuy ? "B" : "S", anchor.x, badgeCenterY + 0.5);

      context.restore();
    };

    for (const drawing of refs.drawingsRef.current) {
      const selected = refs.selectedIdRef.current === drawing.id;

      if (drawing.type === "vertical") {
        const x = coord.timeToX(drawing.time);

        if (x === null) continue;

        drawLine({ x, y: 0 }, { x, y: height }, drawing.color, selected, true);
        continue;
      }

      if (drawing.type === "horizontal") {
        const y = series.priceToCoordinate(drawing.price);

        if (y == null) continue;

        const isPendingOrder = drawing.orderSide !== undefined;
        const isReduceOrder = drawing.orderIntent === "REDUCE";
        const isHighlighted =
          drawing.orderId !== undefined &&
          refs.highlightedOrderIdRef.current === drawing.orderId &&
          Date.now() < refs.highlightedOrderUntilRef.current;
        const blinkOn =
          isHighlighted && Math.floor(Date.now() / 180) % 2 === 0;
        const renderColor = blinkOn ? "#fff3b0" : drawing.color;

        drawLine(
          { x: 0, y },
          { x: width, y },
          renderColor,
          selected || isHighlighted,
          isPendingOrder ? isReduceOrder : true,
          blinkOn,
          selected,
        );

        if (drawing.orderSide) {
          const rects = getPendingOrderRects(drawing);

          if (rects) {
            drawPendingOrderLabel(
              rects.label,
              getPendingOrderLabelText(drawing),
              renderColor,
            );
            if (rects.chase) {
              drawPendingOrderChaseButton(
                rects.chase,
                renderColor,
                drawing.orderChasing,
              );
            }
            drawPendingOrderCancelButton(rects.cancel, renderColor);
          }
        }

        continue;
      }

      if (drawing.type === "coordinate-marker") {
        const x = coord.timeToX(drawing.time);
        const y = series.priceToCoordinate(drawing.price);

        if (x === null || y === null) continue;

        // A persistent, one-quadrant crosshair: horizontal ray runs from
        // the anchor to the price scale, vertical ray from the anchor down
        // to the time axis. Clipping above keeps both rays inside the plot.
        drawLine(
          { x, y },
          { x: paneSize.width, y },
          drawing.color,
          selected,
          true,
        );
        drawLine(
          { x, y },
          { x, y: paneSize.height },
          drawing.color,
          selected,
          true,
        );

        context.save();
        context.beginPath();
        context.arc(x, y, selected ? 4.5 : 3.5, 0, Math.PI * 2);
        context.fillStyle = selected
          ? brightenColor(drawing.color)
          : drawing.color;
        context.fill();
        context.restore();
        continue;
      }

      if (drawing.type === "text") {
        const rect = getTextRect(drawing);
        if (!rect) continue;

        const align = drawing.align ?? "left";

        const activeEditor = editingTextRef.current;
        if (activeEditor?.drawingId === drawing.id) {
          const editableRect = clampToEditablePane(rect);
          const fontSize = getTextFontSize(editableRect.width, editableRect.height, activeEditor.value);
          if (
            Math.abs(activeEditor.left - editableRect.left) > 0.5 ||
            Math.abs(activeEditor.top - editableRect.top) > 0.5 ||
            Math.abs(activeEditor.width - editableRect.width) > 0.5 ||
            Math.abs(activeEditor.height - editableRect.height) > 0.5 ||
            activeEditor.fontSize !== fontSize ||
            activeEditor.color !== drawing.color ||
            activeEditor.align !== align
          ) {
            setEditingText((previous) => {
              if (!previous || previous.drawingId !== drawing.id) return previous;
              const next = { ...previous, ...editableRect, fontSize, color: drawing.color, align };
              editingTextRef.current = next;
              return next;
            });
          }
          // The DOM editor replaces the canvas text while editing. Drawing both
          // caused the dark/duplicate text visible behind the selected input.
          continue;
        }

        const fontSize = getTextFontSize(rect.width, rect.height, drawing.text);

        // Canvas's own textAlign controls both which edge the text hugs
        // AND which x-coordinate fillText expects, so both have to change
        // together: "left" measures from the box's left edge, "center"
        // from its horizontal midpoint, "right" from its right edge.
        const textX =
          align === "center"
            ? rect.left + rect.width / 2
            : align === "right"
              ? rect.left + rect.width
              : rect.left;

        context.save();
        context.font = `500 ${fontSize}px Inter, "Helvetica Neue", Arial, sans-serif`;
        context.fillStyle = drawing.color;
        context.textAlign = align;
        context.textBaseline = "middle";
        context.fillText(drawing.text, textX, rect.top + rect.height / 2, rect.width);

        if (selected) {
          context.strokeStyle = brightenColor(drawing.color);
          context.lineWidth = 1.5;
          context.setLineDash([5, 4]);
          context.strokeRect(rect.left, rect.top, rect.width, rect.height);
          context.setLineDash([]);

          const handles = [
            [rect.left, rect.top],
            [rect.left + rect.width / 2, rect.top],
            [rect.left + rect.width, rect.top],
            [rect.left + rect.width, rect.top + rect.height / 2],
            [rect.left + rect.width, rect.top + rect.height],
            [rect.left + rect.width / 2, rect.top + rect.height],
            [rect.left, rect.top + rect.height],
            [rect.left, rect.top + rect.height / 2],
          ];
          context.fillStyle = brightenColor(drawing.color);
          for (const [hx, hy] of handles) context.fillRect(hx - 4, hy - 4, 8, 8);
        }
        context.restore();
        continue;
      }

      if (drawing.type === "pen") {
        const screenPoints = drawing.points
          .map((point) => coord.chartPointToScreen(point, false))
          .filter((point): point is ScreenPoint => point !== null);

        if (screenPoints.length < 2) continue;

        context.save();
        context.beginPath();
        context.strokeStyle = selected
          ? brightenColor(drawing.color)
          : drawing.color;
        context.lineWidth = selected ? 3 : 2;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.moveTo(screenPoints[0].x, screenPoints[0].y);

        for (
          let pointIndex = 1;
          pointIndex < screenPoints.length;
          pointIndex += 1
        ) {
          context.lineTo(
            screenPoints[pointIndex].x,
            screenPoints[pointIndex].y,
          );
        }

        context.stroke();
        context.restore();
        continue;
      }

      const start = coord.chartPointToScreen(drawing.start);
      const end = coord.chartPointToScreen(drawing.end);

      if (!start || !end) continue;

      if (drawing.type === "trend") {
        drawLine(start, end, drawing.color, selected);

        if (selected) {
          drawHandles(start, end, brightenColor(drawing.color));
        }

        continue;
      }

      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const boxWidth = Math.abs(end.x - start.x);
      const boxHeight = Math.abs(end.y - start.y);

      context.save();
      context.fillStyle = hexToRgba(drawing.color, 0.18);
      context.strokeStyle = selected
        ? brightenColor(drawing.color)
        : drawing.color;
      context.lineWidth = selected ? 2.5 : 2;

      context.fillRect(left, top, boxWidth, boxHeight);
      context.strokeRect(left, top, boxWidth, boxHeight);

      context.restore();

      if (selected) {
        drawBoxHandles(start, end, brightenColor(drawing.color));
      }
    }

    for (const marker of refs.tradeMarkersRef.current) {
      const alignedTime = alignTimeToInterval(
        marker.time,
        refs.intervalRef.current,
      );

      const loadedCandle = refs.loadedCandlesRef.current.find(
        (candle) => Number(candle.time) === Number(alignedTime),
      );

      const latestCandle = refs.lastCandleRef.current;
      const candle =
        loadedCandle ??
        (latestCandle && Number(latestCandle.time) === Number(alignedTime)
          ? latestCandle
          : null);

      if (!candle) continue;

      const x = coord.timeToX(alignedTime);
      const lowY = series.priceToCoordinate(candle.low);
      const highY = series.priceToCoordinate(candle.high);

      if (x === null || lowY === null || highY === null) continue;

      const anchor: ScreenPoint = {
        x,
        y: marker.side === "BUY" ? lowY : highY,
      };

      drawTradeMarker(
        anchor,
        marker.side,
        marker.side === "BUY"
          ? PENDING_LIMIT_LONG_COLOR
          : PENDING_LIMIT_SHORT_COLOR,
      );
    }

    const pendingStart = refs.pendingStartRef.current;
    const previewPoint = refs.previewPointRef.current;

    if (pendingStart && previewPoint) {
      const start = coord.chartPointToScreen(pendingStart);
      const end = coord.chartPointToScreen(previewPoint);

      if (start && end) {
        if (refs.toolRef.current === "trend") {
          context.save();
          context.globalAlpha = 0.75;
          drawLine(start, end, DEFAULT_LINE_COLOR, false);
          context.restore();
        }

        if (refs.toolRef.current === "box") {
          const left = Math.min(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const boxWidth = Math.abs(end.x - start.x);
          const boxHeight = Math.abs(end.y - start.y);

          context.save();
          context.fillStyle = hexToRgba(DEFAULT_BOX_COLOR, 0.18);
          context.strokeStyle = DEFAULT_BOX_COLOR;
          context.lineWidth = 2;

          context.fillRect(left, top, boxWidth, boxHeight);
          context.strokeRect(left, top, boxWidth, boxHeight);

          context.restore();
        }
      }
    }

    const rulerStart = refs.rulerStartRef.current;
    const rulerEnd = refs.rulerEndRef.current;

    if (rulerStart && rulerEnd) {
      const start = coord.chartPointToScreen(rulerStart);
      const end = coord.chartPointToScreen(rulerEnd);

      if (start && end && Number.isFinite(rulerStart.price) && rulerStart.price !== 0) {
        const left = Math.min(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const rulerWidth = Math.abs(end.x - start.x);
        const rulerHeight = Math.abs(end.y - start.y);
        const percentage = ((rulerEnd.price - rulerStart.price) / rulerStart.price) * 100;
        const positive = percentage >= 0;
        const color = positive ? "#34d399" : "#f04562";
        const label = `${positive ? "+" : ""}${percentage.toFixed(2)}%`;

        context.save();
        context.fillStyle = positive
          ? "rgba(52, 211, 153, 0.14)"
          : "rgba(240, 69, 98, 0.14)";
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.setLineDash([5, 4]);
        context.fillRect(left, top, rulerWidth, rulerHeight);
        context.strokeRect(left + 0.5, top + 0.5, Math.max(0, rulerWidth - 1), Math.max(0, rulerHeight - 1));
        context.setLineDash([]);

        context.font = "700 12px 'JetBrains Mono', ui-monospace, monospace";
        const textWidth = context.measureText(label).width;
        const labelWidth = textWidth + 14;
        const labelHeight = 24;
        const labelX = Math.max(4, Math.min((left + rulerWidth / 2) - labelWidth / 2, paneSize.width - labelWidth - 4));
        const preferredY = top + rulerHeight / 2 - labelHeight / 2;
        const labelY = Math.max(4, Math.min(preferredY, paneSize.height - labelHeight - 4));

        context.fillStyle = "rgba(11, 14, 20, 0.94)";
        context.fillRect(labelX, labelY, labelWidth, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(labelX + 0.5, labelY + 0.5, labelWidth - 1, labelHeight - 1);
        context.fillStyle = color;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2 + 0.5);
        context.restore();
      }
    }

    context.restore();

    // Coordinate-marker axis badges are intentionally rendered AFTER the
    // plot-pane clip is restored. The rays themselves stay inside the pane,
    // while these two labels occupy the same right-price / bottom-time gutters
    // that the live crosshair uses, making the stored coordinate readable even
    // when the mouse has moved somewhere else.
    for (const drawing of refs.drawingsRef.current) {
      if (drawing.type !== "coordinate-marker") continue;

      const x = coord.timeToX(drawing.time);
      const y = series.priceToCoordinate(drawing.price);
      if (x === null || y === null) continue;

      const selected = refs.selectedIdRef.current === drawing.id;
      const color = selected ? brightenColor(drawing.color) : drawing.color;

      context.save();
      context.font = "600 11px 'JetBrains Mono', ui-monospace, monospace";
      context.textBaseline = "middle";

      if (y >= 0 && y <= paneSize.height && width > paneSize.width) {
        const priceText = drawing.price.toFixed(
          marketData.pricePrecisionRef.current,
        );
        const labelX = paneSize.width;
        const labelHeight = 20;
        const labelY = Math.max(0, Math.min(y - labelHeight / 2, height - labelHeight));

        context.fillStyle = "rgba(11, 14, 20, 0.96)";
        context.fillRect(labelX, labelY, width - labelX, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(
          labelX + 0.5,
          labelY + 0.5,
          Math.max(0, width - labelX - 1),
          labelHeight - 1,
        );
        context.fillStyle = color;
        context.textAlign = "right";
        context.fillText(priceText, width - 5, labelY + labelHeight / 2 + 0.5);
      }

      if (x >= 0 && x <= paneSize.width && height > paneSize.height) {
        const timeText = localDateTimeFormatter.format(
          new Date(Number(drawing.time) * 1000),
        );
        const labelHeight = height - paneSize.height;
        const textWidth = context.measureText(timeText).width;
        const labelWidth = Math.min(
          paneSize.width,
          Math.max(116, textWidth + 16),
        );
        const labelX = Math.max(
          0,
          Math.min(x - labelWidth / 2, paneSize.width - labelWidth),
        );

        context.fillStyle = "rgba(11, 14, 20, 0.96)";
        context.fillRect(labelX, paneSize.height, labelWidth, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = 1;
        context.strokeRect(
          labelX + 0.5,
          paneSize.height + 0.5,
          labelWidth - 1,
          Math.max(0, labelHeight - 1),
        );
        context.fillStyle = color;
        context.textAlign = "center";
        context.fillText(
          timeText,
          labelX + labelWidth / 2,
          paneSize.height + labelHeight / 2 + 0.5,
        );
      }

      context.restore();
    }
    } catch (error) {
      console.error(
        "[useDrawingCanvas] drawCanvas frame failed, retrying next frame:",
        error,
      );
    }

  };

  useEffect(() => {
    // The drawing layer used to repaint at the monitor refresh rate even when
    // absolutely nothing changed. A bounded 20 FPS cadence stays smooth for
    // pointer interactions while avoiding a permanent 60/100/240 FPS canvas
    // workload on high-refresh multi-monitor setups.
    return startPacedLoop(drawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const armOrderLineMove = (
    drawing: HorizontalDrawing,
    pointer: { pointerId: number; pointerType: string },
  ) => {
    armedOrderLineBeforeRef.current = cloneDrawing(drawing) as HorizontalDrawing;
    armedOrderLinePointerRef.current = pointer;
    setArmedOrderLineId(drawing.id);
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const armTrendEndpointMove = (drawing: TrendDrawing, end: "start" | "end") => {
    armedTrendEndpointBeforeRef.current = cloneDrawing(drawing) as TrendDrawing;
    setArmedTrendEndpoint({ drawingId: drawing.id, end });
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const cancelTrendEndpointMove = () => {
    const before = armedTrendEndpointBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedTrendEndpointBeforeRef.current = null;
    setArmedTrendEndpoint(null);
  };

  const armBoxHandleMove = (drawing: BoxDrawing, mode: BoxHandleMode) => {
    armedBoxHandleBeforeRef.current = cloneDrawing(drawing) as BoxDrawing;
    setArmedBoxHandle({ drawingId: drawing.id, mode });
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const cancelBoxHandleMove = () => {
    const before = armedBoxHandleBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedBoxHandleBeforeRef.current = null;
    setArmedBoxHandle(null);
  };

  const cancelOrderLineMove = () => {
    const before = armedOrderLineBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
      publishFullTakeProfitPreview(before, null);
    }

    armedOrderLineBeforeRef.current = null;
    armedOrderLinePointerRef.current = null;
    setArmedOrderLineId(null);
  };

  const submitOrderLineMove = (before: HorizontalDrawing, nextPrice: number) => {
    if (
      before.orderSide === undefined ||
      before.orderId === undefined ||
      before.orderSymbol === undefined ||
      before.orderQuantity === undefined
    ) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
      return;
    }

    if (nextPrice === before.price) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, {
        ...before,
        orderPricePending: false,
      });
      publishFullTakeProfitPreview(before, null);
      return;
    }

    const sideLabel = before.orderSide === "BUY" ? "Long" : "Short";
    const isReduceOrder =
      before.orderIntent === "REDUCE" ||
      before.clientOrderId?.startsWith("fe-red-") === true;
    const isFullTakeProfit = isFullTakeProfitDrawing(before);
    const orderLabel = isFullTakeProfit
      ? "Full TP"
      : isReduceOrder
        ? "Take profit"
        : before.orderIntent === "ADD"
          ? `${sideLabel} add`
          : `${sideLabel} limit`;

    if (isReduceOrder) {
      const marketPrice = refs.liveMarketPriceRef.current ?? marketData.lastPrice;

      if (marketPrice != null) {
        const invalidDirection =
          (before.orderSide === "SELL" && nextPrice <= marketPrice) ||
          (before.orderSide === "BUY" && nextPrice >= marketPrice);

        if (invalidDirection) {
          drawingsApi.replaceDrawingWithoutHistory(before.id, before);

          tradeMenuApi.setTradeToast({
            kind: "error",
            message:
              before.orderSide === "SELL"
                ? "Take profit must stay above the current price"
                : "Take profit must stay below the current price",
          });

          return;
        }
      }
    }

    const moved: HorizontalDrawing = {
      ...before,
      price: nextPrice,
      orderPricePending: true,
    };

    drawingsApi.replaceDrawingWithoutHistory(moved.id, moved);

    tradeMenuApi.setTradeToast({
      kind: "success",
      message: `Updating ${orderLabel.toLowerCase()}…`,
    });

    const request = isReduceOrder
      ? repriceReduceOrder(before.orderSymbol!, before.orderId!, {
          price: nextPrice,
          client_order_id: before.clientOrderId,
          reduce_pct: before.orderReducePct,
        })
      : modifyLimitOrder(before.orderSymbol!, before.orderId!, {
          side: before.orderSide!,
          quantity: before.orderQuantity!,
          price: nextPrice,
          time_in_force: before.timeInForce ?? "GTC",
        });

    void request
      .then((result) => {
        const confirmed: HorizontalDrawing = {
          ...moved,
          price: result.submitted_price,
          orderId:
            typeof result.order?.orderId === "string"
              ? result.order.orderId
              : moved.orderId,
          clientOrderId:
            result.order?.clientOrderId ?? moved.clientOrderId,
          orderQuantity: result.submitted_quantity,
          orderPricePending: true,
        };

        drawingsApi.replaceDrawingWithoutHistory(confirmed.id, confirmed);
        drawingsApi.pushHistory({
          type: "update",
          before,
          after: cloneDrawing(confirmed),
        });

        tradeMenuApi.setTradeToast({
          kind: "success",
          message: `${orderLabel} moved to ${confirmed.price.toFixed(marketData.pricePrecision)}`,
        });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to modify limit order";
        const staleOrder = isStaleOrderError(message);
        /*
         * Binance's own matching engine rejects a reduce-only order that
         * sits on the far side of other pending same-side orders it
         * would have to pass through first (see the -2022 code) -
         * because if those other orders filled first, the position
         * could already be flat/flipped by the time this one's price is
         * reached, which a reduce-only order can never be allowed to do.
         * This is a genuine exchange-side constraint, not a bug in
         * either this app's frontend or backend - translating the raw
         * code into what it actually means is just kinder than showing
         * "-2022: ReduceOnly Order is rejected." verbatim.
         */
        const reduceOnlyBlocked =
          message.includes("-2022") ||
          message.toLowerCase().includes("reduceonly order is rejected");

        drawingsApi.replaceDrawingWithoutHistory(before.id, {
          ...before,
          orderPricePending: false,
        });
        publishFullTakeProfitPreview(before, null);
        window.dispatchEvent(new Event("orders-state-changed"));

        tradeMenuApi.setTradeToast({
          kind: "error",
          message: staleOrder
            ? "The live take-profit order could not be resolved. Open Orders was refreshed."
            : reduceOnlyBlocked
              ? "Can't rest this order there - other pending orders on the same side would need to fill first, which could exceed your position size before this price is reached. Move it closer, or cancel/reduce those orders."
              : message,
        });
      });
  };

  useEffect(() => {
    if (!armedOrderLineId) return;

    const updateOrderLineFromPointer = (event: PointerEvent): number | null => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return null;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return null;

      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedOrderLineId,
      );

      if (!current || current.type !== "horizontal") return null;

      let nextPrice = chartPoint.price;

      const isReduceOrder =
        current.orderIntent === "REDUCE" ||
        current.clientOrderId?.startsWith("fe-red-") === true;

      if (isReduceOrder && current.orderSide) {
        const marketPrice =
          refs.liveMarketPriceRef.current ?? marketData.lastPrice;

        if (marketPrice != null) {
          const epsilon = 0.1;
          nextPrice =
            current.orderSide === "SELL"
              ? Math.max(nextPrice, marketPrice + epsilon)
              : Math.min(nextPrice, marketPrice - epsilon);
        }
      }

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        price: nextPrice,
        orderPricePending: true,
      });
      publishFullTakeProfitPreview(current, nextPrice);
      return nextPrice;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const armedPointer = armedOrderLinePointerRef.current;

      if (armedPointer?.pointerType === "touch") {
        if (event.pointerId !== armedPointer.pointerId) return;

        /*
         * FIX (mobile TP line drag also panned the chart): consume the
         * active finger's move in capture phase so the chart never sees
         * a pan gesture while the order line is being repositioned.
         */
        event.preventDefault();
        event.stopPropagation();
      }

      updateOrderLineFromPointer(event);
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Touch uses drag-and-release below instead of desktop's second click.
      if (armedOrderLinePointerRef.current?.pointerType === "touch") return;

      const before = armedOrderLineBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedOrderLineId,
      );

      armedOrderLineBeforeRef.current = null;
      armedOrderLinePointerRef.current = null;
      setArmedOrderLineId(null);

      if (!before || !current || current.type !== "horizontal") return;

      submitOrderLineMove(before, current.price);
    };

    const handleTouchRelease = (event: PointerEvent) => {
      const armedPointer = armedOrderLinePointerRef.current;
      if (
        armedPointer?.pointerType !== "touch" ||
        event.pointerId !== armedPointer.pointerId
      ) return;

      /*
       * FIX (mobile TP line confirmation): release of the same finger
       * commits the final price, matching native drag behavior and
       * removing the desktop-only requirement for a second tap.
       */
      event.preventDefault();
      event.stopPropagation();

      const before = armedOrderLineBeforeRef.current;
      const nextPrice = updateOrderLineFromPointer(event);
      armedOrderLineBeforeRef.current = null;
      armedOrderLinePointerRef.current = null;
      setArmedOrderLineId(null);

      if (before && nextPrice != null) {
        submitOrderLineMove(before, nextPrice);
      }
    };

    const handleTouchCancel = (event: PointerEvent) => {
      const armedPointer = armedOrderLinePointerRef.current;
      if (
        armedPointer?.pointerType !== "touch" ||
        event.pointerId !== armedPointer.pointerId
      ) return;
      event.preventDefault();
      event.stopPropagation();
      cancelOrderLineMove();
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelOrderLineMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelOrderLineMove();
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
  }, [armedOrderLineId]);

  useEffect(() => {
    if (!armedTrendEndpoint) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return;

      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedTrendEndpoint.drawingId,
      );

      if (!current || current.type !== "trend") return;

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        [armedTrendEndpoint.end]: { ...chartPoint },
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const before = armedTrendEndpointBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedTrendEndpoint.drawingId,
      );

      armedTrendEndpointBeforeRef.current = null;
      setArmedTrendEndpoint(null);

      if (!before || !current || current.type !== "trend") return;

      drawingsApi.pushHistory({
        type: "update",
        before: cloneDrawing(before),
        after: cloneDrawing(current),
      });
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelTrendEndpointMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelTrendEndpointMove();
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
  }, [armedTrendEndpoint]);

  useEffect(() => {
    if (!armedBoxHandle) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return;

      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedBoxHandle.drawingId,
      );

      if (!current || current.type !== "box") return;

      const next = computeBoxResize(current, armedBoxHandle.mode, chartPoint);

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        start: next.start,
        end: next.end,
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const before = armedBoxHandleBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedBoxHandle.drawingId,
      );

      armedBoxHandleBeforeRef.current = null;
      setArmedBoxHandle(null);

      if (!before || !current || current.type !== "box") return;

      drawingsApi.pushHistory({
        type: "update",
        before: cloneDrawing(before),
        after: cloneDrawing(current),
      });
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelBoxHandleMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelBoxHandleMove();
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
  }, [armedBoxHandle]);

  const handlePointerDownCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;

    /*
     * FIX: this handler runs in the CAPTURE phase on the whole chart-wrap
     * div, which means it fires before a real DOM button layered on top
     * of the chart (the toolbar-reveal button, the candle-countdown
     * badge) ever gets its own click event. Every branch below does pure
     * screen-coordinate hit-testing against drawings with no regard for
     * what's actually under the cursor, so a box/trend drawing sitting
     * at the same coordinates as one of those buttons would get
     * selected here AND (since most branches call stopPropagation) the
     * button's own click would never fire at all - it looked like the
     * button "wasn't clickable" whenever a drawing happened to be behind
     * it. Bailing out immediately for any real button element sidesteps
     * that: the click just proceeds normally to whatever button it
     * actually landed on, and none of the chart's own hit-testing runs.
     */
    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, .chart-text-editor")) {
      return;
    }

    if (armedOrderLineId) return;
    if (armedTrendEndpoint) return;
    if (armedBoxHandle) return;

    const local = getLocalPointer(event);

    if (!local) return;

    /*
     * FIX: a box/trend drawing's own rectangle can visually extend past
     * the plot area into the price-scale gutter on the right (or the
     * time-scale gutter at the bottom) - lightweight-charts reserves
     * that space for its own axis labels, but nothing here was ever
     * checking whether a click actually landed inside the real plot
     * area before hit-testing it against drawings. So clicking directly
     * on a price label that happened to have a drawing rendered behind
     * it moved/selected that drawing instead of doing nothing - same
     * bug shape as the button-click guard above, just for the chart's
     * own axis gutters instead of a DOM button. handleChartDoubleClick
     * below already has this exact same bounds check; this just applies
     * it here too.
     */
    const chart = refs.chartRef.current;

    if (chart) {
      const paneSize = chart.paneSize();

      if (
        local.x < 0 ||
        local.y < 0 ||
        local.x > paneSize.width ||
        local.y > paneSize.height
      ) {
        return;
      }
    }

    drawingsApi.setContextMenu(null);

    if (isHotkeysOpen) {
      setIsHotkeysOpen(false);
      return;
    }

    const chartPoint = coord.screenToChartPoint(local.x, local.y);

    if (!chartPoint) return;

    if (refs.toolRef.current === "ruler") {
      event.preventDefault();
      event.stopPropagation();

      // The ruler uses a click -> move -> click interaction. The first
      // click fixes the starting price/time and pointer movement previews the
      // measurement. The second click finishes the one-shot measurement and
      // immediately returns the chart to the default cursor/select tool.
      if (refs.rulerStartRef.current) {
        drawingsApi.setTool("cursor");
      } else {
        refs.rulerStartRef.current = { ...chartPoint };
        refs.rulerEndRef.current = { ...chartPoint };
      }

      return;
    }

    if (refs.toolRef.current === "pen") {
      event.preventDefault();
      event.stopPropagation();

      // See xToTime's comment on `continuous` - a pen stroke needs the
      // mouse's real sub-bar position, not "whichever candle is under the
      // cursor", or it starts choppy from its very first point.
      const startPoint =
        coord.screenToChartPoint(local.x, local.y, true) ?? chartPoint;

      const pen: PenDrawing = {
        id: crypto.randomUUID(),
        type: "pen",
        points: [{ ...startPoint }],
        color: DEFAULT_LINE_COLOR,
        // Pen drawings are added directly (not through drawingsApi.addDrawing,
        // which stamps this for every other drawing type) since the draft
        // needs to exist in refs.drawingsRef immediately, while still being
        // built up point-by-point, before it's ever pushed to history - so
        // it's stamped here instead.
        timeframe: refs.intervalRef.current,
      };

      refs.penDraftRef.current = pen;
      drawingsApi.syncDrawings([...refs.drawingsRef.current, pen]);
      drawingsApi.setSelectedId(pen.id);

      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (refs.toolRef.current === "text") {
      event.preventDefault();
      event.stopPropagation();

      // A single click only gives us one point (`chartPoint`, the
      // top-left corner). The opposite corner needs a REAL chart anchor
      // too now (see TextDrawing in types/drawing.ts), so pick a sane
      // default on-screen size, clamp it to stay inside the pane, and
      // convert THAT pixel position into a chart point via
      // screenToChartPoint - same idea as how the trend/box tools resolve
      // their second point, just derived instead of clicked.
      const paneSize = refs.chartRef.current?.paneSize();
      const defaultBoxWidth = 140;
      const defaultBoxHeight = 42;
      const endLocalX = paneSize
        ? Math.min(local.x + defaultBoxWidth, paneSize.width - 4)
        : local.x + defaultBoxWidth;
      const endLocalY = paneSize
        ? Math.min(local.y + defaultBoxHeight, paneSize.height - 4)
        : local.y + defaultBoxHeight;

      // Falls back to `chartPoint` (a zero-size box, later floored by
      // getTextRect's MIN_BOX_SIZE) only in the unlikely case the pane
      // can't resolve that pixel to a chart point at all.
      const endPoint = coord.screenToChartPoint(endLocalX, endLocalY) ?? chartPoint;

      const textDrawing: TextDrawing = {
        id: crypto.randomUUID(),
        type: "text",
        start: { ...chartPoint },
        end: { ...endPoint },
        text: "text here...",
        color: DEFAULT_LINE_COLOR,
      };
      drawingsApi.addDrawing(textDrawing);
      drawingsApi.setTool("cursor");
      beginTextEditing({ ...textDrawing, timeframe: refs.intervalRef.current });
      return;
    }

    if (refs.toolRef.current === "vertical") {
      event.preventDefault();
      event.stopPropagation();

      drawingsApi.addDrawing({
        id: crypto.randomUUID(),
        type: "vertical",
        time: chartPoint.time,
        color: DEFAULT_LINE_COLOR,
      });

      drawingsApi.setTool("cursor");
      return;
    }

    if (refs.toolRef.current === "horizontal") {
      event.preventDefault();
      event.stopPropagation();

      drawingsApi.addDrawing({
        id: crypto.randomUUID(),
        type: "horizontal",
        price: chartPoint.price,
        color: DEFAULT_LINE_COLOR,
      });

      drawingsApi.setTool("cursor");
      return;
    }

    if (refs.toolRef.current === "trend" || refs.toolRef.current === "box") {
      event.preventDefault();
      event.stopPropagation();

      if (!refs.pendingStartRef.current) {
        refs.pendingStartRef.current = chartPoint;
        refs.previewPointRef.current = chartPoint;
        return;
      }

      if (refs.toolRef.current === "trend") {
        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "trend",
          start: {
            ...refs.pendingStartRef.current,
          },
          end: chartPoint,
          color: DEFAULT_LINE_COLOR,
        });
      } else {
        drawingsApi.addDrawing({
          id: crypto.randomUUID(),
          type: "box",
          start: {
            ...refs.pendingStartRef.current,
          },
          end: chartPoint,
          color: DEFAULT_BOX_COLOR,
        });
      }

      refs.pendingStartRef.current = null;
      refs.previewPointRef.current = null;

      drawingsApi.setTool("cursor");
      return;
    }

    const chaseHit = findPendingOrderChaseHit(local.x, local.y);

    if (chaseHit) {
      event.preventDefault();
      event.stopPropagation();
      setCancelTooltip(null);
      setChaseTooltip(null);

      const drawing = chaseHit.drawing;

      if (
        drawing.orderId === undefined ||
        !drawing.orderSymbol ||
        !drawing.orderSide
      ) {
        tradeMenuApi.setTradeToast({
          kind: "error",
          message: "This order line has incomplete Binance metadata.",
        });
        return;
      }

      drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
        ...drawing,
        orderChasing: true,
      });

      tradeMenuApi.setTradeToast({
        kind: "success",
        message: `Chasing ${drawing.orderSide === "BUY" ? "long" : "short"} limit to market…`,
      });

      void chaseLimitOrder(drawing.orderSymbol, drawing.orderId)
        .then((result) => {
          drawingsApi.deleteDrawing(drawing.id);
          tradeMenuApi.addMarketFillMarker(
            result.side,
            result.market_order,
            drawing.price,
          );
          window.dispatchEvent(new Event("trading-state-changed"));

          tradeMenuApi.setTradeToast({
            kind: "success",
            message: `${result.side === "BUY" ? "Long" : "Short"} limit chased to market`,
          });
        })
        .catch((error: unknown) => {
          drawingsApi.replaceDrawingWithoutHistory(drawing.id, {
            ...drawing,
            orderChasing: false,
          });

          tradeMenuApi.setTradeToast({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to chase limit order",
          });
        });

      return;
    }

    const cancelHit = findPendingOrderCancelHit(local.x, local.y);

    if (cancelHit) {
      event.preventDefault();
      event.stopPropagation();
      setCancelTooltip(null);

      const drawing = cancelHit.drawing;

      if (drawing.orderId === undefined || !drawing.orderSymbol) {
        tradeMenuApi.setTradeToast({
          kind: "error",
          message:
            "This order line has no Binance order ID. Recreate the order.",
        });
        return;
      }

      const label = drawing.orderSide === "BUY" ? "Long" : "Short";

      tradeMenuApi.setTradeToast({
        kind: "success",
        message: `Cancelling ${label.toLowerCase()} limit order…`,
      });

      void cancelOrder(drawing.orderSymbol, drawing.orderId)
        .then(() => {
          drawingsApi.deleteDrawing(drawing.id);

          tradeMenuApi.setTradeToast({
            kind: "success",
            message: `${label} limit order cancelled`,
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to cancel limit order";
          /*
           * FIX: this order can genuinely no longer exist on Binance by
           * the time Cancel is clicked (already filled, or already
           * replaced by a reprice/reduce-edit elsewhere) - same "-2013"/
           * "not found" family of stale-order responses already handled
           * in the reprice-reduce catch above, plus "-2011 Unknown order
           * sent" (Binance's other way of saying it doesn't recognize
           * this order id at all). Previously this always showed the raw
           * Binance text and left the now-stale drawing sitting on the
           * chart looking clickable - deleting it here and refreshing
           * Open Orders means the chart stops showing a "ghost" cancel
           * button for an order that's already gone, instead of only
           * fixing itself whenever the next unrelated refresh happens to
           * catch up.
           */
          const staleOrder = isStaleOrderError(message);

          if (staleOrder) {
            drawingsApi.deleteDrawing(drawing.id);
            window.dispatchEvent(new Event("orders-state-changed"));
          }

          tradeMenuApi.setTradeToast({
            kind: "error",
            message: staleOrder
              ? "This order no longer exists. Open Orders was refreshed."
              : message,
          });
        });

      return;
    }

    /*
     * FIX (mobile order gesture reliability): prefer the fingertip-sized
     * TP hit area before generic 8px drawing hit-testing. Once matched,
     * this pointerdown is prevented below, so lightweight-charts cannot
     * interpret a small sideways movement as a pane pan into empty data.
     */
    const hit =
      (event.pointerType === "touch"
        ? findTouchOrderMoveHit(local.x, local.y)
        : null) ?? coord.findDrawingAt(local.x, local.y);

    if (!hit) {
      drawingsApi.setSelectedId(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (hit.type === "horizontal" && hit.orderSide !== undefined) {
      armOrderLineMove(hit, {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      });
      return;
    }

    drawingsApi.setSelectedId(hit.id);

    let dragMode:
      | "move"
      | "trend-start"
      | "trend-end"
      | "box-top-left"
      | "box-top-right"
      | "box-bottom-left"
      | "box-bottom-right"
      | "box-top"
      | "box-right"
      | "box-bottom"
      | "box-left"
      | "text-top-left"
      | "text-top"
      | "text-top-right"
      | "text-right"
      | "text-bottom-right"
      | "text-bottom"
      | "text-bottom-left"
      | "text-left" = "move";

    if (hit.type === "trend") {
      const startScreen = coord.chartPointToScreen(hit.start);
      const endScreen = coord.chartPointToScreen(hit.end);
      const handleThreshold = 12;

      if (
        startScreen &&
        Math.hypot(local.x - startScreen.x, local.y - startScreen.y) <=
          handleThreshold
      ) {
        dragMode = "trend-start";
      } else if (
        endScreen &&
        Math.hypot(local.x - endScreen.x, local.y - endScreen.y) <=
          handleThreshold
      ) {
        dragMode = "trend-end";
      }

      // FIX: endpoint edits (grabbing the start/end handle specifically,
      // not the line itself) now use the same click-move-click flow as
      // order lines instead of a press-and-hold drag - click the handle
      // once to pick it up, move the mouse freely to reposition it, click
      // again anywhere to drop it. Whole-line moves (dragMode stays
      // "move" - grabbing the line body, not a handle) are untouched and
      // still use the ordinary drag path below.
      if (dragMode === "trend-start" || dragMode === "trend-end") {
        armTrendEndpointMove(hit, dragMode === "trend-start" ? "start" : "end");
        return;
      }
    }

    if (hit.type === "box") {
      const startScreen = coord.chartPointToScreen(hit.start);
      const endScreen = coord.chartPointToScreen(hit.end);
      const handleThreshold = 12;

      if (startScreen && endScreen) {
        const left = Math.min(startScreen.x, endScreen.x);
        const right = Math.max(startScreen.x, endScreen.x);
        const top = Math.min(startScreen.y, endScreen.y);
        const bottom = Math.max(startScreen.y, endScreen.y);

        // Corners resize both dimensions (pivoting on the opposite
        // corner); edge midpoints resize only ONE dimension, keeping
        // the other two sides fixed - same split as Text's 8 handles
        // below. Corners are listed first so a click near an actual
        // corner always wins over the edge midpoint sitting right next
        // to it, rather than whichever happens to be first in the array.
        const handles: Array<{
          mode: BoxHandleMode;
          x: number;
          y: number;
        }> = [
          { mode: "box-top-left", x: left, y: top },
          { mode: "box-top-right", x: right, y: top },
          { mode: "box-bottom-left", x: left, y: bottom },
          { mode: "box-bottom-right", x: right, y: bottom },
          { mode: "box-top", x: (left + right) / 2, y: top },
          { mode: "box-right", x: right, y: (top + bottom) / 2 },
          { mode: "box-bottom", x: (left + right) / 2, y: bottom },
          { mode: "box-left", x: left, y: (top + bottom) / 2 },
        ];

        const handle = handles.find(
          (item) =>
            Math.hypot(local.x - item.x, local.y - item.y) <= handleThreshold,
        );

        // Same click-move-click flow as the trend-endpoint block above,
        // now covering all 8 box handles (this used to fall through to
        // dragMode + the ordinary press-and-hold drag path below, which
        // is also where the edge handles' "grabbing an edge doesn't
        // resize" bug lived before that was fixed separately - this is
        // the follow-up: stop holding the mouse down at all). A plain
        // whole-box move (grabbing the box body, not a handle) is
        // untouched and still uses the ordinary drag path below.
        if (handle) {
          armBoxHandleMove(hit, handle.mode);
          return;
        }
      }
    }

    if (hit.type === "text") {
      const rect = getTextRect(hit);
      const handleThreshold = 12;
      if (rect) {
        const handles: Array<{ mode: DragState["mode"]; x: number; y: number }> = [
          { mode: "text-top-left", x: rect.left, y: rect.top },
          { mode: "text-top", x: rect.left + rect.width / 2, y: rect.top },
          { mode: "text-top-right", x: rect.left + rect.width, y: rect.top },
          { mode: "text-right", x: rect.left + rect.width, y: rect.top + rect.height / 2 },
          { mode: "text-bottom-right", x: rect.left + rect.width, y: rect.top + rect.height },
          { mode: "text-bottom", x: rect.left + rect.width / 2, y: rect.top + rect.height },
          { mode: "text-bottom-left", x: rect.left, y: rect.top + rect.height },
          { mode: "text-left", x: rect.left, y: rect.top + rect.height / 2 },
        ];
        const handle = handles.find((item) => Math.hypot(local.x - item.x, local.y - item.y) <= handleThreshold);
        if (handle) dragMode = handle.mode;
      }
    }

    refs.dragRef.current = {
      drawingId: hit.id,
      before: cloneDrawing(hit),
      pointerStart: chartPoint,
      mode: dragMode,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMoveCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const local = getLocalPointer(event);

    if (!local) return;

    if (
      refs.toolRef.current === "cursor" &&
      !refs.dragRef.current &&
      !refs.penDraftRef.current &&
      !armedOrderLineId
    ) {
      const chaseHit = findPendingOrderChaseHit(local.x, local.y);
      const cancelHit = findPendingOrderCancelHit(local.x, local.y);

      if (chaseHit?.rects.chase) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setCancelTooltip(null);
        setChaseTooltip({
          x: chaseHit.rects.chase.x + chaseHit.rects.chase.width / 2,
          y: chaseHit.rects.chase.y,
        });
        clearHoveredDrawingInfo();
      } else if (cancelHit) {
        setIsHoveringDrawing(true);
        setIsHoveringHorizontalDrawing(false);
        setChaseTooltip(null);
        setCancelTooltip({
          x: cancelHit.rects.cancel.x + cancelHit.rects.cancel.width / 2,
          y: cancelHit.rects.cancel.y,
        });
        clearHoveredDrawingInfo();
      } else {
        setCancelTooltip(null);
        setChaseTooltip(null);

        const hit = coord.findDrawingAt(local.x, local.y);
        setIsHoveringDrawing(hit !== null);
        setIsHoveringHorizontalDrawing(hit !== null && hit.type === "horizontal");

        if (hit && !isOrderDrawing(hit)) {
          if (hoverInfoDrawingIdRef.current !== hit.id) {
            // Just landed on a different drawing (or the first one) -
            // restart the delay from zero rather than showing instantly.
            hoverInfoDrawingIdRef.current = hit.id;
            clearHoverInfoTimer();
            setHoveredDrawingInfo(null);

            const pointAtScheduleTime = { x: local.x, y: local.y };

            hoverInfoTimerRef.current = window.setTimeout(() => {
              hoverInfoTimerRef.current = null;

              // Still hovering the very same drawing once the delay
              // elapses? Only then does the popup actually appear.
              if (hoverInfoDrawingIdRef.current === hit.id) {
                setHoveredDrawingInfo({
                  drawing: hit,
                  point: pointAtScheduleTime,
                });
              }
            }, HOVER_INFO_DELAY_MS);
          } else {
            // Same drawing as last frame - if the popup's already showing,
            // keep it tracking the mouse instead of staying pinned to
            // wherever the hover first started.
            setHoveredDrawingInfo((previous) =>
              previous ? { drawing: hit, point: { x: local.x, y: local.y } } : previous,
            );
          }
        } else {
          clearHoveredDrawingInfo();
        }
      }
    } else {
      setIsHoveringDrawing(false);
      setIsHoveringHorizontalDrawing(false);
      setCancelTooltip(null);
      setChaseTooltip(null);
      clearHoveredDrawingInfo();
    }

    const chartPoint = coord.screenToChartPoint(local.x, local.y);

    if (!chartPoint) return;

    if (refs.rulerStartRef.current) {
      event.preventDefault();
      event.stopPropagation();
      refs.rulerEndRef.current = { ...chartPoint };
      return;
    }

    const penDraft = refs.penDraftRef.current;

    if (penDraft) {
      event.preventDefault();
      event.stopPropagation();

      // Same reasoning as the pen's first point above - without
      // `continuous: true` here, every mouse-move sample inside the same
      // candle's pixel width would keep landing on that candle's one
      // shared time, so the stroke reduces to a vertical jog per candle
      // instead of tracking the mouse's actual path.
      const continuousChartPoint =
        coord.screenToChartPoint(local.x, local.y, true) ?? chartPoint;

      const previousPoint = penDraft.points[penDraft.points.length - 1];
      const previousScreen = coord.chartPointToScreen(previousPoint, false);
      const currentScreen = coord.chartPointToScreen(
        continuousChartPoint,
        false,
      );

      if (
        !previousScreen ||
        !currentScreen ||
        Math.hypot(
          currentScreen.x - previousScreen.x,
          currentScreen.y - previousScreen.y,
        ) >= 2
      ) {
        const updatedPen: PenDrawing = {
          ...penDraft,
          points: [...penDraft.points, { ...continuousChartPoint }],
        };

        refs.penDraftRef.current = updatedPen;
        drawingsApi.replaceDrawingWithoutHistory(updatedPen.id, updatedPen);
      }

      return;
    }

    if (
      (refs.toolRef.current === "trend" || refs.toolRef.current === "box") &&
      refs.pendingStartRef.current
    ) {
      refs.previewPointRef.current = chartPoint;
    }

    const drag = refs.dragRef.current;

    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();

    const original = drag.before;

    if (original.type === "trend" && drag.mode === "trend-start") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        start: { ...chartPoint },
      });

      return;
    }

    if (original.type === "trend" && drag.mode === "trend-end") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        end: { ...chartPoint },
      });

      return;
    }

    if (original.type === "text" && drag.mode.startsWith("text-")) {
      const originalRect = getTextRect(original);
      if (!originalRect) return;

      const minSize = 18;
      let left = originalRect.left;
      let right = originalRect.left + originalRect.width;
      let top = originalRect.top;
      let bottom = originalRect.top + originalRect.height;

      if (drag.mode.includes("left")) left = Math.min(local.x, right - minSize);
      if (drag.mode.includes("right")) right = Math.max(local.x, left + minSize);
      if (drag.mode.includes("top")) top = Math.min(local.y, bottom - minSize);
      if (drag.mode.includes("bottom")) bottom = Math.max(local.y, top + minSize);

      // Both corners are now real chart anchors (see TextDrawing in
      // types/drawing.ts), so - unlike the old single-anchor + pixel-box
      // model - resizing has to resolve BOTH the new top-left and the new
      // bottom-right through screenToChartPoint, not just one.
      const nextStart = coord.screenToChartPoint(left, top);
      const nextEnd = coord.screenToChartPoint(right, bottom);
      if (!nextStart || !nextEnd) return;

      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        start: nextStart,
        end: nextEnd,
      });
      return;
    }

    // Box's 8 resize handles (corners + edges) no longer reach here at
    // all - grabbing one now arms the click-move-click flow instead (see
    // armBoxHandleMove and the armedBoxHandle effect above, plus
    // computeBoxResize for the actual corner/edge math). Only a plain
    // whole-box move (grabbing the box body, not a handle) still falls
    // through to the generic start/end delta case further below.

    const timeDelta = Number(chartPoint.time) - Number(drag.pointerStart.time);
    const priceDelta = chartPoint.price - drag.pointerStart.price;

    if (original.type === "vertical") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        time: Math.round(Number(original.time) + timeDelta) as UTCTimestamp,
      });

      return;
    }

    if (original.type === "horizontal") {
      const moved = {
        ...original,
        price: original.price + priceDelta,
        ...(original.orderId !== undefined
          ? { orderPricePending: true }
          : {}),
      } as HorizontalDrawing;

      drawingsApi.replaceDrawingWithoutHistory(original.id, moved);
      publishFullTakeProfitPreview(moved, moved.price);

      return;
    }

    if (original.type === "coordinate-marker") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        time: Math.round(Number(original.time) + timeDelta) as UTCTimestamp,
        price: original.price + priceDelta,
      });

      return;
    }

    if (original.type === "pen") {
      drawingsApi.replaceDrawingWithoutHistory(original.id, {
        ...original,
        points: original.points.map((point) => ({
          time: Math.round(Number(point.time) + timeDelta) as UTCTimestamp,
          price: point.price + priceDelta,
        })),
      });

      return;
    }

    // Text falls through to here now too (no dedicated branch needed):
    // it has real start/end chart anchors exactly like Trend/Box, so
    // moving it means shifting both anchors by the same time/price delta,
    // same as this block already does for those two.
    drawingsApi.replaceDrawingWithoutHistory(original.id, {
      ...original,
      start: {
        time: Math.round(
          Number(original.start.time) + timeDelta,
        ) as UTCTimestamp,
        price: original.start.price + priceDelta,
      },
      end: {
        time: Math.round(Number(original.end.time) + timeDelta) as UTCTimestamp,
        price: original.end.price + priceDelta,
      },
    });
  };

  const handlePointerUpCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (refs.toolRef.current === "ruler") {
      // Do not finish the measurement on mouse-up. It remains visible while
      // the pointer moves and is removed only by the ruler's second click.
      event.preventDefault();
      event.stopPropagation();

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      return;
    }

    const penDraft = refs.penDraftRef.current;

    if (penDraft) {
      event.preventDefault();
      event.stopPropagation();

      refs.penDraftRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const completed = refs.drawingsRef.current.find(
        (drawing) => drawing.id === penDraft.id,
      );

      if (!completed || completed.type !== "pen") return;

      if (completed.points.length < 2) {
        drawingsApi.syncDrawings(
          refs.drawingsRef.current.filter(
            (drawing) => drawing.id !== completed.id,
          ),
        );
        drawingsApi.setSelectedId(null);
        return;
      }

      drawingsApi.pushHistory({
        type: "add",
        drawing: cloneDrawing(completed),
      });

      return;
    }

    const drag = refs.dragRef.current;

    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();

    const after = refs.drawingsRef.current.find(
      (drawing) => drawing.id === drag.drawingId,
    );

    refs.dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!after) return;

    const isPendingLimitMove =
      drag.before.type === "horizontal" &&
      after.type === "horizontal" &&
      drag.before.orderSide !== undefined &&
      drag.before.orderId !== undefined &&
      drag.before.orderSymbol !== undefined &&
      drag.before.orderQuantity !== undefined &&
      after.price !== drag.before.price;

    if (!isPendingLimitMove) {
      const settledAfter =
        after.type === "horizontal" && after.orderPricePending
          ? { ...after, orderPricePending: false }
          : after;

      if (settledAfter !== after) {
        drawingsApi.replaceDrawingWithoutHistory(settledAfter.id, settledAfter);
      }

      const changed = JSON.stringify(drag.before) !== JSON.stringify(settledAfter);
      if (changed) {
        drawingsApi.pushHistory({
          type: "update",
          before: cloneDrawing(drag.before),
          after: cloneDrawing(settledAfter),
        });
      } else if (settledAfter.type === "text") {
        beginTextEditing(settledAfter);
      }
      return;
    }

    submitOrderLineMove(
      cloneDrawing(drag.before) as HorizontalDrawing,
      (after as HorizontalDrawing).price,
    );
  };

  const handleContextMenuCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;

    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const hit = coord.findDrawingAt(x, y);

    event.preventDefault();
    event.stopPropagation();

    drawingsApi.setSelectedId(hit?.id ?? null);

    // Used by "Create alert" in the chart menu and in the context menus
    // for trend/vertical lines. Horizontal lines use their exact stored
    // price instead (see ContextMenu.tsx).
    const point = coord.screenToChartPoint(x, y);

    drawingsApi.setContextMenu({
      x: event.clientX,
      y: event.clientY,
      drawingId: hit?.id ?? null,
      price: point?.price ?? null,
      time: point?.time ?? null,
    } as ContextMenuState);
  };

  const openTradeMenuAt = (clientX: number, clientY: number): boolean => {
    if (refs.toolRef.current !== "cursor") return false;
    if (
      refs.dragRef.current ||
      refs.penDraftRef.current ||
      refs.pendingStartRef.current
    )
      return false;

    const wrap = refs.chartWrapRef.current;
    const chart = refs.chartRef.current;

    if (!wrap || !chart || marketData.isChartLoading) return false;

    const rect = wrap.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const paneSize = chart.paneSize();

    if (
      localX < 0 ||
      localY < 0 ||
      localX > paneSize.width ||
      localY > paneSize.height
    ) {
      return false;
    }

    if (coord.findDrawingAt(localX, localY)) return false;

    const point = coord.screenToChartPoint(localX, localY);
    const marketPrice =
      marketData.lastPrice ?? refs.lastCandleRef.current?.close ?? null;

    if (!point || marketPrice === null) return false;

    drawingsApi.setContextMenu(null);
    setIsHotkeysOpen(false);
    drawingsApi.setSelectedId(null);

    tradeMenuApi.openTradeMenu(clientX, clientY, point.price, marketPrice);
    return true;
  };

  const handleChartDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const wrap = refs.chartWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      const hit = coord.findDrawingAt(event.clientX - rect.left, event.clientY - rect.top);
      if (hit?.type === "text") {
        event.preventDefault();
        event.stopPropagation();
        beginTextEditing(hit);
        return;
      }
    }
    if (!openTradeMenuAt(event.clientX, event.clientY)) return;

    event.preventDefault();
    event.stopPropagation();
  };

  const handleChartDoubleTap = (clientX: number, clientY: number) => {
    openTradeMenuAt(clientX, clientY);
  };

  const handlePointerLeave = () => {
    if (!refs.rulerStartRef.current) {
      refs.rulerEndRef.current = null;
    }
    setIsHoveringDrawing(false);
    setIsHoveringHorizontalDrawing(false);
    setCancelTooltip(null);
    setChaseTooltip(null);
    clearHoveredDrawingInfo();
  };

  return {
    isHoveringDrawing,
    setIsHoveringDrawing,
    isHoveringHorizontalDrawing,
    cancelTooltip,
    chaseTooltip,
    hoveredDrawingInfo,
    editingText,
    setEditingTextValue: (value: string) =>
      setEditingText((current) => {
        if (!current) return current;
        const next = { ...current, value };
        editingTextRef.current = next;
        return next;
      }),
    commitTextEditing,
    cancelTextEditing,
    isPlacingOrderLine: armedOrderLineId !== null,
    handlePointerDownCapture,
    handlePointerMoveCapture,
    handlePointerUpCapture,
    handlePointerLeave,
    handleContextMenuCapture,
    handleChartDoubleClick,
    handleChartDoubleTap,
  };
}

export type DrawingCanvasApi = ReturnType<typeof useDrawingCanvas>;
