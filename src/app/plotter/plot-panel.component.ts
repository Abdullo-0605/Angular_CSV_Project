import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import {
  CsvFileSource,
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  WaveformSourceMeta,
  WaveformSourceState,
} from '../data-sources';
import { computeXWindow, computeYRange } from './axis-range';
import { DEFAULT_PLOT_SETTINGS, PlotSettings } from './plot-settings';

/** One entry in the checklist legend. */
export interface TraceLegendItem {
  label: string;
  color: string;
  index: number;
}

let panelSeq = 0;

/**
 * A single plot container: one source, one chart, its own view settings.
 *
 * Lives in the right-hand dock by default. Dragging the title bar tears it out
 * into a free-floating window (like a browser tab), and it can be re-docked.
 * Nothing here is modal — the operator can keep using the rest of the HMI with
 * plots left open.
 */
@Component({
  selector: 'plot-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './plot-panel.component.html',
  styleUrl: './plot-panel.component.css',
  host: {
    '[class.floating]': 'floating()',
    '[class.docked]': '!floating()',
    '[class.minimized]': "windowState() === 'minimized'",
    '[class.maximized]': "windowState() === 'maximized'",
    '[style.top.px]': 'floating() ? top() : null',
    '[style.left.px]': 'floating() ? left() : null',
    '[style.width.px]': 'floating() ? width() : null',
  },
})
export class PlotPanel implements OnDestroy {
  @ViewChild('plotCanvas') plotCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('legendContainer') legendContainer!: ElementRef<HTMLDivElement>;

  /** The feed this panel renders. Required. */
  readonly source = input.required<WaveformSource>();
  /** Starting settings, copied from the control panel's defaults. */
  readonly initialSettings = input<PlotSettings>(DEFAULT_PLOT_SETTINGS);
  /** Human-readable title. */
  readonly title = input('Waveform');

  readonly closed = output<void>();

  readonly panelId = ++panelSeq;

  /* --------------------------------------------------- per-plot settings --- */

  windowSeconds = signal(DEFAULT_PLOT_SETTINGS.windowSeconds);
  plotHeight = signal(DEFAULT_PLOT_SETTINGS.plotHeight);
  latchYAxis = signal(DEFAULT_PLOT_SETTINGS.latchYAxis);
  lockYAxis = signal(DEFAULT_PLOT_SETTINGS.lockYAxis);
  manualYMin = signal<number | null>(null);
  manualYMax = signal<number | null>(null);
  zoomHorizontal = signal(DEFAULT_PLOT_SETTINGS.zoomHorizontal);
  zoomVertical = signal(DEFAULT_PLOT_SETTINGS.zoomVertical);
  maxBufferPoints = signal(DEFAULT_PLOT_SETTINGS.maxBufferPoints);

  /** Compact per-panel settings tray, collapsed to save vertical space. */
  settingsOpen = signal(false);
  legendOpen = signal(true);

  /* ------------------------------------------------------- window layout --- */

  floating = signal(false);
  windowState = signal<'normal' | 'minimized' | 'maximized'>('normal');
  top = signal(60);
  left = signal(120);
  width = signal(620);

  /* ------------------------------------------------------- source status --- */

  sourceLabel = signal('');
  sourceMode = signal<'static' | 'stream' | null>(null);
  sourceState = signal<WaveformSourceState>('idle');
  sourceDetail = signal('');
  errorMessage = signal('');
  dataLoaded = signal(false);
  sampleCount = signal(0);
  latestTime = signal(0);

  status = computed<'N/A' | 'Ready' | 'Error'>(() => {
    if (this.sourceState() === 'error') return 'Error';
    return this.dataLoaded() ? 'Ready' : 'N/A';
  });

  /* ------------------------------------------------------ legend / traces --- */

  legendItems: TraceLegendItem[] = [];
  visibleTraces = signal<boolean[]>([]);
  highlightedTraceIndex = signal<number | null>(null);
  isolatedTraceIndex = signal<number | null>(null);

  /* ------------------------------------------------------------ internals --- */

  private static pluginRegistered = false;

  private chart: Chart | null = null;
  private connected = false;

  private columns: string[] = [];
  private labels: number[] = [];
  private series: number[][] = [];
  private xAxisLabel = 'Time';
  private yAxisLabel = 'Value';

