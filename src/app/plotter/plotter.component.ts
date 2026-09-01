import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  model,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import {
  CsvFileSource,
  HttpPollWaveformSource,
  SerialWaveformSource,
  SseWaveformSource,
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  WaveformSourceMeta,
  WaveformSourceState,
  WebSocketWaveformSource,
  isWebSerialSupported,
} from '../data-sources';
import { computeXWindow, computeYRange } from './axis-range';

/** One entry in the checklist legend. */
export interface TraceLegendItem {
  label: string;
  color: string;
  index: number;
}

/** Transports offered by the built-in source picker. */
export type SourcePickerKind = 'file' | 'websocket' | 'sse' | 'http' | 'serial';

/**
 * DATAPLOTTER
 * -----------
 * Renders waveforms from any `WaveformSource`: an uploaded CSV, a WebSocket or
 * SSE feed from the testbed, a polled HTTP log, or a direct serial link.
 *
 * HMI integration — add to any standalone component's `imports`:
 *
 *   <datalogger-dataplotter #plot [windowSeconds]="2" [plotHeight]="420" />
 *
 * then drive it programmatically:
 *
 *   plot.attachSource(new WebSocketWaveformSource({ url: 'ws://testbed/telemetry' }));
 *   plot.plotCsvText(csvString, 'run-42.csv');   // no file dialog needed
 *   plot.plotFile(file);                          // pass a File straight in
 */
@Component({
  selector: 'datalogger-dataplotter',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './plotter.component.html',
  styleUrl: './plotter.component.css',
})
export class DataPlotter implements OnDestroy {
  @ViewChild('plotterCanvas') plotterCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('plotterLegendContainer') plotterLegendContainer!: ElementRef<HTMLDivElement>;

  /* ------------------------------------------------ HMI-facing settings --- */

  /**
   * Sliding x-window in seconds for streaming sources.
   * `0` = no window: the axis keeps rescaling to fit everything received.
   * Ignored for static files, which always plot the full record.
   */
  readonly windowSeconds = model(0);

  /** Fixed pixel height of the plot area. */
  readonly plotHeight = model(420);

  /** Y range only ever grows — a new min/max is kept, never shrunk back. */
  readonly latchYAxis = model(true);

  /** Freeze the y range exactly where it is now. */
  readonly lockYAxis = model(false);

  /** Manual y bounds. Both set = axis hard-pinned to them. */
  readonly manualYMin = model<number | null>(null);
  readonly manualYMax = model<number | null>(null);

  /** Zoom/pan enable per axis. */
  readonly zoomHorizontal = model(true);
  readonly zoomVertical = model(true);

  /** Max samples retained per trace for streaming sources. */
  readonly maxBufferPoints = model(20000);

  /* ------------------------------------------------------ source picker --- */

  pickerKind = signal<SourcePickerKind>('file');
  wsUrl = signal('ws://localhost:8080/telemetry');
  sseUrl = signal('http://localhost:4000/api/stream');
  httpUrl = signal('http://localhost:4000/api/download');
  httpIntervalMs = signal(1000);
  serialBaud = signal(115200);
  serialSynthesiseTime = signal(false);
  readonly serialSupported = isWebSerialSupported();

  /* ------------------------------------------------------- plotter state --- */

  sourceLabel = signal('');
  sourceMode = signal<'static' | 'stream' | null>(null);
  sourceState = signal<WaveformSourceState>('idle');
  sourceDetail = signal('');
  plotterErrorMessage = signal('');

  plotterFileName = signal('');
  plotterFileContent = signal('');
  parsedPlotterText = signal('');
  plotterDataLoaded = signal(false);
  plotterVisible = signal(false);

  sampleCount = signal(0);
  latestTime = signal(0);

  /** `Ready` once there is something plottable. */
  plotterStatus = computed<'N/A' | 'Ready' | 'Error'>(() => {
    if (this.sourceState() === 'error') return 'Error';
    return this.plotterDataLoaded() ? 'Ready' : 'N/A';
  });

