/**
 * Waveform source abstraction
 * ---------------------------
 * The DataPlotter renders whatever a `WaveformSource` gives it. It never knows
 * (or cares) whether the samples came from an uploaded CSV, the testbed data
 * server, a SCADA gateway, or a serial link to a controller.
 *
 * This is the seam that lets the HMI drop the plotter in and feed it real
 * testbed data without a file upload — implement one small interface and the
 * chart, legend, windowing and axis logic all keep working unchanged.
 */

/** One sample in time: an x value plus one y value per column. */
export interface WaveformSample {
  /** X value — seconds since capture start (or any monotonic scalar). */
  time: number;
  /** Y values, positionally matching `WaveformSourceMeta.columns`. */
  values: number[];
}

/** Describes the shape of the data a source is about to emit. */
export interface WaveformSourceMeta {
  /** Channel names, one per entry in `WaveformSample.values`. */
  columns: string[];
  xAxisLabel?: string;
  yAxisLabel?: string;
}

/** Lifecycle state of a source, surfaced in the UI as a connection badge. */
export type WaveformSourceState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

/**
 * Callbacks a source pushes into. All are optional for the source to call, but
 * a source MUST emit `meta` before its first sample so the plotter knows how
 * many traces to build.
 */
export interface WaveformSourceEvents {
  /** Channel layout changed — plotter (re)builds its traces. */
  meta(meta: WaveformSourceMeta): void;
  /** A single new sample (streaming sources). */
  sample(sample: WaveformSample): void;
  /** A bulk load or catch-up backlog, replacing current buffers. */
  snapshot(samples: WaveformSample[]): void;
  /** Discard buffered data (e.g. a new capture started). */
  reset(): void;
  /** Connection state change; `detail` carries a human-readable reason. */
  state(state: WaveformSourceState, detail?: string): void;
}

/**
 * A pluggable feed of waveform samples.
 *
 * `static` sources deliver everything up front via `snapshot` (a whole file —
 * the plotter then plots the full record). `stream` sources keep emitting
 * `sample` events until disconnected, and get the sliding time window.
 */
export interface WaveformSource {
  /** Short id used for the source picker, e.g. `'websocket'`. */
  readonly kind: string;
  /** Human-readable name shown in the UI. */
  readonly label: string;
  /** `stream` sources are windowed and live; `static` are plotted in full. */
  readonly mode: 'static' | 'stream';

  /** Begin producing data into `events`. */
  connect(events: WaveformSourceEvents): Promise<void>;
  /** Stop producing and release transport resources. Must be idempotent. */
  disconnect(): void;
}

/* ------------------------------------------------------------------ CSV --- */

/** Header names plus numeric rows, as read from a delimited text file. */
export interface ParsedTable {
  headers: string[];
  rows: number[][];
}

/**
 * Parse delimited numeric text (CSV/TSV) into headers + rows.
 *
 * Column 0 is the x axis. Rows containing any non-numeric field are dropped,
 * which conveniently discards trailing junk and partially-flushed final lines
 * from a logger that is still writing.
 */
export function parseDelimitedText(text: string, delimiter = ','): ParsedTable {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(delimiter).map((h) => h.trim());
  const rows = lines
    .slice(1)
    .map((line) => line.split(delimiter).map((value) => strictNumber(value)))
    .filter((row) => row.length > 1 && row.every((value) => Number.isFinite(value)));

  return { headers, rows };
}

/**
 * Strict numeric conversion.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so a truncated or empty field would
 * otherwise turn into a real-looking 0 V / 0 A reading. Blank fields must be
 * rejected instead, so the row gets dropped rather than fabricated.
 */
export function strictNumber(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return NaN;
  return Number(trimmed);
}

/** Convert a parsed table into meta + samples, treating column 0 as time. */
export function tableToSamples(table: ParsedTable): {
  meta: WaveformSourceMeta;
  samples: WaveformSample[];
} {
  if (table.headers.length === 0) {
    return { meta: { columns: [] }, samples: [] };
  }

  const meta: WaveformSourceMeta = {
    columns: table.headers.slice(1),
    xAxisLabel: table.headers[0] || 'Time',
    yAxisLabel: 'Value',
  };
  const samples = table.rows.map((row) => ({ time: row[0], values: row.slice(1) }));

  return { meta, samples };
}

/**
 * Split a stream chunk into complete lines, returning the trailing partial
 * line so the caller can prepend it to the next chunk. Network and serial
 * reads split mid-line constantly; without this you silently corrupt samples.
 */
export function splitCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}
