import {
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  splitCompleteLines,
  strictNumber,
} from './waveform-source';

export interface WebSocketSourceOptions {
  /** Endpoint, e.g. `ws://testbed.local:8080/telemetry`. */
  url: string;
  label?: string;
  /** Channel names for feeds that only push values (no header/meta). */
  columns?: string[];
  xAxisLabel?: string;
  yAxisLabel?: string;
  /** Reconnect backoff bounds, in ms. */
  minRetryMs?: number;
  maxRetryMs?: number;
}

/**
 * Streaming source over a WebSocket.
 *
 * This is the realistic path for a real testbed. A browser cannot speak
 * Modbus TCP, OPC UA or MQTT directly — a small gateway on the HMI side reads
 * the bus and republishes samples here as JSON or CSV lines. Latency is lower
 * than SSE and the link is bidirectional, so the same socket can carry
 * commands later.
 *
 * Accepts, per message:
 *  - `{ time, values: [...] }`
 *  - `[time, v1, v2, ...]`
 *  - `{ columns: [...] }` to (re)declare channels mid-stream
 *  - `Time,C1_Voltage,...` header line followed by CSV sample lines
 *
 * Reconnects with exponential backoff, and reassembles CSV text split across
 * frame boundaries.
 */
export class WebSocketWaveformSource implements WaveformSource {
  readonly kind = 'websocket';
  readonly mode = 'stream' as const;
  readonly label: string;

  private ws: WebSocket | null = null;
  private events: WaveformSourceEvents | null = null;
  private columns: string[];
  private announced = false;
  private closedByUs = false;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private textBuffer = '';

  constructor(private options: WebSocketSourceOptions) {
    this.label = options.label ?? `WebSocket ${options.url}`;
    this.columns = options.columns ? [...options.columns] : [];
    this.retryMs = options.minRetryMs ?? 1000;
  }

  async connect(events: WaveformSourceEvents): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      events.state('error', 'WebSocket is unavailable in this environment.');
      return;
    }
    this.events = events;
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.events?.state('closed');
    this.events = null;
  }

  private open() {
    const events = this.events;
    if (!events) return;

    events.state('connecting', this.options.url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (err) {
      events.state('error', `Invalid WebSocket URL: ${(err as Error).message}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = this.options.minRetryMs ?? 1000; // reset backoff
      events.state('connected', this.options.url);
    };

    ws.onmessage = (e) => this.handleMessage(e.data);

    ws.onerror = () => events.state('error', `WebSocket error on ${this.options.url}`);

    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUs) return;
      // Reconnect so a testbed reboot doesn't require an operator action.
      events.state('error', `Disconnected — retrying in ${Math.round(this.retryMs / 100) / 10}s`);
      this.retryTimer = setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 15000);
    };
  }

  private handleMessage(data: unknown) {
    if (typeof data !== 'string') return; // binary framing is deployment-specific
    const trimmed = data.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      this.handleJson(trimmed);
      return;
    }
    this.handleCsvChunk(data);
  }

  private handleJson(text: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!Array.isArray(payload) && payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;

      // channel (re)declaration
      if (Array.isArray(obj['columns'])) {
        this.columns = (obj['columns'] as unknown[]).map(String);
        this.announced = false;
        this.events?.reset();
        this.announceMeta();
        return;
      }

      // bulk backlog
      if (Array.isArray(obj['rows'])) {
        const samples = (obj['rows'] as unknown[])
          .map((r) => this.toSample(r))
          .filter((s): s is WaveformSample => !!s);
        if (samples.length) {
          this.announceMeta();
          this.events?.snapshot(samples);
        }
        return;
      }
    }

    // an array payload may be a batch of samples or one [t, ...] row
    if (Array.isArray(payload) && payload.length && typeof payload[0] === 'object') {
      const samples = payload.map((r) => this.toSample(r)).filter((s): s is WaveformSample => !!s);
      if (samples.length) {
        this.announceMeta();
        this.events?.snapshot(samples);
      }
      return;
    }

    const sample = this.toSample(payload);
    if (sample) {
      this.announceMeta();
      this.events?.sample(sample);
    }
  }

  /** Handle newline-delimited CSV, tolerating frames that split mid-line. */
  private handleCsvChunk(chunk: string) {
    this.textBuffer += chunk;
    const { lines, rest } = splitCompleteLines(this.textBuffer);
    this.textBuffer = rest;

    for (const line of lines) {
      const fields = line.split(',').map((f) => f.trim());
      const nums = fields.map(strictNumber);

      // a non-numeric line is a header — adopt it as the channel list
      if (nums.some((n) => !Number.isFinite(n))) {
        this.columns = fields.slice(1);
        this.announced = false;
        this.announceMeta();
        continue;
      }
      if (nums.length < 2) continue;

      this.inferColumns(nums.length - 1);
      this.announceMeta();
      this.events?.sample({ time: nums[0], values: nums.slice(1) });
    }
  }

  private announceMeta() {
    if (this.announced || this.columns.length === 0) return;
    this.announced = true;
    this.events?.meta({
      columns: this.columns,
      xAxisLabel: this.options.xAxisLabel ?? 'Time (s)',
      yAxisLabel: this.options.yAxisLabel ?? 'Value',
    });
  }

  private toSample(raw: unknown): WaveformSample | null {
    if (raw === null || typeof raw !== 'object') return null;

    if (Array.isArray(raw)) {
      const nums = raw.map(Number);
      if (nums.some((n) => !Number.isFinite(n)) || nums.length < 2) return null;
      this.inferColumns(nums.length - 1);
      return { time: nums[0], values: nums.slice(1) };
    }

    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['values'])) {
      const values = (obj['values'] as unknown[]).map(Number);
      this.inferColumns(values.length);
      return { time: Number(obj['time'] ?? 0), values };
    }

    const keys = Object.keys(obj).filter((k) => Number.isFinite(Number(obj[k])));
    if (keys.length < 2) return null;
    const timeKey = keys.find((k) => /^(time|t|timestamp)$/i.test(k)) ?? keys[0];
    if (this.columns.length === 0) this.columns = keys.filter((k) => k !== timeKey);
    return {
      time: Number(obj[timeKey]),
      values: this.columns.map((c) => Number(obj[c] ?? NaN)),
    };
  }

  private inferColumns(count: number) {
    if (this.columns.length === 0 && count > 0) {
      this.columns = Array.from({ length: count }, (_, i) => `CH ${i + 1}`);
    }
  }
}
