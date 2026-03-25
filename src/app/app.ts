import { Component, ElementRef, signal, ViewChild } from '@angular/core';
import Chart from 'chart.js/auto';

interface ParsedCsv {
  headers: string[];
  rows: number[][];
}

interface ChartData {
  labels: number[];
  datasets: { label: string; data: number[] }[];
  xAxisLabel: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  @ViewChild('chartCanvas') chartCanvas!: ElementRef<HTMLCanvasElement>;

  fileName = signal('');
  fileContent = signal('');
  parsedDataText = signal('');
  status = signal('No file selected');
  fileLoaded = signal(false);

  private chart: Chart | null = null;

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      this.status.set('No file selected');
      this.fileLoaded.set(false);
      return;
    }

    this.fileName.set(file.name);
    this.status.set('Reading file...');
    this.fileLoaded.set(false);

    const text = await file.text();
    this.fileContent.set(text);

    const parsed = this.parseCsv(text);
    const chartData = this.transformToChartData(parsed);

    this.parsedDataText.set(JSON.stringify(chartData, null, 2));
    this.status.set('File loaded successfully');
    this.fileLoaded.set(true);

    input.value = '';

    setTimeout(() => {
      this.renderChart(chartData);
    }, 0);
  }

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

  renderChart(chartData: ChartData) {
    if (!this.chartCanvas) return;

    if (this.chart) {
      this.chart.destroy();
    }

    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const labels = chartData.labels;
    const datasets = chartData.datasets;

    const minX = Math.min(...labels);
    const maxX = Math.max(...labels);
    const minY = Math.min(...datasets.flatMap(dataset => dataset.data));
    const maxY = Math.max(...datasets.flatMap(dataset => dataset.data));

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: datasets.map(dataset => ({
          label: dataset.label,
          data: dataset.data,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true
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
}