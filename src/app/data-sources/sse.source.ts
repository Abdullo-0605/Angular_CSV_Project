import {
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  WaveformSourceMeta,
} from './waveform-source';

export interface SseSourceOptions {
  /** Full URL of the SSE endpoint, e.g. `http://localhost:4000/api/stream`. */
  url: string;
  label?: string;
  /**
   * Channel names to use when the server never sends a `meta` event. Required
   * for bare-JSON feeds that only push value arrays.
   */
  columns?: string[];
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/**
 * Streaming source over Server-Sent Events.
 *
 * This is the lowest-friction way to attach to an existing HMI/dataLogger
 * backend: SSE is plain HTTP, so it traverses the same proxies and TLS as the
 * rest of the app, and the browser reconnects on its own.
 *
 * Understands two wire formats:
 *  1. Named events — `meta` / `snapshot` / `row` / `reset` / `status`
 *     (the format the bundled testbed data server already speaks).
 *  2. Unnamed `message` events carrying `{ time, values }`, `[t, v1, v2]`,
 *     or `{ Time: .., C1_Voltage: .. }` objects. Keys of the first object
 *     become the channel names when `columns` is not supplied.
 */
export class SseWaveformSource implements WaveformSource {
  readonly kind = 'sse';
  readonly mode = 'stream' as const;
  readonly label: string;

  private es: EventSource | null = null;
  private events: WaveformSourceEvents | null = null;
  private columns: string[];
  private announced = false;

  constructor(private options: SseSourceOptions) {
    this.label = options.label ?? `SSE ${options.url}`;
    this.columns = options.columns ? [...options.columns] : [];
  }

  async connect(events: WaveformSourceEvents): Promise<void> {
    if (typeof EventSource === 'undefined') {
      events.state('error', 'EventSource is unavailable in this environment.');
      return;
    }

    this.events = events;
    this.announced = false;
    events.state('connecting');

    const es = new EventSource(this.options.url);
    this.es = es;

    es.onopen = () => events.state('connected', this.options.url);
    // EventSource retries automatically; report the drop but stay attached.
    es.onerror = () => events.state('error', `Stream interrupted — retrying ${this.options.url}`);

    es.addEventListener('meta', (e) => this.handleMeta(e as MessageEvent));
    es.addEventListener('snapshot', (e) => this.handleSnapshot(e as MessageEvent));
    es.addEventListener('row', (e) => this.handleRow(e as MessageEvent));
    es.addEventListener('reset', () => events.reset());
    es.onmessage = (e) => this.handleRow(e);
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
    this.events?.state('closed');
    this.events = null;
  }

  private handleMeta(e: MessageEvent) {
    const payload = this.parse<{ columns?: string[] }>(e.data);
    if (!payload?.columns?.length) return;
    this.columns = payload.columns;
    this.announceMeta();
  }

  private handleSnapshot(e: MessageEvent) {
    const payload = this.parse<{ rows?: unknown[] }>(e.data);
    const rows = payload?.rows ?? [];
    const samples = rows.map((r) => this.toSample(r)).filter((s): s is WaveformSample => !!s);
    if (samples.length === 0) return;
    this.announceMeta();
    this.events?.snapshot(samples);
  }

  private handleRow(e: MessageEvent) {
    const payload = this.parse<unknown>(e.data);
    const sample = this.toSample(payload);
    if (!sample) return;
    this.announceMeta();
    this.events?.sample(sample);
  }

  /** Emit `meta` exactly once per column layout, before any sample. */
  private announceMeta() {
    if (this.announced || this.columns.length === 0) return;
    this.announced = true;
    const meta: WaveformSourceMeta = {
      columns: this.columns,
      xAxisLabel: this.options.xAxisLabel ?? 'Time (s)',
      yAxisLabel: this.options.yAxisLabel ?? 'Value',
    };
    this.events?.meta(meta);
  }

  private parse<T>(data: string): T | null {
    try {
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  /** Normalise the accepted payload shapes into a `WaveformSample`. */
  private toSample(raw: unknown): WaveformSample | null {
    if (raw === null || typeof raw !== 'object') return null;

    // [time, v1, v2, ...]
    if (Array.isArray(raw)) {
      const nums = raw.map(Number);
      if (nums.some((n) => !Number.isFinite(n))) return null;
      this.inferColumns(nums.length - 1);
      return { time: nums[0], values: nums.slice(1) };
    }

    const obj = raw as Record<string, unknown>;

    // { time, values: [...] }
    if (Array.isArray(obj['values'])) {
      const values = (obj['values'] as unknown[]).map(Number);
      this.inferColumns(values.length);
      return { time: Number(obj['time'] ?? 0), values };
    }

    // { Time: .., C1_Voltage: .., ... }
    const keys = Object.keys(obj).filter((k) => Number.isFinite(Number(obj[k])));
    if (keys.length < 2) return null;
    const timeKey = keys.find((k) => /^(time|t|timestamp)$/i.test(k)) ?? keys[0];
    const valueKeys = keys.filter((k) => k !== timeKey);
    if (this.columns.length === 0) this.columns = valueKeys;
    return {
      time: Number(obj[timeKey]),
      values: this.columns.map((c) => Number(obj[c] ?? NaN)),
    };
  }

  /** Fabricate channel names for feeds that never describe themselves. */
  private inferColumns(count: number) {
    if (this.columns.length === 0 && count > 0) {
      this.columns = Array.from({ length: count }, (_, i) => `CH ${i + 1}`);
    }
  }
}
