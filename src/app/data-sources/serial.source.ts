import {
  WaveformSource,
  WaveformSourceEvents,
  splitCompleteLines,
  strictNumber,
} from './waveform-source';

export interface SerialSourceOptions {
  /** UART baud rate. 115200 is the usual default for TI C2000 / STM32 telemetry. */
  baudRate?: number;
  label?: string;
  /** Channel names, if the device does not transmit a header line. */
  columns?: string[];
  /**
   * When the device sends only values (no time column), synthesise the x axis
   * from arrival time. Needed for firmware that just spams `1.23,4.56`.
   */
  synthesiseTime?: boolean;
  /** Assumed sample period (s) used when synthesising the x axis. */
  samplePeriodSeconds?: number;
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/* Minimal Web Serial typings — TS DOM lib does not ship them yet. */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

/** True when the browser exposes the Web Serial API (Chrome/Edge, secure context). */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Streaming source that reads ASCII telemetry directly from a serial port via
 * the Web Serial API — no data server, no gateway, no file.
 *
 * Intended for bench work: plug a controller (TI C2000 / STM32 / Arduino) or a
 * USB DAQ into the HMI machine, have it print `time,ch1,ch2` lines over UART,
 * and the plotter draws them live.
 *
 * Constraints worth knowing before relying on this:
 *  - Chromium-based browsers only (no Firefox/Safari).
 *  - Requires a secure context (https:// or localhost).
 *  - `connect()` must run from a user gesture — the browser shows a port
 *    picker, which cannot be bypassed.
 */
export class SerialWaveformSource implements WaveformSource {
  readonly kind = 'serial';
  readonly mode = 'stream' as const;
  readonly label: string;

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private events: WaveformSourceEvents | null = null;
  private columns: string[];
  private announced = false;
  private closedByUs = false;
  private buffer = '';
  private sampleIndex = 0;

  constructor(private options: SerialSourceOptions = {}) {
    this.label = options.label ?? `Serial @ ${options.baudRate ?? 115200} baud`;
    this.columns = options.columns ? [...options.columns] : [];
  }

  async connect(events: WaveformSourceEvents): Promise<void> {
    this.events = events;
    this.closedByUs = false;
    this.sampleIndex = 0;

    if (!isWebSerialSupported()) {
      events.state('error', 'Web Serial needs Chrome or Edge over https:// or localhost.');
      return;
    }

    events.state('connecting');
    try {
      const serial = (navigator as unknown as { serial: SerialLike }).serial;
      const port = await serial.requestPort(); // shows the browser port picker
      await port.open({ baudRate: this.options.baudRate ?? 115200 });
      this.port = port;
    } catch (err) {
      // Also the path when the operator dismisses the port picker.
      events.state('error', `Could not open serial port: ${(err as Error).message}`);
      return;
    }

    events.state('connected', this.label);
    this.readLoop();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.port?.close().catch(() => {});
    this.port = null;
    this.events?.state('closed');
    this.events = null;
  }

  /** Pump the port until cancelled, decoding bytes into sample lines. */
  private async readLoop() {
    const readable = this.port?.readable;
    if (!readable) {
      this.events?.state('error', 'Serial port has no readable stream.');
      return;
    }

    const decoder = new TextDecoder();
    this.reader = readable.getReader();

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.consume(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!this.closedByUs) {
        this.events?.state('error', `Serial read failed: ${(err as Error).message}`);
      }
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
      if (!this.closedByUs) this.events?.state('closed', 'Serial port closed.');
    }
  }

  /** Turn decoded text into samples, keeping any trailing partial line. */
  private consume(chunk: string) {
    this.buffer += chunk;
    const { lines, rest } = splitCompleteLines(this.buffer);
    this.buffer = rest;

    for (const line of lines) {
      const fields = line.split(/[,;\t]/).map((f) => f.trim());
      const nums = fields.map(strictNumber);

      // Non-numeric line = header. Firmware often prints one on boot.
      if (nums.some((n) => !Number.isFinite(n))) {
        const named = this.options.synthesiseTime ? fields : fields.slice(1);
        if (named.length) {
          this.columns = named;
          this.announced = false;
          this.announceMeta();
        }
        continue;
      }
      if (nums.length === 0) continue;

      let time: number;
      let values: number[];
      if (this.options.synthesiseTime) {
        time = this.sampleIndex * (this.options.samplePeriodSeconds ?? 0.01);
        values = nums;
      } else {
        if (nums.length < 2) continue;
        time = nums[0];
        values = nums.slice(1);
      }
      this.sampleIndex += 1;

      this.inferColumns(values.length);
      this.announceMeta();
      this.events?.sample({ time, values });
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

  private inferColumns(count: number) {
    if (this.columns.length === 0 && count > 0) {
      this.columns = Array.from({ length: count }, (_, i) => `CH ${i + 1}`);
    }
  }
}
