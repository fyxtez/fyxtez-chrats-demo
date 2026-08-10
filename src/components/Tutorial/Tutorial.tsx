import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import "./Tutorial.css";

type TutorialProps = {
  onClose: () => void;
  onStepChange: (stepId: TutorialStepId) => void;
};

export type TutorialStepId =
  | "symbols"
  | "tabs"
  | "timeframe"
  | "drawing"
  | "chart"
  | "trading"
  | "orders"
  | "options"
  | "hotkeys";

type TutorialPlacement = "right" | "left" | "bottom-start" | "above" | "center";

type TutorialStep = {
  id: TutorialStepId;
  selector: string;
  placement: TutorialPlacement;
  eyebrow: string;
  title: string;
  description: string;
};

const STEPS: readonly TutorialStep[] = [
  {
    id: "symbols",
    selector: ".symbol-switcher-menu",
    placement: "right",
    eyebrow: "Markets",
    title: "Choose a symbol",
    description: "Switch between demo markets, pin favourites, or add another Binance Futures symbol.",
  },
  {
    id: "tabs",
    selector: ".chart-tabs-bar",
    placement: "bottom-start",
    eyebrow: "Workspace",
    title: "Keep charts in tabs",
    description: "Open several symbols, reorder them, and jump between charts without losing your saved view.",
  },
  {
    id: "timeframe",
    selector: ".desktop-timeframe-buttons button.active",
    placement: "right",
    eyebrow: "Chart controls",
    title: "Change timeframe and zoom",
    description: "Pick the candle interval here. The plus and minus controls adjust the visible chart range.",
  },
  {
    id: "drawing",
    selector: ".drawing-panel",
    placement: "right",
    eyebrow: "Analysis",
    title: "Draw directly on the chart",
    description: "Use text, pen, lines, ranges and other tools. Undo, redo and keyboard shortcuts are available here too.",
  },
  {
    id: "chart",
    selector: ".chart-wrap",
    placement: "center",
    eyebrow: "Chart navigation",
    title: "Explore the price chart",
    description: "Drag to move through time, use the mouse wheel to zoom, and use the price scale to adjust the visible range.",
  },
  {
    id: "orders",
    selector: ".positions-panel",
    placement: "above",
    eyebrow: "Position management",
    title: "Review orders and positions",
    description: "The bottom panel contains fake positions and limit orders. Use it to inspect trades and practise Add, Reduce and protection tools.",
  },
  {
    id: "options",
    selector: ".settings-panel.open",
    placement: "left",
    eyebrow: "Personalise",
    title: "Make the workspace yours",
    description: "Configure sessions, drawings, PnL cards, alerts and other chart display preferences from Options.",
  },
  {
    id: "hotkeys",
    selector: ".hotkeys-popup",
    placement: "right",
    eyebrow: "Work faster",
    title: "Learn the keyboard shortcuts",
    description: "These shortcuts cover symbol tabs, drawing tools, copy and paste, undo and redo. You can reopen this list from the ? button beside the toolbar.",
  },
  {
    id: "trading",
    selector: ".chart-wrap",
    placement: "center",
    eyebrow: "Paper trading",
    title: "Double-click to open the trade menu",
    description: "Click twice with the left mouse button anywhere on the chart. The demo trade menu opens at that price with Market, Limit and Auto Market options.",
  },
];

type SpotlightRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const SPOTLIGHT_PADDING = 7;
const TOOLTIP_WIDTH = 360;
const TOOLTIP_ESTIMATED_HEIGHT = 250;
const VIEWPORT_GUTTER = 16;