  private latchedMin: number | null = null;
  private latchedMax: number | null = null;
  private redrawQueued = false;

  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private resizing = false;
  private resizeEdge = '';
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartW = 0;
  private resizeStartH = 0;
  private resizeStartTop = 0;
  private resizeStartLeft = 0;

  private hoverTimer: any = null;
  private tooltipActive = false;
  private isFullscreen = false;
  private singleClickTimer: any = null;
  private onFullscreenExit = () => this.handleFullscreenExit();

  constructor() {
    // Registering at module scope breaks SSR prerender, so do it lazily once.
    if (!PlotPanel.pluginRegistered) {
      Chart.register(zoomPlugin);
      PlotPanel.pluginRegistered = true;
    }
  }

  async ngOnInit() {
    this.applySettings(this.initialSettings());
    await this.connect();
  }

  /** Copy incoming defaults into this panel's own signals. */
  private applySettings(s: PlotSettings) {
    this.windowSeconds.set(s.windowSeconds);
    this.plotHeight.set(s.plotHeight);
    this.latchYAxis.set(s.latchYAxis);
    this.lockYAxis.set(s.lockYAxis);
    this.manualYMin.set(s.manualYMin);
    this.manualYMax.set(s.manualYMax);
    this.zoomHorizontal.set(s.zoomHorizontal);
    this.zoomVertical.set(s.zoomVertical);
    this.maxBufferPoints.set(s.maxBufferPoints);
  }

