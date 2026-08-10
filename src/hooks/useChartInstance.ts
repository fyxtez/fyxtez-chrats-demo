import { useEffect } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  CrosshairMode,
  LineStyle,
  type Time,
} from "lightweight-charts";
import {
  localDateFormatter,
  localDateTimeFormatter,
  localTimeFormatter,
  timeToDate,
} from "../utils/time";
import type { ChartRefs } from "./useChartRefs";
import type { CoordinateMapping } from "./useCoordinateMapping";

/**
 * Creates the lightweight-charts instance, the candlestick + invisible
 * future-time series, wires up the crosshair price-line + resize
 * handling, and tears everything down on unmount. Runs once.
 *
 * NOTE: an experimental feature that clamped how far a user could
 * pan/zoom into the future (to avoid a blank price axis when zero real
 * candles are in view) was tried here across several iterations and
 * removed again. Every version introduced a different, worse regression
 * on some timeframe or interaction (frame-fighting jitter, instant
 * snapping mid-drag, and finally a corrupted price scale on higher
 * timeframes right after a timeframe switch) that couldn't be reliably
 * verified without running the app directly. Panning/zooming is fully
 * unrestricted again. The underlying "blank axis when the entire visible
 * window has zero real candles" cosmetic issue can still occur if you
 * deliberately scroll all the way into empty future space - if that
 * becomes a real problem again, it's worth revisiting with actual
 * in-app testing rather than another blind patch.
 */
