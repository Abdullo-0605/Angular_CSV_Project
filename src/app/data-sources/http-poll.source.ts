import {
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  parseDelimitedText,
  tableToSamples,
} from './waveform-source';

export interface HttpPollSourceOptions {
  /** Endpoint returning either CSV text or JSON samples. */
  url: string;
  label?: string;
  /** Poll period in ms. */
  intervalMs?: number;
  /**
   * `replace` re-reads the whole record each poll (a growing CSV log file);
   * `append` treats each response as only the new samples since last poll.
   */
  strategy?: 'replace' | 'append';
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/**
 * Streaming source that polls a plain HTTP endpoint.
 *
 * The fallback for HMI backends that expose neither SSE nor WebSocket — it can
 * point straight at a growing CSV log file the dataLogger is writing. Higher
 * latency and more bandwidth than the push transports, so prefer those when
 * available.
 */
export class HttpPollWaveformSource implements WaveformSource {
  readonly kind = 'http';
  readonly mode = 'stream' as const;
  readonly label: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private events: WaveformSourceEvents | null = null;
  private columns: string[] = [];
  private announced = false;
  private lastTime = -Infinity;
  private inFlight = false;

  constructor(private options: HttpPollSourceOptions) {
    this.label = options.label ?? `HTTP ${options.url}`;
  }

  async connect(events: WaveformSourceEvents): Promise<void> {
    this.events = events;
    this.announced = false;
    this.lastTime = -Infinity;
    events.state('connecting', this.options.url);

    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs ?? 1000);
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events?.state('closed');
    this.events = null;
  }

  private async poll() {
    // Skip a tick rather than stacking requests on a slow endpoint.
    if (this.inFlight || !this.events) return;
    this.inFlight = true;

    try {
      const res = await fetch(this.options.url, { cache: 'no-store' });
      if (!res.ok) {
        this.events.state('error', `Poll failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.text()).trim();
      if (!body) return;

      const samples = body.startsWith('{') || body.startsWith('[')
        ? this.fromJson(body)
        : this.fromCsv(body);
      if (samples.length === 0) return;

      this.events.state('connected', this.options.url);
      this.announceMeta();

      if ((this.options.strategy ?? 'replace') === 'replace') {
        this.events.snapshot(samples);
        return;
      }
      // append: forward only samples newer than the last one we emitted
      const fresh = samples.filter((s) => s.time > this.lastTime);
      if (fresh.length === 0) return;
      this.lastTime = fresh[fresh.length - 1].time;
      for (const s of fresh) this.events.sample(s);
    } catch (err) {
      this.events?.state('error', `Poll failed: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  private fromCsv(text: string): WaveformSample[] {
    const { meta, samples } = tableToSamples(parseDelimitedText(text));
    if (meta.columns.length && this.columns.length === 0) this.columns = meta.columns;
    return samples;
  }

  private fromJson(text: string): WaveformSample[] {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return [];
    }

    const obj = payload as Record<string, unknown>;
    if (!Array.isArray(payload) && Array.isArray(obj?.['columns'])) {
      this.columns = (obj['columns'] as unknown[]).map(String);
    }
    const rowsRaw = Array.isArray(payload) ? payload : (obj?.['rows'] as unknown[]) ?? [];

    return rowsRaw
      .map((r) => {
        if (Array.isArray(r)) {
          const nums = r.map(Number);
          if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) return null;
          this.inferColumns(nums.length - 1);
          return { time: nums[0], values: nums.slice(1) };
        }
        if (r && typeof r === 'object') {
          const o = r as Record<string, unknown>;
          if (Array.isArray(o['values'])) {
            const values = (o['values'] as unknown[]).map(Number);
            this.inferColumns(values.length);
            return { time: Number(o['time'] ?? 0), values };
          }
        }
        return null;
      })
      .filter((s): s is WaveformSample => !!s);
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

  private inferColumns(count: number) {
    if (this.columns.length === 0 && count > 0) {
      this.columns = Array.from({ length: count }, (_, i) => `CH ${i + 1}`);
    }
  }
}