  private async connect() {
    const src = this.source();
    this.sourceLabel.set(src.label);
    this.sourceMode.set(src.mode);
    this.connected = true;
    await src.connect(this.sourceEvents());
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.onFullscreenExit);
    if (this.connected) this.source().disconnect();
    this.chart?.destroy();
    this.removeTooltipEl();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.singleClickTimer) clearTimeout(this.singleClickTimer);
  }

  /** Currently buffered samples, e.g. for export. */
  snapshot(): { columns: string[]; samples: WaveformSample[] } {
    return {
      columns: [...this.columns],
      samples: this.labels.map((time, i) => ({
        time,
        values: this.series.map((s) => s[i]),
      })),
    };
  }

  /* ====================================================================== */
  /* SOURCE EVENTS                                                          */
  /* ====================================================================== */

  private sourceEvents(): WaveformSourceEvents {
    return {
      meta: (meta) => this.handleMeta(meta),
      sample: (sample) => this.handleSample(sample),
      snapshot: (samples) => this.handleSnapshot(samples),
      reset: () => this.clearBuffers(true),
      state: (state, detail) => this.handleState(state, detail),
    };
  }

  private handleState(state: WaveformSourceState, detail?: string) {
    this.sourceState.set(state);
    this.sourceDetail.set(detail ?? '');
    if (state === 'error' && detail) this.errorMessage.set(detail);
    if (state === 'connected') this.errorMessage.set('');
  }

  private handleMeta(meta: WaveformSourceMeta) {
    this.columns = [...meta.columns];
    this.xAxisLabel = meta.xAxisLabel ?? 'Time';
    this.yAxisLabel = meta.yAxisLabel ?? 'Value';
    this.series = this.columns.map(() => []);
    this.labels = [];
    this.buildLegend();
    this.rebuildChart();
  }

  private handleSnapshot(samples: WaveformSample[]) {
    this.labels = [];
    this.series = this.columns.map(() => []);
    for (const s of samples) this.pushSample(s);
    this.dataLoaded.set(this.labels.length > 0);
    this.sampleCount.set(this.labels.length);
    if (!this.chart) this.rebuildChart();
    else this.queueRedraw();
  }

  private handleSample(sample: WaveformSample) {
    this.pushSample(sample);
    this.dataLoaded.set(true);
    this.sampleCount.set(this.labels.length);
    if (!this.chart) {
      this.rebuildChart();
      return;
    }
    this.queueRedraw();
  }

  private pushSample(sample: WaveformSample) {
    if (this.series.length !== this.columns.length) {
      this.series = this.columns.map(() => []);
    }
    this.labels.push(sample.time);
    for (let i = 0; i < this.columns.length; i++) {
      this.series[i].push(sample.values[i] ?? NaN);
    }
    this.latestTime.set(sample.time);

    const cap = Math.max(100, this.maxBufferPoints());
    while (this.labels.length > cap) {
      this.labels.shift();
      for (const s of this.series) s.shift();
    }
  }

  private clearBuffers(keepColumns = false) {
    this.labels = [];
    this.series = keepColumns ? this.columns.map(() => []) : [];
    if (!keepColumns) {
      this.columns = [];
      this.legendItems = [];
      this.visibleTraces.set([]);
    }
    this.latchedMin = null;
    this.latchedMax = null;
    this.sampleCount.set(0);
    this.latestTime.set(0);
    this.dataLoaded.set(false);
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);

    if (this.chart) {
      this.chart.data.labels = [];
      this.chart.data.datasets.forEach((ds) => (ds.data = []));
      this.chart.update('none');
    }
  }

  /* ====================================================================== */
  /* CHART                                                                  */
  /* ====================================================================== */

  private rebuildChart(attempt = 0) {
    if (this.columns.length === 0) return;

    // canvas only exists once the panel body has rendered
    if (!this.plotCanvas) {
      if (attempt < 20) setTimeout(() => this.rebuildChart(attempt + 1), 50);
      return;
    }
    const ctx = this.plotCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    this.chart?.destroy();
    this.chart = null;

    const colors = this.traceColors();
    const visible = this.visibleTraces();

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [...this.labels],
        datasets: this.columns.map((label, i) => ({
          label,
          data: [...(this.series[i] ?? [])],
          borderColor: colors[i],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
          hidden: visible[i] === false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'xy', intersect: true },
        onClick: (_e, elements) => {
          if (elements.length > 0) this.highlightTrace(elements[0].datasetIndex);
        },
        plugins: {
          tooltip: this.tooltipConfig(),
          legend: { display: false }, // the checklist legend replaces it
          zoom: this.zoomConfig(),
        },
        scales: {
          x: { type: 'linear', title: { display: true, text: this.xAxisLabel } },
          y: { title: { display: true, text: this.yAxisLabel } },
        },
      },
    });

    this.applyDatasetData();
  }

  private applyDatasetData() {
    const chart = this.chart;
    if (!chart) return;

    chart.data.labels = this.labels;
    this.series.forEach((s, i) => {
      if (chart.data.datasets[i]) chart.data.datasets[i].data = s;
    });

    this.applyAxisRanges();
    chart.update('none');
  }

  /** Batch redraws into one animation frame — a 10 ms feed must not thrash. */
  private queueRedraw() {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    const run = () => {
      this.redrawQueued = false;
      this.applyDatasetData();
    };
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  private applyAxisRanges() {
    const chart = this.chart;
    if (!chart || this.labels.length === 0) return;

    const xScale = chart.options.scales?.['x'] as any;
    const yScale = chart.options.scales?.['y'] as any;
    if (!xScale || !yScale) return;

    const xWindow = computeXWindow(
      this.labels[0],
      this.labels[this.labels.length - 1],
      this.effectiveWindowSeconds(),
    );
    xScale.min = xWindow.min;
    xScale.max = xWindow.max;

    const extent = this.visibleDataExtent();
    const result = computeYRange({
      dataMin: extent.min,
      dataMax: extent.max,
      latched: { min: this.latchedMin, max: this.latchedMax },
      latch: this.latchYAxis(),
      locked: this.lockYAxis(),
      manualMin: this.manualYMin(),
      manualMax: this.manualYMax(),
    });

    this.latchedMin = result.latched.min;
    this.latchedMax = result.latched.max;
    if (result.range) {
      yScale.min = result.range.min;
      yScale.max = result.range.max;
    }
  }

  /** Min/max across visible traces within the current x window. */
  private visibleDataExtent(): { min: number | null; max: number | null } {
    const visible = this.visibleTraces();
    const isolated = this.isolatedTraceIndex();
    const win = this.effectiveWindowSeconds();
    const lastTime = this.labels[this.labels.length - 1];
    const from = win > 0 ? lastTime - win : -Infinity;

    let min: number | null = null;
    let max: number | null = null;

    for (let c = 0; c < this.series.length; c++) {
      if (visible[c] === false) continue;
      if (isolated !== null && c !== isolated) continue;
      const data = this.series[c];
      for (let i = 0; i < data.length; i++) {
        if (this.labels[i] < from) continue;
        const v = data[i];
        if (!Number.isFinite(v)) continue;
        if (min === null || v < min) min = v;
        if (max === null || v > max) max = v;
      }
    }
    return { min, max };
  }

  /** Static records always plot in full; only streams are windowed. */
  private effectiveWindowSeconds(): number {
    if (this.sourceMode() === 'static') return 0;
    const w = Number(this.windowSeconds());
    return Number.isFinite(w) && w > 0 ? w : 0;
  }

  private zoomConfig() {
    const x = this.zoomHorizontal();
    const y = this.zoomVertical();
    const mode = (x && y ? 'xy' : x ? 'x' : y ? 'y' : '') as 'x' | 'y' | 'xy' | '';
    const enabled = mode !== '';
    return {
      pan: { enabled, mode: (mode || 'xy') as 'x' | 'y' | 'xy' },
      zoom: {
        wheel: { enabled },
        pinch: { enabled },
        drag: { enabled, modifierKey: 'shift' as const },
        mode: (mode || 'xy') as 'x' | 'y' | 'xy',
      },
    };
  }

  private traceColors(): string[] {
    const n = Math.max(1, this.columns.length);
    return this.columns.map((_, i) => `hsl(${((i * 360) / n) % 360}, 70%, 50%)`);
  }

  private buildLegend() {
    const colors = this.traceColors();
    this.legendItems = this.columns.map((label, i) => ({
      label,
      color: colors[i],
      index: i,
    }));
    this.visibleTraces.set(this.columns.map(() => true));
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);
  }

  /* ------------------------------------------------- settings reactions --- */

  onAxisSettingChanged() {
    if (!this.chart) return;
    this.applyAxisRanges();
    this.chart.update('none');
  }

  onZoomSettingChanged() {
    if (!this.chart) return;
    (this.chart.options.plugins as any).zoom = this.zoomConfig();
    this.chart.update('none');
  }

  onPlotHeightChanged() {
    // Chart.js is responsive, but nudge it so the redraw is immediate.
    setTimeout(() => this.chart?.resize(), 0);
  }

  resetYLatch() {
    this.latchedMin = null;
    this.latchedMax = null;
    this.lockYAxis.set(false);
    this.onAxisSettingChanged();
  }

  clearManualY() {
    this.manualYMin.set(null);
    this.manualYMax.set(null);
    this.onAxisSettingChanged();
  }

  setWindow(seconds: number) {
    this.windowSeconds.set(seconds);
    this.onAxisSettingChanged();
  }

  /* ====================================================================== */
  /* CHECKLIST LEGEND                                                       */
  /* ====================================================================== */

  isTraceVisible(index: number): boolean {
    return this.visibleTraces()[index] !== false;
  }

  toggleTraceVisible(index: number) {
    const next = [...this.visibleTraces()];
    next[index] = next[index] === false;
    this.visibleTraces.set(next);
    this.isolatedTraceIndex.set(null); // an explicit choice overrides isolate
    this.applyTraceVisibility();
  }

  showAllTraces() {
    this.visibleTraces.set(this.columns.map(() => true));
    this.isolatedTraceIndex.set(null);
    this.applyTraceVisibility();
  }

  hideAllTraces() {
    this.visibleTraces.set(this.columns.map(() => false));
    this.isolatedTraceIndex.set(null);
    this.applyTraceVisibility();
  }

  invertTraceVisibility() {
    this.visibleTraces.set(this.visibleTraces().map((v) => v === false));
    this.isolatedTraceIndex.set(null);
    this.applyTraceVisibility();
  }

  visibleTraceCount(): number {
    return this.visibleTraces().filter((v) => v !== false).length;
  }

  onLegendSelect(index: number) {
    if (this.singleClickTimer) {
      clearTimeout(this.singleClickTimer);
      this.singleClickTimer = null;
    }
    this.singleClickTimer = setTimeout(() => {
      this.singleClickTimer = null;
      this.highlightTrace(index);
    }, 220);
  }

  onLegendIsolate(index: number) {
    if (this.singleClickTimer) {
      clearTimeout(this.singleClickTimer);
      this.singleClickTimer = null;
    }
    this.toggleIsolateTrace(index);
  }

  private toggleIsolateTrace(index: number) {
    if (!this.chart) return;
    const isSame = this.isolatedTraceIndex() === index;
    this.isolatedTraceIndex.set(isSame ? null : index);
    this.applyTraceVisibility();
    this.scrollToLegend(index);
  }

  private applyTraceVisibility() {
    if (!this.chart) return;
    const isolated = this.isolatedTraceIndex();
    const visible = this.visibleTraces();
    this.chart.data.datasets.forEach((ds, i) => {
      ds.hidden = isolated !== null ? i !== isolated : visible[i] === false;
    });
    this.applyAxisRanges(); // hiding a trace can change the y extent
    this.chart.update('none');
  }

  private highlightTrace(index: number) {
    if (!this.chart) return;
    const isSame = this.highlightedTraceIndex() === index;
    this.highlightedTraceIndex.set(isSame ? null : index);

    const current = this.highlightedTraceIndex();
    this.chart.data.datasets.forEach((ds, i) => {
      ds.borderWidth = current === null ? 2 : i === current ? 4 : 1;
    });
    this.chart.update('none');
    this.scrollToLegend(current ?? index);
  }

  private scrollToLegend(index: number) {
    if (!this.legendContainer) return;
    const container = this.legendContainer.nativeElement;
    const item = container.querySelector(`[data-legend-index="${index}"]`) as HTMLElement;
    item?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  /* ====================================================================== */
  /* WINDOW CONTROLS                                                        */
  /* ====================================================================== */

  close() {
    this.closed.emit();
  }

  toggleMinimize() {
    this.windowState.set(this.windowState() === 'minimized' ? 'normal' : 'minimized');
    setTimeout(() => this.chart?.resize(), 50);
  }

  toggleMaximize() {
    this.windowState.set(this.windowState() === 'maximized' ? 'normal' : 'maximized');
    // maximizing must float, or it would be clipped by the dock
    if (this.windowState() === 'maximized') this.floating.set(true);
    setTimeout(() => this.chart?.resize(), 50);
  }

  /** Tear the panel out of the dock into a free-floating window. */
  popOut(atX?: number, atY?: number) {
    if (this.floating()) return;
    const rect = (this.hostRect() ?? { top: 80, left: 200, width: 620 }) as {
      top: number;
      left: number;
      width: number;
    };
    this.width.set(Math.max(420, rect.width));
    this.top.set(atY ?? rect.top);
    this.left.set(atX ?? Math.max(12, rect.left - 40));
    this.floating.set(true);
    setTimeout(() => this.chart?.resize(), 50);
  }

  /** Return the panel to the dock stack. */
  dock() {
    this.floating.set(false);
    this.windowState.set('normal');
    setTimeout(() => this.chart?.resize(), 50);
  }

  private hostRect(): DOMRect | null {
    const el = this.legendContainer?.nativeElement?.closest('plot-panel') as HTMLElement | null;
    return el ? el.getBoundingClientRect() : null;
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      document.addEventListener('fullscreenchange', this.onFullscreenExit);
      this.isFullscreen = true;
      this.floating.set(true);
      this.windowState.set('maximized');
    } else {
      document.exitFullscreen();
    }
  }

  private handleFullscreenExit() {
    if (!document.fullscreenElement && this.isFullscreen) {
      this.isFullscreen = false;
      this.windowState.set('normal');
      document.removeEventListener('fullscreenchange', this.onFullscreenExit);
      setTimeout(() => this.chart?.resize(), 50);
    }
  }

  resetZoom() {
    this.chart?.resetZoom();
  }

  /* --- drag: dragging the title bar tears the panel out of the dock --- */

  onTitleBarMouseDown(event: MouseEvent) {
    if (this.windowState() === 'maximized') return;

    if (!this.floating()) {
      // tear out, positioning the window under the cursor
      const rect = this.hostRect();
      this.popOut(rect ? rect.left : event.clientX - 200, rect ? rect.top : event.clientY - 10);
    }

    this.dragging = true;
    this.dragOffsetX = event.clientX - this.left();
    this.dragOffsetY = event.clientY - this.top();
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(event: MouseEvent) {
    if (!this.dragging && !this.resizing) return;
    if (this.dragging) {
      this.left.set(event.clientX - this.dragOffsetX);
      this.top.set(event.clientY - this.dragOffsetY);
    }
    if (this.resizing) this.handleResize(event);
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp() {
    if (!this.dragging && !this.resizing) return;
    this.dragging = false;
    if (this.resizing) {
      this.resizing = false;
      setTimeout(() => this.chart?.resize(), 0);
    }
  }

  /* --- resize --- */

  onResizeStart(event: MouseEvent, edge: string) {
    if (this.windowState() === 'maximized') return;
    // vertical-only resize is meaningful while docked; horizontal needs floating
    if (!this.floating() && edge !== 'bottom') this.popOut();

    this.resizing = true;
    this.resizeEdge = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.width();
    this.resizeStartH = this.plotHeight();
    this.resizeStartTop = this.top();
    this.resizeStartLeft = this.left();
    event.preventDefault();
    event.stopPropagation();
  }

  private handleResize(event: MouseEvent) {
    const dx = event.clientX - this.resizeStartX;
    const dy = event.clientY - this.resizeStartY;

    if (this.floating()) {
      if (this.resizeEdge.includes('right')) {
        this.width.set(Math.max(360, this.resizeStartW + dx));
      }
      if (this.resizeEdge.includes('left')) {
        const newW = Math.max(360, this.resizeStartW - dx);
        this.left.set(this.resizeStartLeft + (this.resizeStartW - newW));
        this.width.set(newW);
      }
      if (this.resizeEdge.includes('top')) {
        const newH = Math.max(120, this.resizeStartH - dy);
        this.top.set(this.resizeStartTop + (this.resizeStartH - newH));
        this.plotHeight.set(newH);
      }
    }
    // Vertical edges drive the Plot height setting, so dragging and typing a
    // height stay in sync instead of fighting each other.
    if (this.resizeEdge.includes('bottom')) {
      this.plotHeight.set(Math.max(120, this.resizeStartH + dy));
    }
  }

  /* ====================================================================== */
  /* TOOLTIP (hold to reveal)                                               */
  /* ====================================================================== */

  onHover() {
    this.clearHoverTimer();
    if (this.tooltipActive) {
      this.tooltipActive = false;
      this.hideTooltipEl();
    }
    this.hoverTimer = setTimeout(() => {
      this.tooltipActive = true;
      this.chart?.update('none');
    }, 2000);
  }

  onHoverEnd() {
    this.clearHoverTimer();
    this.tooltipActive = false;
    this.hideTooltipEl();
  }

  private clearHoverTimer() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private get tooltipElId(): string {
    // per-panel id, so multiple open plots do not fight over one element
    return `plot-tooltip-${this.panelId}`;
  }

  private tooltipConfig(): any {
    return {
      enabled: false,
      external: (context: any) => {
        if (!this.tooltipActive) return;
        const tooltipEl = this.getOrCreateTooltipEl();
        const tooltipModel = context.tooltip;
        if (tooltipModel.opacity === 0) {
          tooltipEl.style.opacity = '0';
          return;
        }
        if (tooltipModel.body) {
          const titleLines = tooltipModel.title || [];
          const bodyLines = tooltipModel.body.map((b: any) => b.lines);
          let html = '';
          titleLines.forEach((t: string) => {
            html += `<div style="font-weight:700;margin-bottom:4px">${t}</div>`;
          });
          bodyLines.forEach((lines: string[], i: number) => {
            const color = tooltipModel.labelColors[i]?.borderColor || '#fff';
            lines.forEach((line: string) => {
              html += `<div style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;background:${color};border-radius:2px"></span>${line}</div>`;
            });
          });
          tooltipEl.innerHTML = html;
        }
        const pos = context.chart.canvas.getBoundingClientRect();
        tooltipEl.style.opacity = '1';
        tooltipEl.style.left = pos.left + window.scrollX + tooltipModel.caretX + 'px';
        tooltipEl.style.top = pos.top + window.scrollY + tooltipModel.caretY + 'px';
      },
    };
  }

  private getOrCreateTooltipEl(): HTMLElement {
    let el = document.getElementById(this.tooltipElId);
    if (!el) {
      el = document.createElement('div');
      el.id = this.tooltipElId;
      el.style.cssText =
        'position:absolute;background:rgba(30,41,59,0.92);color:#fff;border-radius:6px;' +
        'padding:8px 12px;font-size:12px;pointer-events:none;transition:opacity .15s;' +
        'z-index:9999;opacity:0';
      document.body.appendChild(el);
    }
    return el;
  }

  private hideTooltipEl() {
    const el = document.getElementById(this.tooltipElId);
    if (el) el.style.opacity = '0';
  }

  private removeTooltipEl() {
    document.getElementById(this.tooltipElId)?.remove();
  }

  /** True when this panel is showing a static file (used to hide the window UI). */
  isStatic = computed(() => this.sourceMode() === 'static');

  /** Convenience for the template: is this a CSV file source? */
  get isFileSource(): boolean {
    return this.source() instanceof CsvFileSource;
  }
}
