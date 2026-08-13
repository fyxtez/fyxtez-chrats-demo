import { useEffect, useState } from "react";

/**
 * Reactively tracks whether the viewport is at or below `breakpointPx`
 * (720px matches every other mobile media query in this codebase - see
 * Topbar.css, PositionsPanel.css, SettingsPanel.css, etc.). Uses
 * matchMedia rather than a resize listener so it stays cheap and in sync
 * with the same breakpoint the CSS itself uses.
 */
export function useIsMobileViewport(breakpointPx = 720): boolean {
  const query = `(max-width: ${breakpointPx}px)`;

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handleChange = () => setIsMobile(mql.matches);

    handleChange();
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [query]);

  return isMobile;
}
