import { useEffect, useRef, useState } from "react";
import { intervals, type Interval } from "../../config/constants";
import "./CandleCountdownBadge.css";

type CandleCountdownBadgeProps = {
  /** Countdown label for the active chart timeframe, e.g. "4:37". */
  label: string;
  /** The active chart timeframe, so its row can be highlighted in the dropdown. */
  interval: Interval;
  /** Countdown label for every timeframe (active one included) - see useCandleCountdown.ts. */
  allLabels: Record<Interval, string>;
};

export default function CandleCountdownBadge({
  label,
  interval,
  allLabels,
}: CandleCountdownBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape - the same pattern SymbolSwitcher
  // already uses for its own dropdown.
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="candle-countdown" ref={rootRef}>
      <button
        className={`candle-countdown-badge ${isOpen ? "open" : ""}`}
        title="Time left until the current candle closes - click for every timeframe"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((open) => !open);
        }}
      >
        {label}
      </button>

      {isOpen && (
        <div
          className="candle-countdown-menu"
          onClick={(event) => event.stopPropagation()}
        >
          {intervals.map((candidate) => (
            <div
              key={candidate}
              className={`candle-countdown-option ${
                candidate === interval ? "active" : ""
              }`}
            >
              <span className="candle-countdown-option-interval">
                {candidate}
              </span>
              <span className="candle-countdown-option-time">
                {allLabels[candidate] ?? "--:--"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
