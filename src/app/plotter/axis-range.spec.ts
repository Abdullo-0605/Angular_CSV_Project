import { describe, expect, it } from 'vitest';
import { LatchedBounds, computeXWindow, computeYRange } from './axis-range';

const NONE: LatchedBounds = { min: null, max: null };

describe('computeXWindow', () => {
  it('fits all data when the window is 0 (auto rescale)', () => {
    expect(computeXWindow(0, 12.5, 0)).toEqual({ min: 0, max: 12.5 });
  });

  it('pins a fixed-width window to the newest sample', () => {
    // 10 s of data, 2 s window -> show 8..10
    expect(computeXWindow(0, 10, 2)).toEqual({ min: 8, max: 10 });
  });

  it('supports sub-second windows', () => {
    const w = computeXWindow(0, 3.5, 0.1);
    expect(w.max - w.min).toBeCloseTo(0.1, 10);
    expect(w.max).toBe(3.5);
  });

  it('keeps the window width constant as time advances', () => {
    const a = computeXWindow(0, 5, 1);
    const b = computeXWindow(0, 50, 1);
    expect(a.max - a.min).toBeCloseTo(b.max - b.min, 10);
  });

  it('never produces a zero-width axis for a single sample', () => {
    const w = computeXWindow(4, 4, 0);
    expect(w.max).toBeGreaterThan(w.min);
  });
});

describe('computeYRange', () => {
  const base = {
    latch: false,
    locked: false,
    manualMin: null,
    manualMax: null,
    latched: NONE,
    padRatio: 0,
  };

  it('autoscales to the data when nothing else is set', () => {
    const { range } = computeYRange({ ...base, dataMin: -2, dataMax: 8 });
    expect(range).toEqual({ min: -2, max: 8 });
  });

  it('manual bounds take priority over everything', () => {
    const { range } = computeYRange({
      ...base,
      dataMin: 0,
      dataMax: 1,
      latch: true,
      locked: true,
      latched: { min: -50, max: 50 },
      manualMin: -5,
      manualMax: 5,
    });
    expect(range).toEqual({ min: -5, max: 5 });
  });

  it('ignores manual bounds that are incomplete or inverted', () => {
    const onlyMin = computeYRange({ ...base, dataMin: 0, dataMax: 4, manualMin: -1 });
    expect(onlyMin.range).toEqual({ min: 0, max: 4 });

    const inverted = computeYRange({
      ...base,
      dataMin: 0,
      dataMax: 4,
      manualMin: 9,
      manualMax: 1,
    });
    expect(inverted.range).toEqual({ min: 0, max: 4 });
  });

  describe('latching (grow-only)', () => {
    it('expands to include a new maximum', () => {
      const first = computeYRange({ ...base, latch: true, dataMin: 0, dataMax: 10 });
      expect(first.latched).toEqual({ min: 0, max: 10 });

      const second = computeYRange({
        ...base,
        latch: true,
        latched: first.latched,
        dataMin: 2,
        dataMax: 25,
      });
      expect(second.latched).toEqual({ min: 0, max: 25 });
      expect(second.range).toEqual({ min: 0, max: 25 });
    });

    it('does NOT shrink when the signal calms down', () => {
      const wide = computeYRange({ ...base, latch: true, dataMin: -30, dataMax: 30 });
      const calm = computeYRange({
        ...base,
        latch: true,
        latched: wide.latched,
        dataMin: -1,
        dataMax: 1,
      });
      // this is the whole point: a transient spike keeps the scale it earned
      expect(calm.range).toEqual({ min: -30, max: 30 });
    });

    it('shrinks when latching is off', () => {
      const wide = computeYRange({ ...base, latch: true, dataMin: -30, dataMax: 30 });
      const calm = computeYRange({
        ...base,
        latch: false,
        latched: wide.latched,
        dataMin: -1,
        dataMax: 1,
      });
      expect(calm.range).toEqual({ min: -1, max: 1 });
    });
  });

  describe('lock', () => {
    it('holds the latched range even as data exceeds it', () => {
      const { range } = computeYRange({
        ...base,
        locked: true,
        latched: { min: 0, max: 10 },
        dataMin: -100,
        dataMax: 100,
      });
      expect(range).toEqual({ min: 0, max: 10 });
    });

    it('falls through to autoscale if nothing has been latched yet', () => {
      const { range } = computeYRange({ ...base, locked: true, dataMin: 1, dataMax: 3 });
      expect(range).toEqual({ min: 1, max: 3 });
    });
  });

  it('leaves the axis alone when there is no data', () => {
    const { range } = computeYRange({ ...base, dataMin: null, dataMax: null });
    expect(range).toBeNull();
  });

  it('gives a flat trace a drawable range instead of zero height', () => {
    const { range } = computeYRange({
      ...base,
      padRatio: 0.05,
      dataMin: 5,
      dataMax: 5,
    });
    expect(range!.max).toBeGreaterThan(range!.min);
  });

  it('applies proportional padding', () => {
    const { range } = computeYRange({
      ...base,
      padRatio: 0.1,
      dataMin: 0,
      dataMax: 10,
    });
    expect(range).toEqual({ min: -1, max: 11 });
  });
});
