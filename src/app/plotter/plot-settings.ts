/** Per-plot view settings. Each open plot owns its own copy. */
export interface PlotSettings {
  /**
   * Sliding x-window in seconds for streaming sources.
   * `0` = no window: the axis keeps rescaling to fit everything received.
   * Ignored for static files, which always plot the full record.
   */
  windowSeconds: number;
  /** Fixed pixel height of the plot area. */
  plotHeight: number;
  /** Y range only ever grows — a new min/max is kept, never shrunk back. */
  latchYAxis: boolean;
  /** Freeze the y range exactly where it is. */
  lockYAxis: boolean;
  /** Manual y bounds. Both set (and ordered) = axis hard-pinned to them. */
  manualYMin: number | null;
  manualYMax: number | null;
  /** Zoom/pan enable per axis. */
  zoomHorizontal: boolean;
  zoomVertical: boolean;
  /** Max samples retained per trace for streaming sources. */
  maxBufferPoints: number;
}

/**
 * Defaults tuned so three plots stack comfortably in the right dock without
 * scrolling — deliberately small, since the operator can enlarge or tear out
 * any panel that needs a closer look.
 */
export const DEFAULT_PLOT_SETTINGS: PlotSettings = {
  windowSeconds: 0,
  plotHeight: 180,
  latchYAxis: true,
  lockYAxis: false,
  manualYMin: null,
  manualYMax: null,
  zoomHorizontal: true,
  zoomVertical: true,
  maxBufferPoints: 20000,
};
