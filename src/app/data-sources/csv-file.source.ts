import {
  ParsedTable,
  WaveformSample,
  WaveformSource,
  WaveformSourceEvents,
  WaveformSourceMeta,
  parseDelimitedText,
  tableToSamples,
} from './waveform-source';

/**
 * Static source backed by a CSV/TSV file or raw text.
 *
 * Emits the entire record in one `snapshot`, so the plotter draws the full
 * dataset with no windowing.
 *
 * Accepts a `File` (from an <input type="file">) or a plain string, which is
 * what lets the HMI hand data to the plotter programmatically instead of
 * making an operator pick a file.
 */
export class CsvFileSource implements WaveformSource {
  readonly kind = 'file';
  readonly mode = 'static' as const;

  private text = '';
  private events: WaveformSourceEvents | null = null;

  constructor(
    private input: File | string,
    readonly label = typeof input === 'string' ? 'Pasted data' : input.name,
    private delimiter = ',',
  ) {}

  /** Rows parsed from the last `connect()`, for the raw/parsed detail panels. */
  table: ParsedTable = { headers: [], rows: [] };
  /** Raw file text, for the "Raw CSV Data" panel. */
  get rawText(): string {
    return this.text;
  }

  async connect(events: WaveformSourceEvents): Promise<void> {
    this.events = events;
    events.state('connecting');

    try {
      this.text = typeof this.input === 'string' ? this.input : await this.input.text();
    } catch (err) {
      events.state('error', `Could not read file: ${(err as Error).message}`);
      return;
    }

    this.table = parseDelimitedText(this.text, this.delimiter);
    const { meta, samples } = tableToSamples(this.table);

    if (meta.columns.length === 0 || samples.length === 0) {
      events.state('error', 'No plottable numeric data found in this file.');
      return;
    }

    events.reset();
    events.meta(meta);
    events.snapshot(samples);
    events.state('connected', `${samples.length} rows, ${meta.columns.length} channels`);
  }

  disconnect(): void {
    this.events?.state('closed');
    this.events = null;
  }
}

/** Parse text into meta + samples without going through a source instance. */
export function parseCsvToWaveform(
  text: string,
  delimiter = ',',
): { meta: WaveformSourceMeta; samples: WaveformSample[]; table: ParsedTable } {
  const table = parseDelimitedText(text, delimiter);
  return { ...tableToSamples(table), table };
}
