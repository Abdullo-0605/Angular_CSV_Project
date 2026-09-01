import { describe, expect, it, vi } from 'vitest';
import {
  CsvFileSource,
  SerialWaveformSource,
  WaveformSample,
  WaveformSourceEvents,
  WaveformSourceMeta,
  WaveformSourceState,
  WebSocketWaveformSource,
  parseDelimitedText,
  splitCompleteLines,
  tableToSamples,
} from './index';

/** Collects everything a source emits so assertions stay readable. */
function recorder() {
  const meta: WaveformSourceMeta[] = [];
  const samples: WaveformSample[] = [];
  const snapshots: WaveformSample[][] = [];
  const states: { state: WaveformSourceState; detail?: string }[] = [];
  let resets = 0;

  const events: WaveformSourceEvents = {
    meta: (m) => meta.push(m),
    sample: (s) => samples.push(s),
    snapshot: (s) => snapshots.push(s),
    reset: () => void resets++,
    state: (state, detail) => states.push({ state, detail }),
  };

  return {
    events,
    meta,
    samples,
    snapshots,
    states,
    get resets() {
      return resets;
    },
    lastState: () => states[states.length - 1],
  };
}

describe('parseDelimitedText', () => {
  it('reads headers and numeric rows', () => {
    const table = parseDelimitedText('Time,C1_Voltage,L1_Current\n0,1.5,2.5\n0.1,1.6,2.6\n');
    expect(table.headers).toEqual(['Time', 'C1_Voltage', 'L1_Current']);
    expect(table.rows).toEqual([
      [0, 1.5, 2.5],
      [0.1, 1.6, 2.6],
    ]);
  });

  it('drops rows with non-numeric fields, e.g. a half-flushed final line', () => {
    const table = parseDelimitedText('Time,A\n0,1\n0.1,\n0.2,3\n');
    expect(table.rows).toEqual([
      [0, 1],
      [0.2, 3],
    ]);
  });

  it('returns empty on blank input', () => {
    expect(parseDelimitedText('   \n\n')).toEqual({ headers: [], rows: [] });
  });
});

describe('tableToSamples', () => {
  it('treats column 0 as the x axis', () => {
    const { meta, samples } = tableToSamples(
      parseDelimitedText('Time,A,B\n0,1,2\n1,3,4\n'),
    );
    expect(meta.columns).toEqual(['A', 'B']);
    expect(meta.xAxisLabel).toBe('Time');
    expect(samples).toEqual([
      { time: 0, values: [1, 2] },
      { time: 1, values: [3, 4] },
    ]);
  });
});

describe('splitCompleteLines', () => {
  it('holds back a trailing partial line', () => {
    const { lines, rest } = splitCompleteLines('1,2\n3,4\n5,');
    expect(lines).toEqual(['1,2', '3,4']);
    expect(rest).toBe('5,');
  });

  it('reassembles across chunk boundaries without corrupting samples', () => {
    const first = splitCompleteLines('0,1.0\n0.1,1.');
    const second = splitCompleteLines(first.rest + '5\n');
    expect(first.lines).toEqual(['0,1.0']);
    expect(second.lines).toEqual(['0.1,1.5']);
  });
});

describe('CsvFileSource', () => {
  it('emits meta then a single snapshot of the whole record', async () => {
    const rec = recorder();
    const src = new CsvFileSource('Time,A,B\n0,1,2\n1,3,4\n', 'run.csv');

    expect(src.mode).toBe('static');
    await src.connect(rec.events);

    expect(rec.meta[0].columns).toEqual(['A', 'B']);
    expect(rec.snapshots).toHaveLength(1);
    expect(rec.snapshots[0]).toHaveLength(2);
    expect(rec.samples).toHaveLength(0); // static sources never trickle
    expect(rec.lastState().state).toBe('connected');
  });

  it('reports an error for a file with no plottable data', async () => {
    const rec = recorder();
    await new CsvFileSource('nothing useful here', 'bad.csv').connect(rec.events);
    expect(rec.lastState().state).toBe('error');
  });

  it('accepts a File so a host can pass data in without a dialog', async () => {
    const rec = recorder();
    const file = new File(['Time,A\n0,5\n1,6\n'], 'passed-in.csv', { type: 'text/csv' });
    const src = new CsvFileSource(file);

    expect(src.label).toBe('passed-in.csv');
    await src.connect(rec.events);
    expect(rec.snapshots[0]).toEqual([
      { time: 0, values: [5] },
      { time: 1, values: [6] },
    ]);
  });
});

/* A minimal WebSocket stand-in we can drive from the test. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

describe('WebSocketWaveformSource', () => {
  function attach() {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const rec = recorder();
    const src = new WebSocketWaveformSource({ url: 'ws://testbed/telemetry' });
    return { rec, src };
  }

  it('adopts a CSV header line as the channel names', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    const ws = FakeWebSocket.last!;
    ws.onopen?.();

    ws.emit('Time,C1_Voltage,L1_Current\n');
    ws.emit('0,10,20\n');

    expect(rec.meta[0].columns).toEqual(['C1_Voltage', 'L1_Current']);
    expect(rec.samples).toEqual([{ time: 0, values: [10, 20] }]);
    src.disconnect();
  });

  it('handles { time, values } JSON frames', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    const ws = FakeWebSocket.last!;

    ws.emit(JSON.stringify({ columns: ['A', 'B'] }));
    ws.emit(JSON.stringify({ time: 0.5, values: [1, 2] }));

    expect(rec.meta[0].columns).toEqual(['A', 'B']);
    expect(rec.samples).toEqual([{ time: 0.5, values: [1, 2] }]);
    src.disconnect();
  });

  it('handles [time, ...values] array frames and invents channel names', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    FakeWebSocket.last!.emit(JSON.stringify([1, 7, 8]));

    expect(rec.meta[0].columns).toEqual(['CH 1', 'CH 2']);
    expect(rec.samples).toEqual([{ time: 1, values: [7, 8] }]);
    src.disconnect();
  });

  it('reassembles a CSV sample split across two frames', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    const ws = FakeWebSocket.last!;

    ws.emit('Time,A\n');
    ws.emit('0,1.'); // deliberately cut mid-number
    ws.emit('25\n');

    expect(rec.samples).toEqual([{ time: 0, values: [1.25] }]);
    src.disconnect();
  });

  it('rejects a CSV line with a blank field instead of inventing a 0 reading', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    const ws = FakeWebSocket.last!;

    ws.emit('Time,A,B\n');
    ws.emit('0,1,2\n');
    ws.emit('0.1,,4\n'); // blank field — must not become 0
    ws.emit('0.2,5,6\n');

    expect(rec.samples).toEqual([
      { time: 0, values: [1, 2] },
      { time: 0.2, values: [5, 6] },
    ]);
    src.disconnect();
  });

  it('stops reconnecting once disconnected on purpose', async () => {
    const { rec, src } = attach();
    await src.connect(rec.events);
    const ws = FakeWebSocket.last!;

    src.disconnect();
    ws.onclose?.();

    expect(ws.closed).toBe(true);
    expect(rec.states.some((s) => s.state === 'closed')).toBe(true);
  });
});

describe('SerialWaveformSource', () => {
  it('reports a clear error when Web Serial is unavailable', async () => {
    const rec = recorder();
    vi.stubGlobal('navigator', {});
    await new SerialWaveformSource().connect(rec.events);

    expect(rec.lastState().state).toBe('error');
    expect(rec.lastState().detail).toMatch(/Chrome or Edge/);
  });
});
