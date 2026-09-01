/**
 * Pure axis-range maths for the plotter.
 *
 * Kept free of Chart.js and Angular so the windowing and latching rules — the
 * subtlest part of the plotter — can be tested directly.
 */

export interface Range {
  min: number;
  max: number;
}

/** Latched bounds carried across updates; `null` means "nothing seen yet". */
export interface LatchedBounds {
  min: number | null;
  max: number | null;
}

/**
 * Horizontal window.
 *
 * `windowSeconds > 0` pins the axis to a fixed width anchored to the newest
 * sample, so the trace scrolls through a constant-width viewport. `0` fits the
 * whole record, letting the axis rescale as data arrives.
 */
export function computeXWindow(
  firstTime: number,
  lastTime: number,
  windowSeconds: number,
): Range {
  if (windowSeconds > 0) {
    return { min: lastTime - windowSeconds, max: lastTime };
  }
  // guarantee a non-degenerate axis for a single sample
  return { min: firstTime, max: lastTime > firstTime ? lastTime : firstTime + 1 };
}

export interface YRangeOptions {
  /** Extent of the currently visible data; `null` when there is nothing to show. */
  dataMin: number | null;
  dataMax: number | null;
  /** Bounds retained from previous updates. */
  latched: LatchedBounds;
  /** Grow-only: a new min/max is kept and never shrinks back. */
  latch: boolean;
  /** Freeze the axis exactly where it is. */
  locked: boolean;
  /** Hard bounds; when both are set and ordered they win outright. */
  manualMin: number | null;
  manualMax: number | null;
  /** Headroom above/below the data, as a fraction of the range. */
  padRatio?: number;
}

export interface YRangeResult {
  /** Range to apply, or `null` to leave the axis untouched. */
  range: Range | null;
  /** Latched bounds to carry into the next update. */
  latched: LatchedBounds;
}

/**
 * Vertical range, in priority order:
 *   1. manual min/max (both set, correctly ordered)
 *   2. locked — hold the latched bounds
 *   3. latching — expand to include new extremes, never contract
 *   4. plain autoscale
 */
export function computeYRange(options: YRangeOptions): YRangeResult {
  const { dataMin, dataMax, latch, locked, manualMin, manualMax } = options;
  const padRatio = options.padRatio ?? 0.05;
  let latched: LatchedBounds = { ...options.latched };

  // 1. manual bounds override everything
  if (manualMin !== null && manualMax !== null && manualMax > manualMin) {
    return { range: { min: manualMin, max: manualMax }, latched };
  }

  // 2. frozen at the current range
  if (locked && latched.min !== null && latched.max !== null) {
    return { range: { min: latched.min, max: latched.max }, latched };
  }

  if (dataMin === null || dataMax === null) {
    return { range: null, latched };
  }

  // 3 / 4. grow-only, or track the data exactly
  latched = latch
    ? {
        min: latched.min === null ? dataMin : Math.min(latched.min, dataMin),
        max: latched.max === null ? dataMax : Math.max(latched.max, dataMax),
      }
    : { min: dataMin, max: dataMax };

  // A flat trace has zero span, which Chart.js cannot draw — give it ±1. This
  // must not key off the padding itself, or padRatio: 0 would be overridden.
  const span = latched.max! - latched.min!;
  const pad = span === 0 ? 1 : span * padRatio;
  return {
    range: { min: latched.min! - pad, max: latched.max! + pad },
    latched,
  };
}
