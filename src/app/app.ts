import { Component, ElementRef, signal, ViewChild, OnDestroy } from '@angular/core';
import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';

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
  templateUrl: './app.html',
  styleUrl: './app.css'
})

// BACKEND CLASS — DataPlotter (part of DataLogger module)
export class DataPlotter implements OnDestroy {
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
  plotterLegendItems: { label: string; color: string; index: number }[] = [];

  // dataplotter tooltip hold timer
  private plotterHoverTimer: any = null;
  private plotterTooltipActive = false;
  private isPlotterFullscreen = false;

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
  onPlotterLegendSelect(index: number) {
    this.highlightPlotterTrace(index);
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
          tooltip: {
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
          },
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