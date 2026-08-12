import { useLayoutEffect, useState, type RefObject } from "react";

export type ClampedPosition = { left: number; top: number };

/**
 * Clamps an absolutely-positioned floating panel (context menu, trade
 * menu) so it never renders partially off-screen.
 *
 * These menus open anchored to a raw pointer coordinate
 * (event.clientX/clientY) with no awareness of their own rendered size -
 * harmless on a large desktop viewport where there's usually room to
 * spare on every side, but on a phone a long-press/tap near the right or
 * bottom edge routinely opens a menu whose right/bottom portion (or, for
 * RTL-ish edge cases, top-left labels) renders past the edge of the
 * visible screen, cutting off its own buttons and text with no way to
 * reach them (see the mobile bug report this was written for).
 *
 * Re-measures whenever the requested x/y change AND whenever the panel's
 * own rendered size changes (its content can grow - e.g. a submenu
 * opening changes the context menu's height) via ResizeObserver, so the
 * clamp keeps up rather than being computed once against a stale size.
 */
export function useClampedMenuPosition(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  margin = 8,
): ClampedPosition {
  const [position, setPosition] = useState<ClampedPosition>({
    left: x,
    top: y,
  });

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) {
      setPosition({ left: x, top: y });
      return;
    }

    const clamp = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;

      // The upper bound is derived from the panel's own measured size,
      // never a hardcoded constant - a mismatch between an assumed size
      // and the panel's actual (possibly responsive) rendered size is
      // exactly what let panels get pushed off-screen in the first
      // place. Computing both bounds this way means Math.min/Math.max
      // below always agree on which bound is smaller, even on a
      // viewport too narrow to fit the panel with full margins on both
      // sides.
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);

      setPosition({
        left: Math.min(Math.max(margin, x), maxLeft),
        top: Math.min(Math.max(margin, y), maxTop),
      });
    };

    clamp();

    const resizeObserver = new ResizeObserver(clamp);
    resizeObserver.observe(el);
    window.addEventListener("resize", clamp);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [ref, x, y, margin]);

  return position;
}
