import { useEffect, useMemo, useRef, useState } from "react";
import { CHART_TIME_ZONE } from "../../utils/time";
import "./ChartContextBadges.css";

type ChartTag = {
  id: string;
  name: string;
};

type StoredChartTags = {
  tags: ChartTag[];
  activeTagId: string;
};

type ChartContextBadgesProps = {
  symbol: string;
  activeDrawingSetName: string;
  showDrawingSetBadge: boolean;
  showTags: boolean;
};

const chartTagsStorageKey = (symbol: string) =>
  `fyxtez.chartTags.${symbol.trim().toUpperCase()}`;

const createTag = (name = "Tag"): ChartTag => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name,
});

function loadChartTags(symbol: string): StoredChartTags {
  const fallbackTags = [createTag("tag1"), createTag("tag2")];
  const fallback = { tags: fallbackTags, activeTagId: fallbackTags[0].id };

  try {
    const raw = localStorage.getItem(chartTagsStorageKey(symbol));
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as Partial<StoredChartTags>;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter(
        (tag): tag is ChartTag =>
          Boolean(tag) &&
          typeof tag.id === "string" &&
          typeof tag.name === "string",
      )
      : [];

    if (tags.length === 0) return fallback;

    const activeTagId = tags.some((tag) => tag.id === parsed.activeTagId)
      ? (parsed.activeTagId as string)
      : tags[0].id;

    return { tags, activeTagId };
  } catch {
    return fallback;
  }
}

export default function ChartContextBadges({
  symbol,
  activeDrawingSetName,
  showDrawingSetBadge,
  showTags,
}: ChartContextBadgesProps) {
  const [dayRefreshTick, setDayRefreshTick] = useState(0);
  const currentDayName = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: CHART_TIME_ZONE,
        weekday: "long",
      }).format(new Date()),
    [dayRefreshTick],
  );
  // ISO weekday number: Monday = 1 ... Sunday = 7
  const isoWeekdayNumber = useMemo(() => {
    const isoOrder = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    const index = isoOrder.indexOf(currentDayName);
    return index === -1 ? undefined : index + 1;
  }, [currentDayName]);
  const currentDayLabel =
    isoWeekdayNumber !== undefined
      ? `${currentDayName} (${isoWeekdayNumber})`
      : currentDayName;

  useEffect(() => {
    const intervalId = window.setInterval(() => setDayRefreshTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const [storedTags, setStoredTags] = useState<StoredChartTags>(() =>
    loadChartTags(symbol),
  );
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    setStoredTags(loadChartTags(symbol));
  }, [symbol]);

  useEffect(() => {
    localStorage.setItem(chartTagsStorageKey(symbol), JSON.stringify(storedTags));
  }, [storedTags, symbol]);

  useEffect(() => {
    if (!pendingFocusId) return;
    const input = inputRefs.current.get(pendingFocusId);
    if (!input) return;

    input.focus();
    input.select();
    setPendingFocusId(null);
  }, [pendingFocusId, storedTags.tags]);

  const addTag = () => {
    const tag = createTag("New tag");
    setStoredTags((current) => ({
      tags: [...current.tags, tag],
      activeTagId: tag.id,
    }));
    setPendingFocusId(tag.id);
  };

  const renameTag = (tagId: string, name: string) => {
    setStoredTags((current) => ({
      ...current,
      tags: current.tags.map((tag) =>
        tag.id === tagId ? { ...tag, name: name.slice(0, 40) } : tag,
      ),
    }));
  };

  const deleteTag = (tagId: string) => {
    setStoredTags((current) => {
      const deletedIndex = current.tags.findIndex((tag) => tag.id === tagId);
      const tags = current.tags.filter((tag) => tag.id !== tagId);

      if (current.activeTagId !== tagId) {
        return { ...current, tags };
      }

      const nextActiveTag =
        tags[Math.min(Math.max(deletedIndex, 0), Math.max(tags.length - 1, 0))];

      return {
        tags,
        activeTagId: nextActiveTag?.id ?? "",
      };
    });
  };

  const normalizeEmptyTag = (tagId: string) => {
    setStoredTags((current) => ({
      ...current,
      tags: current.tags.map((tag) =>
        tag.id === tagId && tag.name.trim().length === 0
          ? { ...tag, name: "Tag" }
          : tag,
      ),
    }));
  };

  return (
    <div className="chart-context-badges">
<div className="current-day-badge" title={`Current day: ${currentDayLabel}`}>
  {currentDayLabel}
</div>

      {showDrawingSetBadge && (
        <div
          className="active-drawing-set-badge"
          title={`Active drawing set: ${activeDrawingSetName}`}
        >
          {activeDrawingSetName}
        </div>
      )}

      {showTags && (
        <div className="chart-tags" aria-label="Chart tags">
          {storedTags.tags.map((tag) => {
            const isActive = tag.id === storedTags.activeTagId;
            return (
              <div
                key={tag.id}
                className={`chart-tag ${isActive ? "active" : ""}`}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <input
                  ref={(element) => {
                    if (element) inputRefs.current.set(tag.id, element);
                    else inputRefs.current.delete(tag.id);
                  }}
                  className="chart-tag-input"
                  value={tag.name}
                  size={Math.max(3, Math.min(18, tag.name.length || 3))}
                  maxLength={40}
                  title="Click and type to rename this tag"
                  aria-label={`Chart tag ${tag.name || "unnamed"}`}
                  onFocus={() =>
                    setStoredTags((current) => ({
                      ...current,
                      activeTagId: tag.id,
                    }))
                  }
                  onChange={(event) => renameTag(tag.id, event.target.value)}
                  onBlur={() => normalizeEmptyTag(tag.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <button
                  type="button"
                  className="chart-tag-delete"
                  title={`Delete tag ${tag.name || "unnamed"}`}
                  aria-label={`Delete chart tag ${tag.name || "unnamed"}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteTag(tag.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}

          <button
            type="button"
            className="chart-tag-add"
            title="Add a new tag"
            aria-label="Add chart tag"
            onClick={(event) => {
              event.stopPropagation();
              addTag();
            }}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
