import { Component, signal, viewChildren } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  CsvFileSource,
  HttpPollWaveformSource,
  SerialWaveformSource,
  SseWaveformSource,
  WaveformSample,
  WaveformSource,
  WebSocketWaveformSource,
  isWebSerialSupported,
} from '../data-sources';
import { PlotPanel } from './plot-panel.component';
import { DEFAULT_PLOT_SETTINGS, PlotSettings } from './plot-settings';

/** Transports offered by the built-in source picker. */
export type SourcePickerKind = 'file' | 'websocket' | 'sse' | 'http' | 'serial';

/** An open plot container. */
export interface PlotInstance {
  id: number;
  source: WaveformSource;
  title: string;
  settings: PlotSettings;
}

/**
 * DATAPLOTTER
 * -----------
 * Control panel for opening plots, plus the right-hand dock that holds them.
 *
 * Each plot is an independent `<plot-panel>` with its own source, chart and
 * view settings, so several captures can be watched at once. Panels are docked
 * on the right and never modal — the operator can keep working elsewhere in the
 * HMI with plots left open — and any panel can be torn out into a floating
 * window.
 *
 * HMI integration — add to any standalone component's `imports`:
 *
 *   <datalogger-dataplotter #plot />
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
  imports: [FormsModule, PlotPanel],
  templateUrl: './plotter.component.html',
  styleUrl: './plotter.component.css',
})
export class DataPlotter {
  /** Live references to the open panels, for snapshot()/close(). */
  readonly panels = viewChildren(PlotPanel);

  /* ------------------------------------------------------- open plots --- */

  plots = signal<PlotInstance[]>([]);
  private plotSeq = 0;

  /** Width of the right dock, draggable via its left edge. */
  dockWidth = signal(560);
  dockCollapsed = signal(false);

  /* ------------------------------------------- defaults for NEW plots --- */

  defaultWindowSeconds = signal(DEFAULT_PLOT_SETTINGS.windowSeconds);
  defaultPlotHeight = signal(DEFAULT_PLOT_SETTINGS.plotHeight);
  defaultLatchYAxis = signal(DEFAULT_PLOT_SETTINGS.latchYAxis);
  defaultZoomHorizontal = signal(DEFAULT_PLOT_SETTINGS.zoomHorizontal);
  defaultZoomVertical = signal(DEFAULT_PLOT_SETTINGS.zoomVertical);
  defaultMaxBufferPoints = signal(DEFAULT_PLOT_SETTINGS.maxBufferPoints);

  private currentDefaults(): PlotSettings {
    return {
      windowSeconds: Number(this.defaultWindowSeconds()) || 0,
      plotHeight: Number(this.defaultPlotHeight()) || DEFAULT_PLOT_SETTINGS.plotHeight,
      latchYAxis: this.defaultLatchYAxis(),
      lockYAxis: false,
      manualYMin: null,
      manualYMax: null,
      zoomHorizontal: this.defaultZoomHorizontal(),
      zoomVertical: this.defaultZoomVertical(),
      maxBufferPoints: Number(this.defaultMaxBufferPoints()) || 20000,
    };
  }

  /* ------------------------------------------------------ source picker --- */

  pickerKind = signal<SourcePickerKind>('file');
  wsUrl = signal('ws://localhost:8080/telemetry');
  sseUrl = signal('http://localhost:4000/api/stream');
  httpUrl = signal('http://localhost:4000/api/download');
  httpIntervalMs = signal(1000);
  serialBaud = signal(115200);
  serialSynthesiseTime = signal(false);
  readonly serialSupported = isWebSerialSupported();

  pickerError = signal('');

  /* ====================================================================== */
  /* PUBLIC API — what the HMI calls                                        */
  /* ====================================================================== */

  /**
   * Open a new plot for `source`. Existing plots are left running, so several
   * feeds can be watched side by side.
   * @returns the new plot's id, for `closePlot()`.
   */
  attachSource(source: WaveformSource, title?: string): number {
    const id = ++this.plotSeq;
    this.plots.update((list) => [
      ...list,
      { id, source, title: title ?? source.label, settings: this.currentDefaults() },
    ]);
    this.dockCollapsed.set(false);
    return id;
  }

  /** Close one plot, disconnecting its source. */
  closePlot(id: number) {
    this.plots.update((list) => list.filter((p) => p.id !== id));
  }

  /** Close every open plot. */
  closeAll() {
    this.plots.set([]);
  }

  /** Plot a `File` handed over by the host — no file dialog required. */
  plotFile(file: File): number {
    return this.attachSource(new CsvFileSource(file), file.name);
  }

  /** Plot raw CSV text handed over by the host. */
  plotCsvText(text: string, label = 'Provided data'): number {
    return this.attachSource(new CsvFileSource(text, label), label);
  }

  /**
   * Buffered samples of the newest plot, or of `id` when given.
   * Returns `null` if that plot is not open.
   */
  snapshot(id?: number): { columns: string[]; samples: WaveformSample[] } | null {
    const list = this.plots();
    const target = id ?? list[list.length - 1]?.id;
    if (target === undefined) return null;
    const index = list.findIndex((p) => p.id === target);
    return index >= 0 ? (this.panels()[index]?.snapshot() ?? null) : null;
  }

  /* ====================================================================== */
  /* SOURCE PICKER (UI)                                                     */
  /* ====================================================================== */

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length) return;
    // multiple files -> one plot each, so records can be compared
    for (const file of Array.from(files)) this.plotFile(file);
    input.value = '';
  }

  /** Open a plot for the transport chosen in the picker. */
  connectPickedSource() {
    this.pickerError.set('');

    switch (this.pickerKind()) {
      case 'websocket': {
        const url = this.wsUrl().trim();
        if (!url) return this.pickerError.set('Enter a WebSocket URL.');
        this.attachSource(new WebSocketWaveformSource({ url }));
        break;
      }
      case 'sse': {
        const url = this.sseUrl().trim();
        if (!url) return this.pickerError.set('Enter an SSE URL.');
        this.attachSource(new SseWaveformSource({ url }));
        break;
      }
      case 'http': {
        const url = this.httpUrl().trim();
        if (!url) return this.pickerError.set('Enter an HTTP URL.');
        this.attachSource(
          new HttpPollWaveformSource({
            url,
            intervalMs: Number(this.httpIntervalMs()) || 1000,
          }),
        );
        break;
      }
      case 'serial':
        this.attachSource(
          new SerialWaveformSource({
            baudRate: Number(this.serialBaud()) || 115200,
            synthesiseTime: this.serialSynthesiseTime(),
          }),
        );
        break;
      case 'file':
        this.pickerError.set('Choose one or more CSV files above to plot.');
        break;
    }
  }

  /* ------------------------------------------------------------- dock UI --- */

  private dockResizing = false;
  private dockStartX = 0;
  private dockStartW = 0;

  onDockResizeStart(event: MouseEvent) {
    this.dockResizing = true;
    this.dockStartX = event.clientX;
    this.dockStartW = this.dockWidth();
    event.preventDefault();

    const move = (e: MouseEvent) => {
      if (!this.dockResizing) return;
      // dragging left widens the dock
      const next = this.dockStartW - (e.clientX - this.dockStartX);
      this.dockWidth.set(Math.min(1200, Math.max(320, next)));
    };
    const up = () => {
      this.dockResizing = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      // let panels reflow before Chart.js re-measures
      setTimeout(() => this.panels().forEach((p) => p.onPlotHeightChanged()), 0);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}