export default function Tutorial({ onClose, onStepChange }: TutorialProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const step = STEPS[stepIndex];

  useEffect(() => {
    onStepChange(step.id);
  }, [onStepChange, step.id]);

  useLayoutEffect(() => {
    const updateTarget = () => {
      const selector =
        step.selector === ".desktop-timeframe-buttons button.active" && window.innerWidth <= 720
          ? ".mobile-timeframe-trigger"
          : step.selector;
      const target = document.querySelector<HTMLElement>(selector);
      if (!target) {
        setRect(null);
        return;
      }

      const bounds = target.getBoundingClientRect();
      const top = Math.max(0, bounds.top - SPOTLIGHT_PADDING);
      const left = Math.max(0, bounds.left - SPOTLIGHT_PADDING);
      const right = Math.min(window.innerWidth, bounds.right + SPOTLIGHT_PADDING);
      const bottom = Math.min(window.innerHeight, bounds.bottom + SPOTLIGHT_PADDING);
      setRect({ top, left, width: right - left, height: bottom - top });
    };

    updateTarget();
    const selector =
      step.selector === ".desktop-timeframe-buttons button.active" && window.innerWidth <= 720
        ? ".mobile-timeframe-trigger"
        : step.selector;
    const target = document.querySelector<HTMLElement>(selector);
    const resizeObserver = target ? new ResizeObserver(updateTarget) : null;
    if (target) resizeObserver?.observe(target);
    const mutationObserver = new MutationObserver(updateTarget);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", updateTarget);
    window.addEventListener("scroll", updateTarget, true);
    const frame = window.requestAnimationFrame(updateTarget);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", updateTarget);
      window.removeEventListener("scroll", updateTarget, true);
    };
  }, [step.selector]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") {
        setStepIndex((current) => Math.min(STEPS.length - 1, current + 1));
      }
      if (event.key === "ArrowLeft") {
        setStepIndex((current) => Math.max(0, current - 1));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tooltipStyle = useMemo<CSSProperties>(() => {
    if (!rect) {
      return {
        visibility: "hidden",
        pointerEvents: "none",
      };
    }

    const clampLeft = (left: number) => Math.min(
      window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_GUTTER,
      Math.max(VIEWPORT_GUTTER, left),
    );
    const clampTop = (top: number) => Math.min(
      window.innerHeight - TOOLTIP_ESTIMATED_HEIGHT - VIEWPORT_GUTTER,
      Math.max(VIEWPORT_GUTTER, top),
    );
    const centeredLeft = clampLeft(rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2);

    if (step.placement === "center") {
      return {
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
      };
    }

    if (step.placement === "right") {
      const preferredLeft = rect.left + rect.width + 16;
      if (preferredLeft + TOOLTIP_WIDTH <= window.innerWidth - VIEWPORT_GUTTER) {
        return { left: preferredLeft, top: clampTop(rect.top + 24) };
      }
    }

    if (step.placement === "left") {
      const preferredLeft = rect.left - TOOLTIP_WIDTH - 16;
      if (preferredLeft >= VIEWPORT_GUTTER) {
        return { left: preferredLeft, top: clampTop(rect.top + rect.height / 2 - TOOLTIP_ESTIMATED_HEIGHT / 2) };
      }
    }

    if (step.placement === "above") {
      const preferredTop = rect.top - TOOLTIP_ESTIMATED_HEIGHT - 16;
      return { left: centeredLeft, top: clampTop(preferredTop) };
    }

    if (step.placement === "bottom-start") {
      const preferredTop = rect.top + rect.height + 16;
      if (preferredTop + TOOLTIP_ESTIMATED_HEIGHT <= window.innerHeight - VIEWPORT_GUTTER) {
        return { left: clampLeft(rect.left), top: preferredTop };
      }
    }

    const belowTop = rect.top + rect.height + 14;
    const hasRoomBelow = belowTop + TOOLTIP_ESTIMATED_HEIGHT <= window.innerHeight - VIEWPORT_GUTTER;

    if (hasRoomBelow) {
      return { left: centeredLeft, top: belowTop };
    }

    const aboveTop = rect.top - TOOLTIP_ESTIMATED_HEIGHT - 14;
    if (aboveTop >= VIEWPORT_GUTTER) {
      return { left: centeredLeft, top: aboveTop };
    }

    return {
      left: centeredLeft,
      top: Math.max(
        VIEWPORT_GUTTER,
        Math.min(
          window.innerHeight - TOOLTIP_ESTIMATED_HEIGHT - VIEWPORT_GUTTER,
          rect.top + 24,
        ),
      ),
    };
  }, [rect, step.placement]);

  const isLastStep = stepIndex === STEPS.length - 1;

  return (
    <div className="tutorial-layer" role="dialog" aria-modal="true" aria-label="Terminal tutorial">
      <button className="tutorial-backdrop" aria-label="Close tutorial" onClick={onClose} />

      {rect && (
        <div
          className="tutorial-spotlight"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      )}

      <section className="tutorial-card" style={tooltipStyle}>
        <div className="tutorial-card-topline">
          <span>{step.eyebrow}</span>
          <span>{stepIndex + 1} / {STEPS.length}</span>
        </div>

        <h2>{step.title}</h2>
        <p>{step.description}</p>

        <div className="tutorial-progress" aria-hidden="true">
          {STEPS.map((item, index) => (
            <span className={index === stepIndex ? "active" : ""} key={item.title} />
          ))}
        </div>

        <div className="tutorial-actions">
          <button className="tutorial-skip" type="button" onClick={onClose}>Skip tutorial</button>
          <div>
            <button
              type="button"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
            >
              Back
            </button>
            <button
              className="tutorial-next"
              type="button"
              onClick={() => {
                if (isLastStep) onClose();
                else setStepIndex((current) => current + 1);
              }}
            >
              {isLastStep ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