export function useChartInstance(
  refs: ChartRefs,
  logicalToTime: CoordinateMapping["logicalToTime"],
) {
  useEffect(() => {
    if (!refs.containerRef.current) return;

    const chart = createChart(refs.containerRef.current, {
      layout: {
        background: {
          color: "#0b0e14",
        },

        textColor: "#aab2c5",
        attributionLogo: false,
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },

      localization: {
        locale: "en-GB",
        timeFormatter: (time: Time) =>
          localDateTimeFormatter.format(timeToDate(time)),
      },

      grid: {
        vertLines: {
          color: "#181d27",
        },

        horzLines: {
          color: "#181d27",
        },
      },

      width: refs.containerRef.current.clientWidth,
      height: refs.containerRef.current.clientHeight,

      crosshair: {
        mode: CrosshairMode.Normal,
      },

      rightPriceScale: {
        borderColor: "#232a37",

        // lightweight-charts reserves a margin band below the visible
        // price range purely for visual breathing room (10% of the pane
        // height by default) - and it generates axis tick labels INSIDE
        // that band by extrapolating price linearly below `from`, even
        // when `from` itself is pinned at exactly 0. That's what let
        // negative labels sneak back in on a big zoom-out despite the
        // range floor below: the range was correctly floored at 0, but
        // there was still a reserved strip below it for the axis to
        // extrapolate negative values into. Zeroing the bottom margin
        // removes that strip entirely, so there's nothing below 0 left
        // to draw a label for. (Top margin is untouched - headroom above
        // price is fine, it's only the floor at 0 that matters here.)
        scaleMargins: {
          top: 0.1,
          bottom: 0,
        },
      },

      // Dragging on the price axis is lightweight-charts' own built-in
      // way to rescale it, matching the "drag the axis to zoom" gesture
      // most charting platforms support. It was disabled here in an
      // earlier pass because, at the time, nothing caught this specific
      // interaction and it could pull the visible range into negative
      // price territory unchecked. That gap is now closed a different
      // way: the requestAnimationFrame floor set up below checks the
      // actual rendered range every frame regardless of what caused the
      // change, so it catches this drag the same as any other - dragging
      // down just stops right at 0 instead of the whole gesture being
      // switched off.
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
      },

      timeScale: {
        borderColor: "#232a37",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) =>
          // Weekly candles get the same date-only tick label as daily -
          // showing a time-of-day component on a bar that spans an
          // entire week is meaningless (it's always the same exchange
          // week-open timestamp).
          refs.intervalRef.current === "1d" || refs.intervalRef.current === "1w"
            ? localDateFormatter.format(timeToDate(time))
            : localTimeFormatter.format(timeToDate(time)),

        /*
         * Provides usable future space
         * after the latest candle.
         */
        rightOffset: 25,
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f04562",
      borderUpColor: "#34d399",
      borderDownColor: "#f04562",
      wickUpColor: "#34d399",
      wickDownColor: "#f04562",

      // Hide Lightweight Charts' built-in current-price label/line.
      // We render our own green live-price line and label instead.
      lastValueVisible: false,
      priceLineVisible: false,

      // BTC's default tick precision (2 decimals, e.g. "62582.20") wastes
      // horizontal space on the price scale and nobody reads the cents on
      // a five-figure price. Round the display to whole numbers - this
      // only affects the chart's own price scale / crosshair / price-line
      // labels; order submission still uses the real tick size from
      // exchangeInfo (see trading/api/exchangeInfo.ts), so nothing about
      // actual order precision changes.
      priceFormat: {
        type: "price",
        precision: 0,
        minMove: 1,
      },
    });

    const futureScale = chart.addSeries(LineSeries, {
      /*
       * This invisible overlay series extends the chart's real time
       * scale into the future. It has actual values so future labels
       * and vertical grid lines are generated consistently, while all
       * visible series elements remain disabled.
       */
      priceScaleId: "",
      visible: true,
      lineVisible: false,
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    futureScale.priceScale().applyOptions({
      autoScale: false,
      visible: false,
    });

    refs.chartRef.current = chart;
    refs.candleRef.current = candles;
    refs.futureScaleRef.current = futureScale;

    /*
     * Floor for the price axis at 0, enforced continuously.
     *
     * The chart's built-in axis-drag rescale (handleScale.
     * axisPressedMouseMove.price, above) and the built-in pane drag-pan
     * (handleScroll.pressedMouseMove, which moves price and time
     * together when you click-drag anywhere in the chart) both go
     * through lightweight-charts' own internal handling with no event
     * we can subscribe to and clamp directly. Rather than special-case
     * each interaction, this checks the actual rendered range every
     * frame and snaps it back the instant it dips negative - catching
     * both of those, the Ctrl+wheel handler below, and anything else
     * that might move the range in the future. The span is preserved
     * (the range is shifted up, not compressed) so this reads as "hit a
     * floor" rather than an unexpected rescale.
     */
    let clampFrame = 0;
    const clampPriceScaleFloor = () => {
      const series = refs.candleRef.current;

      if (series) {
        const priceScale = series.priceScale();
        const range = priceScale.getVisibleRange();

        if (range && range.from < 0) {
          const span = range.to - range.from;

          priceScale.applyOptions({ autoScale: false });
          priceScale.setVisibleRange({
            from: 0,
            to: span,
          });
        }
      }

      clampFrame = window.requestAnimationFrame(clampPriceScaleFloor);
    };

    clampFrame = window.requestAnimationFrame(clampPriceScaleFloor);

    chart.subscribeCrosshairMove((param) => {
      if (param.point && refs.candleRef.current) {
        const logical = chart.timeScale().coordinateToLogical(param.point.x);

        if (logical != null) {
          const time = logicalToTime(logical);

          if (time !== null) {
            refs.currentTimeRef.current = time;
          }
        }

        const price = refs.candleRef.current.coordinateToPrice(param.point.y);

        if (price == null) return;

        refs.currentPriceRef.current = price;

        if (refs.mousePriceLineRef.current) {
          refs.candleRef.current.removePriceLine(refs.mousePriceLineRef.current);
        }

        refs.mousePriceLineRef.current = refs.candleRef.current.createPriceLine({
          price,
          color: "#f04562",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "",
        });
      }
    });

    const resize = () => {
      if (!refs.containerRef.current) {
        return;
      }

      chart.applyOptions({
        width: refs.containerRef.current.clientWidth,
        height: refs.containerRef.current.clientHeight,
      });
    };

    window.addEventListener("resize", resize);

    /*
     * Ctrl + mouse wheel scales the vertical (price) axis from anywhere
     * inside the chart. A normal wheel keeps Lightweight Charts' native
     * horizontal/time-axis zoom behavior unchanged.
     *
     * The price currently under the mouse is used as the zoom anchor, so
     * the chart expands/contracts around the point the user is looking at
     * instead of always zooming around the middle of the pane.
     */
    const handlePriceScaleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;

      const container = refs.containerRef.current;
      const series = refs.candleRef.current;

      if (!container || !series) return;

      const priceScale = series.priceScale();
      const visibleRange = priceScale.getVisibleRange();

      if (!visibleRange) return;

      event.preventDefault();
      event.stopPropagation();

      const rect = container.getBoundingClientRect();
      const localY = Math.min(
        container.clientHeight,
        Math.max(0, event.clientY - rect.top),
      );
      const anchorPrice = series.coordinateToPrice(localY);

      const currentSpan = visibleRange.to - visibleRange.from;
      if (!(currentSpan > 0)) return;

      // Positive deltaY zooms out; negative deltaY zooms in. Clamp each
      // wheel step so trackpads and high-resolution wheels stay controlled.
      const zoomFactor = Math.exp(
        Math.max(-0.35, Math.min(0.35, event.deltaY * 0.0015)),
      );
      const nextSpan = currentSpan * zoomFactor;

      // Avoid collapsing the range to zero or exploding it accidentally.
      if (!Number.isFinite(nextSpan) || nextSpan <= 0) return;

      const anchor =
        anchorPrice != null && Number.isFinite(anchorPrice)
          ? anchorPrice
          : (visibleRange.from + visibleRange.to) / 2;
      const anchorRatio = (anchor - visibleRange.from) / currentSpan;

      const rawFrom = anchor - nextSpan * anchorRatio;
      const rawTo = anchor + nextSpan * (1 - anchorRatio);

      // Prices can never be negative, so the visible price axis should
      // never scroll/zoom below 0 either - clamp the lower edge here
      // rather than letting a zoom-out step reveal empty negative space
      // beneath the real data.
      const nextFrom = Math.max(0, rawFrom);
      const nextTo = Math.max(rawTo, nextFrom + Number.EPSILON);

      priceScale.applyOptions({ autoScale: false });
      priceScale.setVisibleRange({
        from: nextFrom,
        to: nextTo,
      });
    };

    // Capture + passive:false lets us override the browser's Ctrl+wheel
    // page zoom before the chart's own wheel handler sees the event.
    refs.containerRef.current.addEventListener(
      "wheel",
      handlePriceScaleWheel,
      { capture: true, passive: false },
    );

    /*
     * The window "resize" event only fires when the browser window
     * itself changes size. Opening/closing the settings sidebar shrinks
     * or grows .chart-wrap purely through a CSS flex/width transition,
     * which never touches the window - so without this, the chart kept
     * its old pixel width and got covered by the sidebar instead of
     * shrinking to make room. ResizeObserver watches the actual
     * container element and fires continuously while the sidebar's
     * width transition is animating, so the chart (and its price scale)
     * reflows smoothly in sync with the sidebar instead of jumping only
     * once at the end.
     */
    const resizeObserver = new ResizeObserver(() => {
      resize();
    });

    resizeObserver.observe(refs.containerRef.current);

    return () => {
      window.cancelAnimationFrame(clampFrame);
      window.removeEventListener("resize", resize);
      refs.containerRef.current?.removeEventListener(
        "wheel",
        handlePriceScaleWheel,
        true,
      );
      resizeObserver.disconnect();

      chart.remove();

      refs.chartRef.current = null;
      refs.candleRef.current = null;
      refs.futureScaleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
