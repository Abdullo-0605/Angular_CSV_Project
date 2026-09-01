import { Injectable, NgZone, inject, signal } from '@angular/core';

/** A single generated sample row streamed from the testbed data server. */
export interface LiveRow {
  time: number;
  values: number[];
}

/** Generator status reported by the data server. */
export interface LiveStatus {
  status: 'idle' | 'scheduled' | 'running' | 'stopped' | 'completed';
  columns: string[];
  config: StartConfig | null;
  elapsed: number;
  rowCount: number;
  scheduledFor: number | null;
  csvFile?: string;
}

/** Meta describing the current capture (sent on connect and on start). */
export interface LiveMeta {
  columns: string[];
  config: StartConfig | null;
  status: LiveStatus['status'];
}

/** Configuration sent to start/schedule a capture. */
export interface StartConfig {
  intervalMs: number;
  startWatts: number;
  endWatts: number;
  rampSeconds: number;
  durationSeconds: number;
  selectedLogs?: string[];
  startEpochMs?: number;
}

/**
 * Client for the standalone testbed data server.
 *
 * Wraps the control endpoints (fetch) and the live SSE stream (EventSource).
 * The generator/data source is decoupled here so a real testbed feed can be
 * swapped in later without touching the plotter component.
 */
@Injectable({ providedIn: 'root' })
export class LiveDataService {
  /** Base URL of the data server. Override here if it runs elsewhere. */
  readonly apiBase = 'http://localhost:4000';

  private zone = inject(NgZone);
  private es: EventSource | null = null;

  /** True while the SSE stream is open. */
  readonly connected = signal(false);
  /** Latest status pushed by the server. */
  readonly status = signal<LiveStatus | null>(null);
  /** Full list of selectable log columns from the server. */
  readonly availableColumns = signal<string[]>([]);

  /** Hooks the component subscribes to for stream events. */
  onMeta?: (meta: LiveMeta) => void;
  onSnapshot?: (rows: LiveRow[]) => void;
  onRow?: (row: LiveRow) => void;
  onReset?: () => void;
  onStatus?: (status: LiveStatus) => void;

  private get browser(): boolean {
    return typeof window !== 'undefined' && typeof EventSource !== 'undefined';
  }

  /** Fetch the selectable log column names. */
  async fetchLogs(): Promise<string[]> {
    const res = await fetch(`${this.apiBase}/api/logs`);
    if (!res.ok) throw new Error(`logs request failed: ${res.status}`);
    const json = await res.json();
    const columns: string[] = json.columns ?? [];
    this.availableColumns.set(columns);
    return columns;
  }

  /** Open the SSE stream and wire incoming events back through NgZone. */
  connectStream(): void {
    if (!this.browser || this.es) return;

    const es = new EventSource(`${this.apiBase}/api/stream`);
    this.es = es;

    es.onopen = () => this.zone.run(() => this.connected.set(true));
    es.onerror = () => this.zone.run(() => this.connected.set(false));

    es.addEventListener('meta', (e) =>
      this.zone.run(() => {
        const meta = JSON.parse((e as MessageEvent).data) as LiveMeta;
        this.onMeta?.(meta);
      }),
    );
    es.addEventListener('snapshot', (e) =>
      this.zone.run(() => {
        const data = JSON.parse((e as MessageEvent).data) as { rows: LiveRow[] };
        this.onSnapshot?.(data.rows ?? []);
      }),
    );
    es.addEventListener('row', (e) =>
      this.zone.run(() => {
        const row = JSON.parse((e as MessageEvent).data) as LiveRow;
        this.onRow?.(row);
      }),
    );
    es.addEventListener('reset', () => this.zone.run(() => this.onReset?.()));
    es.addEventListener('status', (e) =>
      this.zone.run(() => {
        const status = JSON.parse((e as MessageEvent).data) as LiveStatus;
        this.status.set(status);
        this.onStatus?.(status);
      }),
    );
  }

  /** Close the SSE stream. */
  disconnectStream(): void {
    this.es?.close();
    this.es = null;
    this.connected.set(false);
  }

  /** Start (or schedule) a capture with the given configuration. */
  async start(config: StartConfig): Promise<LiveStatus> {
    const res = await fetch(`${this.apiBase}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`start request failed: ${res.status}`);
    return res.json();
  }

  /** Stop the current capture. */
  async stop(): Promise<LiveStatus> {
    const res = await fetch(`${this.apiBase}/api/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`stop request failed: ${res.status}`);
    return res.json();
  }

  /** Stop and clear the live CSV. */
  async reset(): Promise<LiveStatus> {
    const res = await fetch(`${this.apiBase}/api/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`reset request failed: ${res.status}`);
    return res.json();
  }

  /** URL to download the generated CSV. */
  downloadUrl(): string {
    return `${this.apiBase}/api/download`;
  }
}
