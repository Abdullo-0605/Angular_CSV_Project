import { Component, ViewChild, signal } from '@angular/core';
import { DataPlotter } from './plotter/plotter.component';
import { TestbedSimulator } from './simulator/simulator.component';
import { WaveformSource } from './data-sources';

/**
 * Application shell.
 *
 * Hosts the DataPlotter (the deliverable) and, below it, the dev-only testbed
 * simulator. The shell is the only thing that knows about both: it forwards the
 * simulator's source to the plotter. When this is folded into the HMI, drop the
 * simulator import and render <datalogger-dataplotter /> on its own.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [DataPlotter, TestbedSimulator],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  @ViewChild(DataPlotter) plotter?: DataPlotter;

  /** Collapsed by default — the simulator is not the point of this screen. */
  simulatorOpen = signal(false);

  /** Hand a simulator-provided feed to the plotter. */
  onSimulatorSource(source: WaveformSource) {
    this.plotter?.attachSource(source);
  }
}