  plotterStatusMessage = computed(() => {
    if (this.plotterErrorMessage()) return this.plotterErrorMessage();
    if (this.sourceDetail()) return this.sourceDetail();
    return this.plotterDataLoaded() ? 'Data ready' : 'No data attached';
  });

  // overlay window state
  plotterWindowState = signal<'normal' | 'minimized' | 'maximized'>('normal');
  plotterWidth = 900;
  plotterTop = 60;
  plotterLeft = 80;

  // legend / trace state
  plotterLegendItems: TraceLegendItem[] = [];
  visibleTraces = signal<boolean[]>([]);
  highlightedTraceIndex = signal<number | null>(null);
  isolatedTraceIndex = signal<number | null>(null);

  /* ------------------------------------------------------------ internals --- */

  private static pluginRegistered = false;

  private source: WaveformSource | null = null;
  private chart: Chart | null = null;

  private columns: string[] = [];
  private labels: number[] = [];
  private series: number[][] = [];
  private xAxisLabel = 'Time';
  private yAxisLabel = 'Value';

  // latched y bounds across the whole session
  private latchedMin: number | null = null;
  private latchedMax: number | null = null;

  // coalesce chart redraws so a fast feed cannot outrun the renderer
  private redrawQueued = false;

  // dragging / resizing
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

  // tooltip hold-to-reveal
  private plotterHoverTimer: any = null;
  private plotterTooltipActive = false;
  private isPlotterFullscreen = false;
  private singleClickTimer: any = null;
  private onPlotterFullscreenExit = () => this.handlePlotterFullscreenExit();

  constructor() {
    // Registering at module scope breaks SSR prerender, so do it lazily once.
    if (!DataPlotter.pluginRegistered) {
      Chart.register(zoomPlugin);
      DataPlotter.pluginRegistered = true;
    }
  }

  /* ====================================================================== */
  /* PUBLIC API — what the HMI calls                                        */
  /* ====================================================================== */

  /** Attach any source. Replaces the current one. */
  async attachSource(source: WaveformSource, autoOpen = true): Promise<void> {
    this.detachSource();

    this.source = source;
    this.sourceLabel.set(source.label);
    this.sourceMode.set(source.mode);
    this.plotterErrorMessage.set('');
    this.clearBuffers();

    if (autoOpen) {
      this.plotterVisible.set(true);
      this.plotterWindowState.set('normal');
    }

    await source.connect(this.sourceEvents());
  }

  /** Stop and release the current source. */
  detachSource(): void {
    this.source?.disconnect();
    this.source = null;
  }

  /** Plot a `File` handed over by the host — no file dialog required. */
  async plotFile(file: File): Promise<void> {
    const src = new CsvFileSource(file);
    this.plotterFileName.set(file.name);
    await this.attachSource(src, false);
    this.captureStaticText(src);
  }

  /** Plot raw CSV text handed over by the host. */
  async plotCsvText(text: string, label = 'Provided data'): Promise<void> {
    const src = new CsvFileSource(text, label);
    this.plotterFileName.set(label);
    await this.attachSource(src, false);
    this.captureStaticText(src);
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
  /* SOURCE EVENT HANDLING                                                  */
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
    if (state === 'error' && detail) this.plotterErrorMessage.set(detail);
    if (state === 'connected') this.plotterErrorMessage.set('');
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
    this.plotterDataLoaded.set(this.labels.length > 0);
    this.sampleCount.set(this.labels.length);
    if (!this.chart) this.rebuildChart();
    else this.queueRedraw();
  }

  private handleSample(sample: WaveformSample) {
    this.pushSample(sample);
    this.plotterDataLoaded.set(true);
    this.sampleCount.set(this.labels.length);
    if (!this.chart) {
      this.rebuildChart();
      return;
    }
    this.queueRedraw();
  }

