import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DataPlotter } from './plotter.component';
import { WaveformSource, WaveformSourceEvents } from '../data-sources';

class ManualSource implements WaveformSource {
  readonly kind = 'manual';
  events!: WaveformSourceEvents;
  disconnected = false;

  constructor(
    readonly label = 'Manual source',
    readonly mode: 'static' | 'stream' = 'stream',
  ) {}

  async connect(events: WaveformSourceEvents) {
    this.events = events;
    events.state('connected');
  }
  disconnect() {
    this.disconnected = true;
  }
}

function createPlotter() {
  const fixture = TestBed.createComponent(DataPlotter);
  return { fixture, plotter: fixture.componentInstance };
}

describe('DataPlotter', () => {
  it('starts with no plots open and no dock', () => {
    const { plotter } = createPlotter();
    expect(plotter.plots()).toHaveLength(0);
  });

  it('opens a plot per attached source, leaving earlier ones running', () => {
    const { plotter } = createPlotter();
    const first = new ManualSource('feed A');
    const second = new ManualSource('feed B');

    const idA = plotter.attachSource(first);
    const idB = plotter.attachSource(second);

    expect(plotter.plots()).toHaveLength(2);
    expect(idA).not.toBe(idB);
    // stack order: first opened stays on top
    expect(plotter.plots().map((p) => p.title)).toEqual(['feed A', 'feed B']);
    expect(first.disconnected).toBe(false);
  });

  it('closes a single plot by id and leaves the rest', () => {
    const { plotter } = createPlotter();
    const idA = plotter.attachSource(new ManualSource('A'));
    plotter.attachSource(new ManualSource('B'));

    plotter.closePlot(idA);

    expect(plotter.plots()).toHaveLength(1);
    expect(plotter.plots()[0].title).toBe('B');
  });

  it('closeAll() empties the dock', () => {
    const { plotter } = createPlotter();
    plotter.attachSource(new ManualSource('A'));
    plotter.attachSource(new ManualSource('B'));

    plotter.closeAll();
    expect(plotter.plots()).toHaveLength(0);
  });

  it('snapshots each new plot with the current defaults', () => {
    const { plotter } = createPlotter();
    plotter.defaultWindowSeconds.set(2);
    plotter.attachSource(new ManualSource('A'));

    // changing the default must not retro-edit the already-open plot
    plotter.defaultWindowSeconds.set(10);
    plotter.attachSource(new ManualSource('B'));

    expect(plotter.plots()[0].settings.windowSeconds).toBe(2);
    expect(plotter.plots()[1].settings.windowSeconds).toBe(10);
  });

  it('plotCsvText opens a plot titled with the label', () => {
    const { plotter } = createPlotter();
    plotter.plotCsvText('Time,A\n0,1\n', 'run-42.csv');

    expect(plotter.plots()).toHaveLength(1);
    expect(plotter.plots()[0].title).toBe('run-42.csv');
    expect(plotter.plots()[0].source.mode).toBe('static');
  });

  it('reopening the dock when a plot is added while collapsed', () => {
    const { plotter } = createPlotter();
    plotter.dockCollapsed.set(true);

    plotter.attachSource(new ManualSource('A'));
    expect(plotter.dockCollapsed()).toBe(false);
  });

  it('rejects an empty endpoint instead of opening a dead plot', () => {
    const { plotter } = createPlotter();
    plotter.pickerKind.set('websocket');
    plotter.wsUrl.set('   ');

    plotter.connectPickedSource();

    expect(plotter.plots()).toHaveLength(0);
    expect(plotter.pickerError()).toBeTruthy();
  });

  it('snapshot() returns null when nothing is open', () => {
    const { plotter } = createPlotter();
    expect(plotter.snapshot()).toBeNull();
  });
});
