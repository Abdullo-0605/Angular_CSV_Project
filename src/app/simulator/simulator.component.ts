import { Component, OnDestroy, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveDataService, LiveStatus } from './live-data.service';
import { SseWaveformSource, WaveformSource } from '../data-sources';

/**
 * TESTBED SIMULATOR (development / bench-test only)
 * -------------------------------------------------
 * Control panel for the bundled `data-server` generator: it ramps commanded
 * power, writes a real growing CSV on disk, and streams rows over SSE.
 *
 * This component exists ONLY to exercise the plotter without real hardware and
 * is not part of the deliverable HMI integration. It is deliberately kept at
 * arm's length from the plotter: it never touches the chart. When a capture
 * starts it simply hands the plotter an `SseWaveformSource` pointing at the
 * data server, the same way any real testbed feed would be attached.
 *
 * Deleting this folder (and `data-server/`) leaves the plotter fully working.
 */
@Component({
  selector: 'testbed-simulator',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './simulator.component.html',
  styleUrl: './simulator.component.css',
})
export class TestbedSimulator implements OnInit, OnDestroy {
  private live = inject(LiveDataService);

  /** Emitted when a capture starts, so the host can plot the live feed. */
  readonly plotSource = output<WaveformSource>();

  liveConnected = this.live.connected;
  liveStatus = signal<LiveStatus | null>(null);
  availableLogs = signal<string[]>([]);
  selectedLogs = signal<string[]>([]);
  logFilter = signal('');
  liveError = signal('');

  // live capture form inputs (bound in the template)
  startWatts = signal(0);
  endWatts = signal(50);
  rampSeconds = signal(10);
  intervalMs = signal(100);
  durationSeconds = signal(0); // 0 = run until stopped
  scheduledTime = signal(''); // datetime-local string; empty = start now

  // a 1s heartbeat used to render the scheduled-start countdown
  nowMs = signal(Date.now());
  private clockTimer: any = null;

  ngOnInit() {
    this.live.onStatus = (status) => this.liveStatus.set(status);

    this.live
      .fetchLogs()
      .then((cols) => {
        this.availableLogs.set(cols);
        // sensible default: capture the first named channel
        if (this.selectedLogs().length === 0 && cols.length) {
          this.selectedLogs.set([cols[0]]);
        }
      })
      .catch(() =>
        this.liveError.set('Data server offline — run "npm run start:data" to enable the simulator.'),
      );

    this.live.connectStream();

    if (typeof window !== 'undefined') {
      this.clockTimer = setInterval(() => this.nowMs.set(Date.now()), 1000);
    }
  }

  ngOnDestroy() {
    this.live.disconnectStream();
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  // --- log selection helpers ---
  filteredLogs(): string[] {
    const q = this.logFilter().trim().toLowerCase();
    const all = this.availableLogs();
    return q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  }

  isLogSelected(name: string): boolean {
    return this.selectedLogs().includes(name);
  }

  toggleLog(name: string) {
    const set = new Set(this.selectedLogs());
    set.has(name) ? set.delete(name) : set.add(name);
    this.selectedLogs.set([...set]);
  }

  selectOnlyLog(name: string) {
    this.selectedLogs.set([name]);
  }

  selectAllLogs() {
    this.selectedLogs.set([...this.availableLogs()]);
  }

  clearSelectedLogs() {
    this.selectedLogs.set([]);
  }

  // --- capture controls ---
  async startLive() {
    this.liveError.set('');
    const logs = this.selectedLogs();
    if (logs.length === 0) {
      this.liveError.set('Select at least one log to capture.');
      return;
    }

    const scheduled = this.scheduledTime();
    let startEpochMs: number | undefined;
    if (scheduled) {
      const t = new Date(scheduled).getTime();
      if (Number.isFinite(t)) startEpochMs = t;
    }

    const config = {
      intervalMs: Number(this.intervalMs()) || 100,
      startWatts: Number(this.startWatts()) || 0,
      endWatts: Number(this.endWatts()) || 0,
      rampSeconds: Number(this.rampSeconds()) || 0,
      durationSeconds: Number(this.durationSeconds()) || 0,
      selectedLogs: logs,
      startEpochMs,
    };

    // Attach the plotter to the server's stream, then start generating. The
    // plotter treats this exactly like a real testbed feed.
    this.plotSource.emit(
      new SseWaveformSource({
        url: `${this.live.apiBase}/api/stream`,
        label: 'Testbed simulator (SSE)',
        yAxisLabel: 'Power (W)',
      }),
    );

    try {
      await this.live.start(config);
    } catch {
      this.liveError.set('Could not reach the data server. Is "npm run start:data" running?');
    }
  }

  async stopLive() {
    try {
      await this.live.stop();
    } catch {
      this.liveError.set('Could not reach the data server.');
    }
  }

  async resetLive() {
    try {
      await this.live.reset();
    } catch {
      this.liveError.set('Could not reach the data server.');
    }
  }

  downloadLive() {
    if (typeof window !== 'undefined') {
      window.open(this.live.downloadUrl(), '_blank');
    }
  }

  /** Seconds remaining until a scheduled capture starts (null if not scheduled). */
  scheduledCountdown(): number | null {
    const status = this.liveStatus();
    if (!status || status.status !== 'scheduled' || !status.scheduledFor) return null;
    return Math.max(0, Math.ceil((status.scheduledFor - this.nowMs()) / 1000));
  }

  isLiveRunning(): boolean {
    const s = this.liveStatus()?.status;
    return s === 'running' || s === 'scheduled';
  }
}
