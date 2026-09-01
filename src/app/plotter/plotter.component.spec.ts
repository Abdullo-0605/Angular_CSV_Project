import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DataPlotter } from './plotter.component';
import { WaveformSource, WaveformSourceEvents } from '../data-sources';

/**
 * A stream source the test drives by hand.
 *
 * Note: jsdom has no canvas 2d context, so Chart.js never instantiates here.
 * The component is written to degrade safely in that case, which lets us assert
 * the data/legend/state layer without a real renderer.
 */
class ManualSource implements WaveformSource {
  readonly kind = 'manual';
  readonly label = 'Manual test source';
  events!: WaveformSourceEvents;

  constructor(readonly mode: 'static' | 'stream' = 'stream') {}

  async connect(events: WaveformSourceEvents) {
    this.events = events;
    events.state('connected');
  }
  disconnect() {
    this.events?.state('closed');
  }
}

function createPlotter() {
  const fixture = TestBed.createComponent(DataPlotter);
  return { fixture, plotter: fixture.componentInstance };
}

describe('DataPlotter', () => {
  it('builds a checklist legend from source meta', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();

    await plotter.attachSource(src);
    src.events.meta({ columns: ['C1_Voltage', 'L1_Current', 'Bus_Power'] });

    expect(plotter.plotterLegendItems.map((i) => i.label)).toEqual([
      'C1_Voltage',
      'L1_Current',
      'Bus_Power',
    ]);
    // every trace starts visible
    expect(plotter.visibleTraceCount()).toBe(3);
    expect(plotter.isTraceVisible(1)).toBe(true);
  });

  it('buffers streamed samples and exposes them via snapshot()', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A', 'B'] });
    src.events.sample({ time: 0, values: [1, 2] });
    src.events.sample({ time: 0.1, values: [3, 4] });

    expect(plotter.sampleCount()).toBe(2);
    expect(plotter.latestTime()).toBe(0.1);
    expect(plotter.plotterDataLoaded()).toBe(true);
    expect(plotter.plotterStatus()).toBe('Ready');

    const snap = plotter.snapshot();
    expect(snap.columns).toEqual(['A', 'B']);
    expect(snap.samples).toEqual([
      { time: 0, values: [1, 2] },
      { time: 0.1, values: [3, 4] },
    ]);
  });

  it('trims the buffer to maxBufferPoints so a long run cannot grow unbounded', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();
    plotter.maxBufferPoints.set(100); // floor enforced by the component

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A'] });
    for (let i = 0; i < 500; i++) {
      src.events.sample({ time: i * 0.01, values: [i] });
    }

    expect(plotter.sampleCount()).toBe(100);
    // the newest samples are the ones retained
    expect(plotter.snapshot().samples[99].values[0]).toBe(499);
  });

  it('toggling a legend checkbox hides only that trace', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A', 'B', 'C'] });

    plotter.toggleTraceVisible(1);
    expect(plotter.isTraceVisible(0)).toBe(true);
    expect(plotter.isTraceVisible(1)).toBe(false);
    expect(plotter.visibleTraceCount()).toBe(2);

    plotter.toggleTraceVisible(1);
    expect(plotter.isTraceVisible(1)).toBe(true);
  });

  it('supports show all / hide all / invert', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A', 'B', 'C', 'D'] });

    plotter.hideAllTraces();
    expect(plotter.visibleTraceCount()).toBe(0);

    plotter.invertTraceVisibility();
    expect(plotter.visibleTraceCount()).toBe(4);

    plotter.toggleTraceVisible(0);
    plotter.invertTraceVisibility();
    expect(plotter.visibleTraceCount()).toBe(1);
    expect(plotter.isTraceVisible(0)).toBe(true);

    plotter.showAllTraces();
    expect(plotter.visibleTraceCount()).toBe(4);
  });

  it('reports static sources as plot-all mode', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource('static');

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A'] });
    src.events.snapshot([
      { time: 0, values: [1] },
      { time: 1, values: [2] },
      { time: 2, values: [3] },
    ]);

    expect(plotter.sourceMode()).toBe('static');
    expect(plotter.sampleCount()).toBe(3);
  });

  it('plots CSV text handed in programmatically, with no file dialog', async () => {
    const { plotter } = createPlotter();

    await plotter.plotCsvText('Time,V,I\n0,10,1\n0.1,11,2\n', 'run-42.csv');

    expect(plotter.sourceMode()).toBe('static');
    expect(plotter.plotterDataLoaded()).toBe(true);
    expect(plotter.plotterLegendItems.map((i) => i.label)).toEqual(['V', 'I']);
    expect(plotter.snapshot().samples).toEqual([
      { time: 0, values: [10, 1] },
      { time: 0.1, values: [11, 2] },
    ]);
  });

  it('surfaces a source error to the status badge', async () => {
    const { plotter } = createPlotter();

    await plotter.plotCsvText('not,numeric\nfoo,bar\n', 'bad.csv');

    expect(plotter.plotterStatus()).toBe('Error');
    expect(plotter.plotterErrorMessage()).toBeTruthy();
  });

  it('clears buffered data when a source signals a new capture', async () => {
    const { plotter } = createPlotter();
    const src = new ManualSource();

    await plotter.attachSource(src);
    src.events.meta({ columns: ['A'] });
    src.events.sample({ time: 0, values: [1] });
    expect(plotter.sampleCount()).toBe(1);

    src.events.reset();
    expect(plotter.sampleCount()).toBe(0);
    // channels survive a reset, so the legend does not flicker
    expect(plotter.plotterLegendItems).toHaveLength(1);
  });

  it('replacing a source disconnects the previous one', async () => {
    const { plotter } = createPlotter();
    const first = new ManualSource();
    const second = new ManualSource();

    await plotter.attachSource(first);
    let firstClosed = false;
    first.events.state = ((state: string) => {
      if (state === 'closed') firstClosed = true;
    }) as WaveformSourceEvents['state'];

    await plotter.attachSource(second);
    expect(firstClosed).toBe(true);
  });
});