  /** Append one sample, trimming the ring buffer. */
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
      this.plotterLegendItems = [];
      this.visibleTraces.set([]);
    }
    this.latchedMin = null;
    this.latchedMax = null;
    this.sampleCount.set(0);
    this.latestTime.set(0);
    this.plotterDataLoaded.set(false);
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);

    if (this.chart) {
      this.chart.data.labels = [];
      this.chart.data.datasets.forEach((ds) => (ds.data = []));
      this.chart.update('none');
    }
  }

  /** Remember raw/parsed text for the detail panels after a static load. */
  private captureStaticText(src: CsvFileSource) {
    this.plotterFileContent.set(src.rawText);
    this.parsedPlotterText.set(
      JSON.stringify({ columns: this.columns, rows: this.labels.length }, null, 2),
    );
  }

  /* ====================================================================== */
  /* SOURCE PICKER (UI)                                                     */
  /* ====================================================================== */

  async onPlotterFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await this.plotFile(file);
    input.value = '';
  }

  /** Connect the transport chosen in the picker. */
  async connectPickedSource() {
    this.plotterErrorMessage.set('');

    switch (this.pickerKind()) {
      case 'websocket':
        await this.attachSource(
          new WebSocketWaveformSource({ url: this.wsUrl().trim() }),
        );
        break;
      case 'sse':
        await this.attachSource(new SseWaveformSource({ url: this.sseUrl().trim() }));
        break;
      case 'http':
        await this.attachSource(
          new HttpPollWaveformSource({
            url: this.httpUrl().trim(),
            intervalMs: Number(this.httpIntervalMs()) || 1000,
          }),
        );
        break;
      case 'serial':
        await this.attachSource(
          new SerialWaveformSource({
            baudRate: Number(this.serialBaud()) || 115200,
            synthesiseTime: this.serialSynthesiseTime(),
          }),
        );
        break;
      case 'file':
        this.plotterErrorMessage.set('Choose a CSV file above to plot a static record.');
        break;
    }
  }

  disconnectSource() {
    this.detachSource();
    this.sourceState.set('closed');
    this.sourceDetail.set('Source detached');
  }

  /** Show the overlay for data that is already loaded. */
  displayPlotterWaveform() {
    if (!this.plotterDataLoaded()) {
      this.plotterErrorMessage.set('No data to display. Load a file or connect a live source first.');
      return;
    }
    this.plotterErrorMessage.set('');
    this.plotterVisible.set(true);
    this.plotterWindowState.set('normal');
    setTimeout(() => this.rebuildChart(), 0);
  }

  /* ====================================================================== */
  /* CHART                                                                  */
  /* ====================================================================== */

  private rebuildChart(attempt = 0) {
    if (!this.plotterVisible() || this.columns.length === 0) return;

    // canvas only exists once the overlay has rendered
    if (!this.plotterCanvas) {
      if (attempt < 20) setTimeout(() => this.rebuildChart(attempt + 1), 50);
      return;
    }
    const ctx = this.plotterCanvas.nativeElement.getContext('2d');
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
          if (elements.length > 0) this.highlightPlotterTrace(elements[0].datasetIndex);
        },
        plugins: {
          tooltip: this.plotterTooltipConfig(),
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

  /** Push buffers onto the chart, then window and scale the axes. */
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

  /**
   * Compute the x window and y bounds.
   *
   * x: streaming sources get a fixed `windowSeconds` window anchored to the
   *    newest sample; `0` (or any static source) fits all data.
   * y: manual bounds win, then lock, then latching (grow-only), then autoscale.
   */
  private applyAxisRanges() {
    const chart = this.chart;
    if (!chart || this.labels.length === 0) return;

    const xScale = chart.options.scales?.['x'] as any;
    const yScale = chart.options.scales?.['y'] as any;
    if (!xScale || !yScale) return;

    // ---- X ----
    const xWindow = computeXWindow(
      this.labels[0],
      this.labels[this.labels.length - 1],
      this.effectiveWindowSeconds(),
    );
    xScale.min = xWindow.min;
    xScale.max = xWindow.max;

    // ---- Y ----
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
    this.plotterLegendItems = this.columns.map((label, i) => ({
      label,
      color: colors[i],
      index: i,
    }));
    this.visibleTraces.set(this.columns.map(() => true));
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);
  }

  /* ------------------------------------------------- settings reactions --- */

  /** Called by the controls; re-applies axis config to the live chart. */
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

  /** Drop latched bounds so the axis re-learns from current data. */
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

  /* ====================================================================== */
  /* CHECKLIST LEGEND                                                       */
  /* ====================================================================== */

  isTraceVisible(index: number): boolean {
    return this.visibleTraces()[index] !== false;
  }

  /** Checkbox toggle — controls what stays on screen. */
  toggleTraceVisible(index: number) {
    const next = [...this.visibleTraces()];
    next[index] = next[index] === false;
    this.visibleTraces.set(next);
    // an explicit choice overrides isolate mode
    this.isolatedTraceIndex.set(null);
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

  // single click = highlight, double click = isolate
  onPlotterLegendSelect(index: number) {
    if (this.singleClickTimer) {
      clearTimeout(this.singleClickTimer);
      this.singleClickTimer = null;
    }
    this.singleClickTimer = setTimeout(() => {
      this.singleClickTimer = null;
      this.highlightPlotterTrace(index);
    }, 220);
  }

  onPlotterLegendIsolate(index: number) {
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
    this.scrollToPlotterLegend(index);
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

  private highlightPlotterTrace(index: number) {
    if (!this.chart) return;
    const isSame = this.highlightedTraceIndex() === index;
    this.highlightedTraceIndex.set(isSame ? null : index);

    const current = this.highlightedTraceIndex();
    this.chart.data.datasets.forEach((ds, i) => {
      ds.borderWidth = current === null ? 2 : i === current ? 4 : 1;
    });
    this.chart.update('none');
    this.scrollToPlotterLegend(current ?? index);
  }

  private scrollToPlotterLegend(index: number) {
    if (!this.plotterLegendContainer) return;
    const container = this.plotterLegendContainer.nativeElement;
    const item = container.querySelector(`[data-legend-index="${index}"]`) as HTMLElement;
    item?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  /* ====================================================================== */
  /* OVERLAY WINDOW                                                         */
  /* ====================================================================== */

  closePlotter() {
    this.plotterVisible.set(false);
    this.chart?.destroy();
    this.chart = null;
  }

  minimizePlotter() {
    this.plotterWindowState.set('minimized');
  }

  restorePlotter() {
    this.plotterWindowState.set('normal');
    setTimeout(() => this.chart?.resize(), 50);
  }

  maximizePlotter() {
    this.plotterWindowState.set(
      this.plotterWindowState() === 'maximized' ? 'normal' : 'maximized',
    );
    setTimeout(() => this.chart?.resize(), 50);
  }

  fullscreenPlotter() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      document.addEventListener('fullscreenchange', this.onPlotterFullscreenExit);
      this.isPlotterFullscreen = true;
      this.plotterWindowState.set('maximized');
    } else {
      document.exitFullscreen();
    }
  }

  private handlePlotterFullscreenExit() {
    if (!document.fullscreenElement && this.isPlotterFullscreen) {
      this.isPlotterFullscreen = false;
      this.plotterWindowState.set('normal');
      document.removeEventListener('fullscreenchange', this.onPlotterFullscreenExit);
      setTimeout(() => this.chart?.resize(), 50);
    }
  }

  resetPlotterZoom() {
    this.chart?.resetZoom();
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.onPlotterFullscreenExit);
    this.detachSource();
    this.chart?.destroy();
    if (this.plotterHoverTimer) clearTimeout(this.plotterHoverTimer);
    if (this.singleClickTimer) clearTimeout(this.singleClickTimer);
  }

  // --- drag ---
  onPlotterTitleBarMouseDown(event: MouseEvent) {
    if (this.plotterWindowState() === 'maximized') return;
    this.dragging = true;
    this.dragOffsetX = event.clientX - this.plotterLeft;
    this.dragOffsetY = event.clientY - this.plotterTop;
    event.preventDefault();
  }

  onPlotterMouseMove(event: MouseEvent) {
    if (this.dragging) {
      this.plotterLeft = event.clientX - this.dragOffsetX;
      this.plotterTop = event.clientY - this.dragOffsetY;
    }
    if (this.resizing) this.handlePlotterResize(event);
  }

  onPlotterMouseUp() {
    this.dragging = false;
    if (this.resizing) {
      this.resizing = false;
      setTimeout(() => this.chart?.resize(), 0);
    }
  }

  // --- resize ---
  onPlotterResizeStart(event: MouseEvent, edge: string) {
    if (this.plotterWindowState() === 'maximized') return;
    this.resizing = true;
    this.resizeEdge = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.plotterWidth;
    this.resizeStartH = this.plotHeight();
    this.resizeStartTop = this.plotterTop;
    this.resizeStartLeft = this.plotterLeft;
    event.preventDefault();
    event.stopPropagation();
  }

  private handlePlotterResize(event: MouseEvent) {
    const dx = event.clientX - this.resizeStartX;
    const dy = event.clientY - this.resizeStartY;

    if (this.resizeEdge.includes('right')) {
      this.plotterWidth = Math.max(400, this.resizeStartW + dx);
    }
    // Vertical edges drive the Plot height setting, so dragging the window and
    // typing a height stay in sync instead of fighting each other.
    if (this.resizeEdge.includes('bottom')) {
      this.plotHeight.set(Math.max(200, this.resizeStartH + dy));
    }
    if (this.resizeEdge.includes('left')) {
      const newW = Math.max(400, this.resizeStartW - dx);
      this.plotterLeft = this.resizeStartLeft + (this.resizeStartW - newW);
      this.plotterWidth = newW;
    }
    if (this.resizeEdge.includes('top')) {
      const newH = Math.max(200, this.resizeStartH - dy);
      this.plotterTop = this.resizeStartTop + (this.resizeStartH - newH);
      this.plotHeight.set(newH);
    }
  }

  /* ====================================================================== */
  /* TOOLTIP (hold to reveal)                                               */
  /* ====================================================================== */

  onPlotterHover() {
    this.clearPlotterHoverTimer();
    if (this.plotterTooltipActive) {
      this.plotterTooltipActive = false;
      this.hidePlotterTooltipEl();
    }
    this.plotterHoverTimer = setTimeout(() => {
      this.plotterTooltipActive = true;
      this.chart?.update('none');
    }, 2000);
  }

  onPlotterHoverEnd() {
    this.clearPlotterHoverTimer();
    this.plotterTooltipActive = false;
    this.hidePlotterTooltipEl();
  }

  private clearPlotterHoverTimer() {
    if (this.plotterHoverTimer) {
      clearTimeout(this.plotterHoverTimer);
      this.plotterHoverTimer = null;
    }
  }

  private plotterTooltipConfig(): any {
    return {
      enabled: false,
      external: (context: any) => {
        if (!this.plotterTooltipActive) return;
        const tooltipEl = this.getOrCreatePlotterTooltipEl();
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

  private getOrCreatePlotterTooltipEl(): HTMLElement {
    let el = document.getElementById('dataplotter-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dataplotter-tooltip';
      el.style.cssText =
        'position:absolute;background:rgba(30,41,59,0.92);color:#fff;border-radius:6px;' +
        'padding:8px 12px;font-size:12px;pointer-events:none;transition:opacity .15s;' +
        'z-index:9999;opacity:0';
      document.body.appendChild(el);
    }
    return el;
  }

  private hidePlotterTooltipEl() {
    const el = document.getElementById('dataplotter-tooltip');
    if (el) el.style.opacity = '0';
  }
}
