import { Component, ElementRef, signal, ViewChild, OnDestroy } from '@angular/core';
import Chart from 'chart.js/auto';
import zoomPlugin from 'chartjs-plugin-zoom';

Chart.register(zoomPlugin);

interface ParsedCsv { //object format for file
  headers: string[];
  rows: number[][];
}

interface ChartData { //format for chart
  labels: number[];
  datasets: { label: string; data: number[] }[];
  xAxisLabel: string;
}

// (FRONTEND) - When Index.html runs, this is the first thing that loads
@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.html',
  styleUrl: './app.css'
})

// BACKEND CLASS (Logic)
export class App implements OnDestroy {
  private onFullscreenChange = () => this.handleFullscreenChange();
  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('legendContainer') legendContainer!: ElementRef<HTMLDivElement>;

  fileName = signal('');
  fileContent = signal('');
  parsedDataText = signal('');
  status = signal<'N/A' | 'Ready' | 'Error'>('N/A');
  statusMessage = signal('No data uploaded');
  fileLoaded = signal(false);
  chartVisible = signal(false);
  errorMessage = signal('');

  // overlay window state
  windowState = signal<'normal' | 'minimized' | 'maximized'>('normal');
  windowWidth = 900;
  windowHeight = 550;
  windowTop = 80;
  windowLeft = 100;

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

  // chart internals
  private chart: Chart | null = null;
  private chartData: ChartData | null = null;
  highlightedIndex = signal<number | null>(null);
  legendItems: { label: string; color: string; index: number }[] = [];

  // tooltip hold timer
  private hoverTimer: any = null;
  private tooltipEnabled = false;
  private isFullscreen = false;

  // START OF ACTIVE FUNCTIONS (when user uploads a file)
  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.fileName.set(file.name);
    this.statusMessage.set('Reading file...');
    this.errorMessage.set('');

    const text = await file.text();
    this.fileContent.set(text);

    const parsed = this.parseCsv(text);
    const chartData = this.transformToChartData(parsed);

    this.parsedDataText.set(JSON.stringify(chartData, null, 2));
    this.chartData = chartData;
    this.status.set('Ready');
    this.statusMessage.set('File loaded — press Display to view chart');
    this.fileLoaded.set(true);

