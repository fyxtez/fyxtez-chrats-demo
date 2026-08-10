import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import {
  getTodaysSessions,
  localDayKey,
  type TradingSession,
} from "../../utils/sessions";
import { startPacedLoop } from "../../utils/pacedLoop";
import "./SessionZonesOverlay.css";

type SessionZonesOverlayProps = {
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  /**
   * Same time->pixel conversion the candles/drawings already use (see
   * useCoordinateMapping.ts). This is the important bit for correctness:
   * the chart's underlying time axis is UTC epoch seconds no matter what
   * timezone its tick labels are formatted in, so positioning these lines
   * through the exact same function candles use is what guarantees they
   * land in the right spot relative to the chart's (locally-formatted)
   * time labels - there's no separate "convert to local pixels" step
   * that could be gotten wrong.
   */
  coordTimeToX: (time: UTCTimestamp) => number | null;
  showAsia: boolean;
  showLondon: boolean;
  showNewYork: boolean;
};

type PositionedLine = {
  id: string;
  x: number;
  color: string;
  label: string | null;
};

export default function SessionZonesOverlay({
  chartWrapRef,
  chartRef,
  candleRef,
  coordTimeToX,
  showAsia,
  showLondon,
  showNewYork,
}: SessionZonesOverlayProps) {
  const [sessions, setSessions] = useState<TradingSession[]>(() =>
    getTodaysSessions(),
  );
  const dayKeyRef = useRef(localDayKey());

  const [lines, setLines] = useState<PositionedLine[]>([]);
  const [paneHeight, setPaneHeight] = useState(0);

  // Recompute the session windows the moment the chart's local calendar
  // day rolls over, so yesterday's lines never linger into today.
  // Checked once a minute - the rollover itself only ever happens once
  // daily, but there's no reason to build a precise midnight timer.
  useEffect(() => {
    const checkForNewDay = () => {
      const currentKey = localDayKey();
      if (currentKey === dayKeyRef.current) return;

      dayKeyRef.current = currentKey;
      setSessions(getTodaysSessions());
    };

    const intervalId = window.setInterval(checkForNewDay, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  // Recomputes each line's on-screen x at a bounded cadence, the same way
  // PositionBracketOverlay/AutoMarketOverlay already track their own
  // price/time-based positions - needed so the lines stay aligned while
  // panning, zooming, or switching timeframes.
  useEffect(() => {
    const update = () => {
      const chart = chartRef.current;
      const series = candleRef.current;

      if (!chart || !series) {
        return;
      }

      const paneSize = chart.paneSize();
      const nextLines: PositionedLine[] = [];

      // Start and end are checked independently rather than as a pair -
      // a session's start can be off-screen to the left (already
      // scrolled past) while its end is still visible, or vice versa,
      // and each boundary should render whenever IT is on screen.
      for (const session of sessions) {
        const isVisible =
          (session.id === "asia" && showAsia) ||
          (session.id === "london" && showLondon) ||
          (session.id === "newyork" && showNewYork);
        if (!isVisible) continue;

        const startX = coordTimeToX(session.start);

        if (startX !== null && startX >= 0 && startX <= paneSize.width) {
          nextLines.push({
            id: `${session.id}-start`,
            x: startX,
            color: session.color,
            label: session.label,
          });
        }

        const endX = coordTimeToX(session.end);

        if (endX !== null && endX >= 0 && endX <= paneSize.width) {
          nextLines.push({
            id: `${session.id}-end`,
            x: endX,
            color: session.color,
            label: null,
          });
        }
      }

      setLines((current) => {
        if (
          current.length === nextLines.length &&
          current.every((item, index) => {
            const next = nextLines[index];
            return (
              item.id === next.id &&
              Math.abs(item.x - next.x) <= 0.25 &&
              item.color === next.color &&
              item.label === next.label
            );
          })
        ) {
          return current;
        }

        return nextLines;
      });
      setPaneHeight((current) =>
        Math.abs(current - paneSize.height) <= 0.25 ? current : paneSize.height,
      );

    };

    return startPacedLoop(update);
  }, [sessions, chartWrapRef, chartRef, candleRef, coordTimeToX, showAsia, showLondon, showNewYork]);

  if (lines.length === 0 || paneHeight <= 0) return null;

  return (
    <div className="session-zones-overlay" aria-hidden="true">
      {lines.map((line) => (
        <div
          key={line.id}
          className="session-line"
          style={{
            left: line.x,
            height: paneHeight,
            borderLeftColor: line.color,
          }}
        >
          {line.label && (
            <span
              className="session-line-label"
              style={{ color: line.color, borderColor: line.color }}
            >
              {line.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
