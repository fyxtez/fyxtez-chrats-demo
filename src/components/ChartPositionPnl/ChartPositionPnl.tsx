import "./ChartPositionPnl.css";

type ChartPositionPnlProps = {
  pnl: number;
  /**
   * "current" (default) is the active chart symbol's own unrealized PNL,
   * pinned top-right. "total" is the same card stacked directly below it
   * (see .chart-position-pnl--total in the CSS) for the sum across every
   * open position - see totalPnl in hooks/useChartPositionPnl.ts.
   */
  variant?: "current" | "total";
};

function formatPnl(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export default function ChartPositionPnl({
  pnl,
  variant = "current",
}: ChartPositionPnlProps) {
  const tone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
  const isTotal = variant === "total";
  const title = isTotal
    ? "Total unrealized PNL across all open positions"
    : "Current unrealized position PNL";

  return (
    <div
      className={`chart-position-pnl ${tone} ${isTotal ? "chart-position-pnl--total" : ""}`}
      title={title}
      aria-label={`${title} ${formatPnl(pnl)}`}
    >
      <span>{isTotal ? "TOTAL" : "PNL"}</span>
      <strong>{formatPnl(pnl)}</strong>
    </div>
  );
}
