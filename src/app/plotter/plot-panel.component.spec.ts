import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PlotPanel } from './plot-panel.component';
import { DEFAULT_PLOT_SETTINGS } from './plot-settings';
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
  disconnected = false;

  constructor(readonly mode: 'static' | 'stream' = 'stream') {}

  async connect(events: WaveformSourceEvents) {
    this.events = events;
    events.state('connected');
  }
  disconnect() {
    this.disconnected = true;
  }
}

/** Mount a panel bound to `source`, running ngOnInit. */
async function mount(source: WaveformSource, settings = DEFAULT_PLOT_SETTINGS) {
  const fixture = TestBed.createComponent(PlotPanel);
  fixture.componentRef.setInput('source', source);
  fixture.componentRef.setInput('initialSettings', settings);
  await fixture.whenStable();
  return { fixture, panel: fixture.componentInstance };
}

describe('PlotPanel', () => {
  it('connects to its source on init and adopts the initial settings', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src, { ...DEFAULT_PLOT_SETTINGS, windowSeconds: 2 });

    expect(src.events).toBeDefined();
    expect(panel.sourceState()).toBe('connected');
    expect(panel.windowSeconds()).toBe(2);
    expect(panel.sourceMode()).toBe('stream');
  });

  it('builds a checklist legend from source meta', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    src.events.meta({ columns: ['C1_Voltage', 'L1_Current', 'Bus_Power'] });

    expect(panel.legendItems.map((i) => i.label)).toEqual([
      'C1_Voltage',
      'L1_Current',
      'Bus_Power',
    ]);
    expect(panel.visibleTraceCount()).toBe(3);
  });

  it('buffers streamed samples and exposes them via snapshot()', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    src.events.meta({ columns: ['A', 'B'] });
    src.events.sample({ time: 0, values: [1, 2] });
    src.events.sample({ time: 0.1, values: [3, 4] });

    expect(panel.sampleCount()).toBe(2);
    expect(panel.latestTime()).toBe(0.1);
    expect(panel.status()).toBe('Ready');
    expect(panel.snapshot().samples).toEqual([
      { time: 0, values: [1, 2] },
      { time: 0.1, values: [3, 4] },
    ]);
  });

  it('trims the buffer so a long run cannot grow unbounded', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src, { ...DEFAULT_PLOT_SETTINGS, maxBufferPoints: 100 });

    src.events.meta({ columns: ['A'] });
    for (let i = 0; i < 500; i++) src.events.sample({ time: i * 0.01, values: [i] });

    expect(panel.sampleCount()).toBe(100);
    expect(panel.snapshot().samples[99].values[0]).toBe(499);
  });

  it('toggling a legend checkbox hides only that trace', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);
    src.events.meta({ columns: ['A', 'B', 'C'] });

    panel.toggleTraceVisible(1);
    expect(panel.isTraceVisible(0)).toBe(true);
    expect(panel.isTraceVisible(1)).toBe(false);
    expect(panel.visibleTraceCount()).toBe(2);

    panel.toggleTraceVisible(1);
    expect(panel.isTraceVisible(1)).toBe(true);
  });

  it('supports show all / hide all / invert', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);
    src.events.meta({ columns: ['A', 'B', 'C', 'D'] });

    panel.hideAllTraces();
    expect(panel.visibleTraceCount()).toBe(0);

    panel.invertTraceVisibility();
    expect(panel.visibleTraceCount()).toBe(4);

    panel.toggleTraceVisible(0);
    panel.invertTraceVisibility();
    expect(panel.visibleTraceCount()).toBe(1);
    expect(panel.isTraceVisible(0)).toBe(true);
  });

  it('clears buffered data when a source signals a new capture', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    src.events.meta({ columns: ['A'] });
    src.events.sample({ time: 0, values: [1] });
    expect(panel.sampleCount()).toBe(1);

    src.events.reset();
    expect(panel.sampleCount()).toBe(0);
    // channels survive a reset, so the legend does not flicker
    expect(panel.legendItems).toHaveLength(1);
  });

  it('surfaces a source error', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    src.events.state('error', 'Stream interrupted');

    expect(panel.status()).toBe('Error');
    expect(panel.errorMessage()).toBe('Stream interrupted');
  });

  it('disconnects its source when destroyed, so closing a plot frees the link', async () => {
    const src = new ManualSource();
    const { fixture } = await mount(src);

    fixture.destroy();
    expect(src.disconnected).toBe(true);
  });

  it('starts docked and pops out to floating', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    expect(panel.floating()).toBe(false);
    panel.popOut();
    expect(panel.floating()).toBe(true);

    panel.dock();
    expect(panel.floating()).toBe(false);
  });

  it('maximizing forces floating so the dock cannot clip it', async () => {
    const src = new ManualSource();
    const { panel } = await mount(src);

    panel.toggleMaximize();
    expect(panel.windowState()).toBe('maximized');
    expect(panel.floating()).toBe(true);
  });

  it('each panel gets its own tooltip element id', async () => {
    const a = await mount(new ManualSource());
    const b = await mount(new ManualSource());
    expect(a.panel.panelId).not.toBe(b.panel.panelId);
  });
});
