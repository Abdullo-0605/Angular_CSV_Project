import { Component, ElementRef, signal, ViewChild, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';
import { LiveDataService, LiveRow, LiveStatus, LiveMeta } from './live-data.service';

Chart.register(zoomPlugin);

interface ParsedPlotterData { // structured format for imported data file
  headers: string[];
  rows: number[][];
}

interface PlotterWaveformData { // format for waveform rendering
  labels: number[];
  datasets: { label: string; data: number[] }[];
  xAxisLabel: string;
}

// (FRONTEND) - When Index.html runs, this is the first thing that loads
@Component({
  selector: 'datalogger-dataplotter',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})

// BACKEND CLASS — DataPlotter (part of DataLogger module)
export class DataPlotter implements OnInit, OnDestroy {
  private live = inject(LiveDataService);
  private onPlotterFullscreenExit = () => this.handlePlotterFullscreenExit();
  @ViewChild('plotterCanvas') plotterCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('plotterLegendContainer') plotterLegendContainer!: ElementRef<HTMLDivElement>;

  plotterFileName = signal('');
  plotterFileContent = signal('');
  parsedPlotterText = signal('');
  plotterStatus = signal<'N/A' | 'Ready' | 'Error'>('N/A');
  plotterStatusMessage = signal('No data uploaded');
  plotterDataLoaded = signal(false);
  plotterVisible = signal(false);
  plotterErrorMessage = signal('');

  // dataplotter overlay window state
  plotterWindowState = signal<'normal' | 'minimized' | 'maximized'>('normal');
  plotterWidth = 900;
  plotterHeight = 550;
  plotterTop = 80;
  plotterLeft = 100;

  // dragging state
  private dragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  // resizing state
  private resizing = false;
  private resizeEdge = '';
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartW = 0;
  private resizeStartH = 0;
  private resizeStartTop = 0;
  private resizeStartLeft = 0;

  // dataplotter internals
  private plotterChart: Chart | null = null;
  private plotterData: PlotterWaveformData | null = null;
  highlightedTraceIndex = signal<number | null>(null);
  // when set, only this trace is displayed (double-click a legend to isolate)
  isolatedTraceIndex = signal<number | null>(null);
  plotterLegendItems: { label: string; color: string; index: number }[] = [];

  // dataplotter tooltip hold timer
  private plotterHoverTimer: any = null;
  private plotterTooltipActive = false;
  private isPlotterFullscreen = false;

  // --- LIVE CAPTURE STATE (fed by the testbed data server) ---
  liveConnected = this.live.connected;
  liveStatus = signal<LiveStatus | null>(null);
  availableLogs = signal<string[]>([]);
  selectedLogs = signal<string[]>([]);
  logFilter = signal('');
  liveError = signal('');
  liveMode = signal(false); // true when the chart is showing the live feed

  // live capture form inputs (bound in the template)
  startWatts = signal(0);
  endWatts = signal(50);
  rampSeconds = signal(10);
  intervalMs = signal(100);
  durationSeconds = signal(0); // 0 = run until stopped
  scheduledTime = signal(''); // datetime-local string; empty = start now

  // a 1s heartbeat used to render the scheduled-start countdown
  nowMs = signal(Date.now());
  private clockTimer: any = null;

  // live chart buffers
  private liveColumns: string[] = [];
  private liveLabels: number[] = [];
  private liveSeries: number[][] = [];
  private readonly maxLivePoints = 1000;
  private singleClickTimer: any = null;

  // ============================================================
  // LIVE CAPTURE — real-time generator feed from the data server
  // ============================================================
  ngOnInit() {
    // wire stream callbacks
    this.live.onMeta = (meta) => this.handleLiveMeta(meta);
    this.live.onSnapshot = (rows) => this.applyLiveSnapshot(rows);
    this.live.onRow = (row) => this.appendLiveRow(row);
    this.live.onReset = () => this.clearLiveData();
    this.live.onStatus = (status) => this.liveStatus.set(status);

    // load selectable logs + open the live stream
    this.live
      .fetchLogs()
      .then((cols) => {
        this.availableLogs.set(cols);
        // sensible default: capture the first named channel
        if (this.selectedLogs().length === 0 && cols.length) {
          this.selectedLogs.set([cols[0]]);
        }
      })
      .catch(() => this.liveError.set('Data server offline — run "npm run start:data" to enable Live Capture.'));

    this.live.connectStream();

    // tick a clock for the scheduled-start countdown
    if (typeof window !== 'undefined') {
      this.clockTimer = setInterval(() => this.nowMs.set(Date.now()), 1000);
    }
  }

  // --- log selection helpers ---
  filteredLogs(): string[] {
    const q = this.logFilter().trim().toLowerCase();
    const all = this.availableLogs();
    return q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  }

  isLogSelected(name: string): boolean {
    return this.selectedLogs().includes(name);
  }

  toggleLog(name: string) {
    const set = new Set(this.selectedLogs());
    set.has(name) ? set.delete(name) : set.add(name);
    this.selectedLogs.set([...set]);
  }

  selectOnlyLog(name: string) {
    this.selectedLogs.set([name]);
  }

  selectAllLogs() {
    this.selectedLogs.set([...this.availableLogs()]);
  }

  clearSelectedLogs() {
    this.selectedLogs.set([]);
  }

  // --- capture controls ---
  async startLive() {
    this.liveError.set('');
    const logs = this.selectedLogs();
    if (logs.length === 0) {
      this.liveError.set('Select at least one log to capture.');
      return;
    }

    const scheduled = this.scheduledTime();
    let startEpochMs: number | undefined;
    if (scheduled) {
      const t = new Date(scheduled).getTime();
      if (Number.isFinite(t)) startEpochMs = t;
    }

    const config = {
      intervalMs: Number(this.intervalMs()) || 100,
      startWatts: Number(this.startWatts()) || 0,
      endWatts: Number(this.endWatts()) || 0,
      rampSeconds: Number(this.rampSeconds()) || 0,
      durationSeconds: Number(this.durationSeconds()) || 0,
      selectedLogs: logs,
      startEpochMs,
    };

    // open the overlay so the waveform builds live, then start the server
    this.liveMode.set(true);
    this.plotterVisible.set(true);
    this.plotterWindowState.set('normal');
    this.plotterErrorMessage.set('');

    try {
      await this.live.start(config);
    } catch {
      this.liveError.set('Could not reach the data server. Is "npm run start:data" running?');
    }
  }

  async stopLive() {
    try {
      await this.live.stop();
    } catch {
      this.liveError.set('Could not reach the data server.');
    }
  }

  async resetLive() {
    try {
      await this.live.reset();
    } catch {
      this.liveError.set('Could not reach the data server.');
    }
  }

  downloadLive() {
    if (typeof window !== 'undefined') {
      window.open(this.live.downloadUrl(), '_blank');
    }
  }

  // seconds remaining until a scheduled capture starts (null if not scheduled)
  scheduledCountdown(): number | null {
    const status = this.liveStatus();
    if (!status || status.status !== 'scheduled' || !status.scheduledFor) return null;
    return Math.max(0, Math.ceil((status.scheduledFor - this.nowMs()) / 1000));
  }

  isLiveRunning(): boolean {
    const s = this.liveStatus()?.status;
    return s === 'running' || s === 'scheduled';
  }

  // --- live stream handlers ---
  private handleLiveMeta(meta: LiveMeta) {
    this.liveColumns = meta.columns ?? [];
    // only (re)build once we're in live mode, the overlay is open, and there
    // are columns to draw (ignore the empty meta sent on initial connect).
    if (!this.liveMode() || !this.plotterVisible() || this.liveColumns.length === 0) {
      return;
    }
    this.buildLiveChart(this.liveColumns);
  }

  private applyLiveSnapshot(rows: LiveRow[]) {
    if (!this.liveMode()) return;
    this.liveLabels = [];
    this.liveSeries = this.liveColumns.map(() => []);
    for (const row of rows) {
      this.pushLiveRow(row);
    }
    if (!this.plotterChart) {
      this.buildLiveChart(this.liveColumns);
    } else {
      this.refreshLiveChartData();
    }
  }

  private appendLiveRow(row: LiveRow) {
    if (!this.liveMode()) return;
    if (!this.plotterChart) {
      // chart not ready yet — buffer the point, it will render once built
      if (this.liveSeries.length === 0 && this.liveColumns.length) {
        this.liveSeries = this.liveColumns.map(() => []);
      }
      this.pushLiveRow(row);
      return;
    }
    this.pushLiveRow(row);
    this.refreshLiveChartData();
  }

  // push one row into the rolling buffers (trimming to maxLivePoints)
  private pushLiveRow(row: LiveRow) {
    if (this.liveSeries.length !== this.liveColumns.length) {
      this.liveSeries = this.liveColumns.map(() => []);
    }
    this.liveLabels.push(row.time);
    for (let i = 0; i < this.liveColumns.length; i++) {
      this.liveSeries[i].push(row.values[i] ?? NaN);
    }
    if (this.liveLabels.length > this.maxLivePoints) {
      this.liveLabels.shift();
      for (const s of this.liveSeries) s.shift();
    }
  }

  private clearLiveData() {
    this.liveLabels = [];
    this.liveSeries = this.liveColumns.map(() => []);
    if (this.plotterChart && this.liveMode()) {
      this.plotterChart.data.labels = [];
      this.plotterChart.data.datasets.forEach((ds) => (ds.data = []));
      this.plotterChart.update('none');
    }
  }

  // push the current buffers onto the chart and slide the x-window
  private refreshLiveChartData() {
    const chart = this.plotterChart;
    if (!chart) return;
    chart.data.labels = this.liveLabels;
    this.liveSeries.forEach((series, i) => {
      if (chart.data.datasets[i]) chart.data.datasets[i].data = series;
    });
    const xScale = chart.options.scales?.['x'] as any;
    if (this.liveLabels.length > 1 && xScale) {
      xScale.min = this.liveLabels[0];
      xScale.max = this.liveLabels[this.liveLabels.length - 1];
    }
    chart.update('none');
  }

  // build an empty chart with one trace per streamed column, ready to fill live
  private buildLiveChart(columns: string[], attempt = 0) {
    if (!this.plotterCanvas) {
      if (attempt < 10) setTimeout(() => this.buildLiveChart(columns, attempt + 1), 50);
      return;
    }
    if (this.plotterChart) {
      this.plotterChart.destroy();
      this.plotterChart = null;
    }
    const ctx = this.plotterCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    if (this.liveSeries.length !== columns.length) {
      this.liveSeries = columns.map(() => []);
    }

    const colors = columns.map((_, i) => `hsl(${(i * 360 / Math.max(1, columns.length)) % 360}, 70%, 50%)`);

    this.plotterLegendItems = columns.map((label, i) => ({ label, color: colors[i], index: i }));
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);

    this.plotterChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [...this.liveLabels],
        datasets: columns.map((label, i) => ({
          label,
          data: [...(this.liveSeries[i] ?? [])],
          borderColor: colors[i],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'xy', intersect: true },
        onClick: (_event, elements) => {
          if (elements.length > 0) this.highlightPlotterTrace(elements[0].datasetIndex);
        },
        plugins: {
          tooltip: this.plotterTooltipConfig(),
          legend: { display: false },
          zoom: {
            pan: { enabled: true, mode: 'xy' },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              drag: { enabled: true, modifierKey: 'shift' },
              mode: 'xy',
            },
          },
        },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Time' } },
          y: { title: { display: true, text: 'Power (W)' } },
        },
      },
    });

    this.refreshLiveChartData();
  }

  // shared "hold to reveal" tooltip config used by both static and live charts
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
          titleLines.forEach((t: string) => { html += `<div style="font-weight:700;margin-bottom:4px">${t}</div>`; });
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
      }
    };
  }

  // ACTIVE FUNCTIONS — triggered when user imports a data file
  async onPlotterFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.plotterFileName.set(file.name);
    this.plotterStatusMessage.set('Reading data...');
    this.plotterErrorMessage.set('');

    const text = await file.text();
    this.plotterFileContent.set(text);

    const parsed = this.parsePlotterCsv(text);
    const plotData = this.transformToPlotterData(parsed);

    this.parsedPlotterText.set(JSON.stringify(plotData, null, 2));
    this.plotterData = plotData;
    this.plotterStatus.set('Ready');
    this.plotterStatusMessage.set('Data loaded — press Display to view waveform');
    this.plotterDataLoaded.set(true);

    input.value = '';
  }

  // triggered by the Display button
  displayPlotterWaveform() {
    if (!this.plotterData || this.plotterData.datasets.length === 0) {
      this.plotterErrorMessage.set('No data to display. Please upload a CSV file first.');
      this.plotterStatus.set('Error');
      return;
    }

    this.plotterErrorMessage.set('');
    this.liveMode.set(false); // showing an uploaded file, not the live feed
    this.plotterVisible.set(true);
    this.plotterWindowState.set('normal');

    setTimeout(() => {
      this.renderPlotterWaveform(this.plotterData!);
    }, 0);
  }

  // close the dataplotter overlay
  closePlotter() {
    this.plotterVisible.set(false);
    if (this.plotterChart) {
      this.plotterChart.destroy();
      this.plotterChart = null;
    }
  }

  minimizePlotter() {
    this.plotterWindowState.set('minimized');
  }

  restorePlotter() {
    this.plotterWindowState.set('normal');
    setTimeout(() => this.plotterChart?.resize(), 50);
  }

  maximizePlotter() {
    if (this.plotterWindowState() === 'maximized') {
      this.plotterWindowState.set('normal');
    } else {
      this.plotterWindowState.set('maximized');
    }
    setTimeout(() => this.plotterChart?.resize(), 50);
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
      setTimeout(() => this.plotterChart?.resize(), 50);
    }
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.onPlotterFullscreenExit);
    this.live.disconnectStream();
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.singleClickTimer) clearTimeout(this.singleClickTimer);
  }

  // --- PLOTTER DRAG LOGIC ---
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
    if (this.resizing) {
      this.handlePlotterResize(event);
    }
  }

  onPlotterMouseUp() {
    this.dragging = false;
    if (this.resizing) {
      this.resizing = false;
      setTimeout(() => this.plotterChart?.resize(), 0);
    }
  }

  // --- PLOTTER RESIZE LOGIC ---
  onPlotterResizeStart(event: MouseEvent, edge: string) {
    if (this.plotterWindowState() === 'maximized') return;
    this.resizing = true;
    this.resizeEdge = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.plotterWidth;
    this.resizeStartH = this.plotterHeight;
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
    if (this.resizeEdge.includes('bottom')) {
      this.plotterHeight = Math.max(300, this.resizeStartH + dy);
    }
    if (this.resizeEdge.includes('left')) {
      const newW = Math.max(400, this.resizeStartW - dx);
      this.plotterLeft = this.resizeStartLeft + (this.resizeStartW - newW);
      this.plotterWidth = newW;
    }
    if (this.resizeEdge.includes('top')) {
      const newH = Math.max(300, this.resizeStartH - dy);
      this.plotterTop = this.resizeStartTop + (this.resizeStartH - newH);
      this.plotterHeight = newH;
    }
  }

  // --- PLOTTER LEGEND INTERACTION ---
  // single click = highlight a trace; double click = isolate (display only it).
  // a short timer lets us tell the two apart before acting on the single click.
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

  // show only the chosen trace (toggle off to show all again)
  private toggleIsolateTrace(index: number) {
    if (!this.plotterChart) return;
    const isSame = this.isolatedTraceIndex() === index;
    this.isolatedTraceIndex.set(isSame ? null : index);
    this.applyTraceVisibility();
    this.scrollToPlotterLegend(index);
  }

  private applyTraceVisibility() {
    if (!this.plotterChart) return;
    const isolated = this.isolatedTraceIndex();
    this.plotterChart.data.datasets.forEach((ds, i) => {
      ds.hidden = isolated !== null && i !== isolated;
    });
    this.plotterChart.update('none');
  }

  // clicking directly on a trace in the plotter
  private highlightPlotterTrace(index: number) {
    if (!this.plotterChart) return;

    const isSame = this.highlightedTraceIndex() === index;
    this.highlightedTraceIndex.set(isSame ? null : index);

    const current = this.highlightedTraceIndex();
    this.plotterChart.data.datasets.forEach((ds, i) => {
      if (current === null) {
        ds.borderWidth = 2;
      } else {
        ds.borderWidth = i === current ? 4 : 1;
      }
    });

    this.plotterChart.update('none');
    this.scrollToPlotterLegend(current ?? index);
  }

  private scrollToPlotterLegend(index: number) {
    if (!this.plotterLegendContainer) return;
    const container = this.plotterLegendContainer.nativeElement;
    const item = container.querySelector(`[data-legend-index="${index}"]`) as HTMLElement;
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  // DATA CSV PARSING
  parsePlotterCsv(text: string): ParsedPlotterData {
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length === 0) {
      return { headers: [], rows: [] };
    }

    const headers = lines[0].split(',').map(h => h.trim());

    const rows = lines.slice(1)
      .map(line => line.split(',').map(value => Number(value.trim())))
      .filter(row => row.every(value => !isNaN(value)));

    return { headers, rows };
  }

  transformToPlotterData(parsed: ParsedPlotterData): PlotterWaveformData {
    if (!parsed || parsed.headers.length === 0) {
      return { labels: [], datasets: [], xAxisLabel: '' };
    }

    const labels = parsed.rows.map(row => row[0]);

    const datasets = parsed.headers.slice(1).map((header, colIndex) => ({
      label: header,
      data: parsed.rows.map(row => row[colIndex + 1]),
    }));

    return { labels, datasets, xAxisLabel: parsed.headers[0] };
  }

  // RENDERS THE DATAPLOTTER WAVEFORM
  renderPlotterWaveform(plotData: PlotterWaveformData) {
    if (!this.plotterCanvas) return;

    if (this.plotterChart) {
      this.plotterChart.destroy();
    }

    // creates canvas rendering context for waveform
    const ctx = this.plotterCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    // extract trace data
    const labels = plotData.labels; // time axis values
    const datasets = plotData.datasets; // each trace (voltage, current, etc.)

    // compute axis bounds from data
    const minX = Math.min(...labels);
    const maxX = Math.max(...labels);
    const minY = Math.min(...datasets.flatMap(dataset => dataset.data));
    const maxY = Math.max(...datasets.flatMap(dataset => dataset.data));

    // generate distinct colors for each trace
    const colors = datasets.map((_, i) => {
      const hue = (i * 360 / datasets.length) % 360;
      return `hsl(${hue}, 70%, 50%)`;
    });

    // build plotter legend entries
    this.plotterLegendItems = datasets.map((ds, i) => ({
      label: ds.label,
      color: colors[i],
      index: i
    }));
    this.highlightedTraceIndex.set(null);
    this.isolatedTraceIndex.set(null);

    // builds the plotter chart instance
    this.plotterChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map((dataset, i) => ({
          label: dataset.label,
          data: dataset.data,
          borderColor: colors[i],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          axis: 'xy',
          intersect: true
        },
        onClick: (_event, elements) => {
          if (elements.length > 0) {
            this.highlightPlotterTrace(elements[0].datasetIndex);
          }
        },
        plugins: {
          tooltip: this.plotterTooltipConfig(),
          legend: {
            display: false // custom plotter legend is used instead
          },
          zoom: {
            pan: {
              enabled: true,
              mode: 'xy'
            },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              drag: {
                enabled: true,
                modifierKey: 'shift' // shift+drag to box-zoom
              },
              mode: 'xy'
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: minX,
            max: maxX,
            title: {
              display: true,
              text: plotData.xAxisLabel
            }
          },
          y: {
            min: minY,
            max: maxY,
            title: {
              display: true,
              text: 'Value'
            }
          }
        }
      }
    });
  }

  resetPlotterZoom() {
    if (this.plotterChart) {
      this.plotterChart.resetZoom();
    }
  }

  // plotter tooltip appears only after holding mouse still for 2 seconds
  onPlotterHover() {
    this.clearPlotterHoverTimer();
    if (this.plotterTooltipActive) {
      this.plotterTooltipActive = false;
      this.hidePlotterTooltipEl();
    }
    this.plotterHoverTimer = setTimeout(() => {
      this.plotterTooltipActive = true;
      if (this.plotterChart) {
        this.plotterChart.update('none');
      }
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

  private getOrCreatePlotterTooltipEl(): HTMLElement {
    let el = document.getElementById('dataplotter-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dataplotter-tooltip';
      el.style.position = 'absolute';
      el.style.background = 'rgba(30,41,59,0.92)';
      el.style.color = '#fff';
      el.style.borderRadius = '6px';
      el.style.padding = '8px 12px';
      el.style.fontSize = '12px';
      el.style.pointerEvents = 'none';
      el.style.transition = 'opacity 0.15s';
      el.style.zIndex = '9999';
      el.style.opacity = '0';
      document.body.appendChild(el);
    }
    return el;
  }

  private hidePlotterTooltipEl() {
    const el = document.getElementById('dataplotter-tooltip');
    if (el) {
      el.style.opacity = '0';
    }
  }
}