    input.value = '';
  }

  // triggered by the Display button
  onDisplay() {
    if (!this.chartData || this.chartData.datasets.length === 0) {
      this.errorMessage.set('No data to display. Please upload a CSV file first.');
      this.status.set('Error');
      return;
    }

    this.errorMessage.set('');
    this.chartVisible.set(true);
    this.windowState.set('normal');

    setTimeout(() => {
      this.renderChart(this.chartData!);
    }, 0);
  }

  // close the chart overlay
  closeChart() {
    this.chartVisible.set(false);
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }

  minimizeChart() {
    this.windowState.set('minimized');
  }

  restoreChart() {
    this.windowState.set('normal');
    setTimeout(() => this.chart?.resize(), 50);
  }

  maximizeChart() {
    if (this.windowState() === 'maximized') {
      this.windowState.set('normal');
    } else {
      this.windowState.set('maximized');
    }
    setTimeout(() => this.chart?.resize(), 50);
  }

  fullscreenChart() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
      this.isFullscreen = true;
      this.windowState.set('maximized');
    } else {
      document.exitFullscreen();
    }
  }

  private handleFullscreenChange() {
    if (!document.fullscreenElement && this.isFullscreen) {
      this.isFullscreen = false;
      this.windowState.set('normal');
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
      setTimeout(() => this.chart?.resize(), 50);
    }
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
  }

  // --- DRAG LOGIC ---
  onTitleBarMouseDown(event: MouseEvent) {
    if (this.windowState() === 'maximized') return;
    this.dragging = true;
    this.dragOffsetX = event.clientX - this.windowLeft;
    this.dragOffsetY = event.clientY - this.windowTop;
    event.preventDefault();
  }

  onMouseMove(event: MouseEvent) {
    if (this.dragging) {
      this.windowLeft = event.clientX - this.dragOffsetX;
      this.windowTop = event.clientY - this.dragOffsetY;
    }
    if (this.resizing) {
      this.handleResize(event);
    }
  }

  onMouseUp() {
    this.dragging = false;
    if (this.resizing) {
      this.resizing = false;
      setTimeout(() => this.chart?.resize(), 0);
    }
  }

  // --- RESIZE LOGIC ---
  onResizeStart(event: MouseEvent, edge: string) {
    if (this.windowState() === 'maximized') return;
    this.resizing = true;
    this.resizeEdge = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.windowWidth;
    this.resizeStartH = this.windowHeight;
    this.resizeStartTop = this.windowTop;
    this.resizeStartLeft = this.windowLeft;
    event.preventDefault();
    event.stopPropagation();
  }

  private handleResize(event: MouseEvent) {
    const dx = event.clientX - this.resizeStartX;
    const dy = event.clientY - this.resizeStartY;

    if (this.resizeEdge.includes('right')) {
      this.windowWidth = Math.max(400, this.resizeStartW + dx);
    }
    if (this.resizeEdge.includes('bottom')) {
      this.windowHeight = Math.max(300, this.resizeStartH + dy);
    }
    if (this.resizeEdge.includes('left')) {
      const newW = Math.max(400, this.resizeStartW - dx);
      this.windowLeft = this.resizeStartLeft + (this.resizeStartW - newW);
      this.windowWidth = newW;
    }
    if (this.resizeEdge.includes('top')) {
      const newH = Math.max(300, this.resizeStartH - dy);
      this.windowTop = this.resizeStartTop + (this.resizeStartH - newH);
      this.windowHeight = newH;
    }
  }

  // --- LEGEND CLICK (highlight a dataset) ---
  onLegendClick(index: number) {
    this.highlightDataset(index);
  }

  // clicking directly on a line in the chart
  private highlightDataset(index: number) {
    if (!this.chart) return;

    const isSame = this.highlightedIndex() === index;
    this.highlightedIndex.set(isSame ? null : index);

    const current = this.highlightedIndex();
    this.chart.data.datasets.forEach((ds, i) => {
      if (current === null) {
        ds.borderWidth = 2;
      } else {
        ds.borderWidth = i === current ? 4 : 1;
      }
    });

    this.chart.update('none');
    this.scrollLegendTo(current ?? index);
  }

  private scrollLegendTo(index: number) {
    if (!this.legendContainer) return;
    const container = this.legendContainer.nativeElement;
    const item = container.querySelector(`[data-legend-index="${index}"]`) as HTMLElement;
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  // CSV PARSING
  parseCsv(text: string): ParsedCsv {
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

  transformToChartData(parsed: ParsedCsv): ChartData {
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

  // MAKES THE CHART VISIBLE
  renderChart(chartData: ChartData) {
    if (!this.chartCanvas) return;

    if (this.chart) {
      this.chart.destroy();
    }

    // creates canvas element (to make chart later)
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    // set proper variables
    const labels = chartData.labels; //x axis values
    const datasets = chartData.datasets; //each lines values (c1_voltage, ...)

    // limits the chart for the data (helps with scaling)
    const minX = Math.min(...labels);
    const maxX = Math.max(...labels);
    const minY = Math.min(...datasets.flatMap(dataset => dataset.data));
    const maxY = Math.max(...datasets.flatMap(dataset => dataset.data));

    // generate colors for each dataset
    const colors = datasets.map((_, i) => {
      const hue = (i * 360 / datasets.length) % 360;
      return `hsl(${hue}, 70%, 50%)`;
    });

    // build legend items for custom legend
    this.legendItems = datasets.map((ds, i) => ({
      label: ds.label,
      color: colors[i],
      index: i
    }));
    this.highlightedIndex.set(null);

    // IMPORTANT: builds the chart
    this.chart = new Chart(ctx, {
      type: 'line',
      // makes each line:...
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
        responsive: true, //resizes when needed
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          axis: 'xy',
          intersect: true
        },
        onClick: (_event, elements) => {
          if (elements.length > 0) {
            this.highlightDataset(elements[0].datasetIndex);
          }
        },
        plugins: {
          tooltip: {
            enabled: false,
            external: (context: any) => {
              if (!this.tooltipEnabled) return;
              // use default tooltip rendering when enabled
              const tooltipEl = this.getOrCreateTooltipEl(context.chart);
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
            display: false // we use custom legend
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
              text: chartData.xAxisLabel
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

  resetZoom() {
    if (this.chart) {
      this.chart.resetZoom();
    }
  }

  // tooltip appears only after holding mouse still for 2 seconds
  onChartMouseMove() {
    this.clearHoverTimer();
    if (this.tooltipEnabled) {
      this.tooltipEnabled = false;
      this.hideTooltipEl();
    }
    this.hoverTimer = setTimeout(() => {
      this.tooltipEnabled = true;
      if (this.chart) {
        this.chart.update('none');
      }
    }, 2000);
  }

  onChartMouseLeave() {
    this.clearHoverTimer();
    this.tooltipEnabled = false;
    this.hideTooltipEl();
  }

  private clearHoverTimer() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private getOrCreateTooltipEl(chart: any): HTMLElement {
    let el = document.getElementById('chart-custom-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-custom-tooltip';
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

  private hideTooltipEl() {
    const el = document.getElementById('chart-custom-tooltip');
    if (el) {
      el.style.opacity = '0';
    }
  }
}