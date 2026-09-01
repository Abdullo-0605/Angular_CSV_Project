# DataLogger — DataPlotter

Angular 21 waveform plotter for the power electronics testbed digital twin.
This repo is the **DataPlotter** portion of the DataLogger module, intended to
be folded into the larger HMI application.

## Commands

| Task | Command |
| --- | --- |
| Dev server | `npm start` (add `-- --port 4300` if 4200 is taken) |
| Testbed simulator (dev only) | `npm run start:data` (serves on :4000) |
| Unit tests | `npm test` |
| Production build | `npm run build` |

Run the simulator in a second terminal if you want live data without hardware.

## Layout

```
src/app/
  plotter/            <- THE DELIVERABLE
    plotter.component.*    standalone <datalogger-dataplotter>
    axis-range.ts          pure windowing + y-latching maths
  data-sources/       <- transport adapters behind one interface
    waveform-source.ts     WaveformSource interface + CSV parsing
    csv-file.source.ts     static: File or raw text
    websocket.source.ts    stream: ws://, auto-reconnect
    sse.source.ts          stream: EventSource
    http-poll.source.ts    stream: polls a REST/CSV endpoint
    serial.source.ts       stream: Web Serial (direct USB UART)
  simulator/          <- DEV ONLY, delete for HMI integration
  app.ts/.html/.css   <- demo shell wiring the two together
data-server/          <- DEV ONLY generator behind the simulator
```

## HMI integration

The plotter is a standalone component, so there is no NgModule wiring:

```ts
import { DataPlotter } from './plotter/plotter.component';

@Component({ imports: [DataPlotter], template: `
  <datalogger-dataplotter #plot [windowSeconds]="2" [plotHeight]="420" />
` })
export class SomeHmiScreen {
  @ViewChild('plot') plot!: DataPlotter;
}
```

Feed it data — no file dialog required:

```ts
// live testbed feed
this.plot.attachSource(new WebSocketWaveformSource({ url: 'ws://testbed/telemetry' }));

// data the HMI already holds
this.plot.plotCsvText(csvString, 'run-42.csv');
this.plot.plotFile(file);

this.plot.detachSource();
this.plot.snapshot();   // { columns, samples } for export
```

**To remove the simulator:** delete `src/app/simulator/` and `data-server/`,
drop `TestbedSimulator` from `app.ts` / `app.html`, and remove the `start:data`
script. Nothing in `plotter/` or `data-sources/` references either.

## Adding a transport

Browsers cannot speak Modbus TCP, OPC UA or MQTT directly, so those need a
gateway that republishes samples over WebSocket/SSE. For anything else,
implement `WaveformSource` (`kind`, `label`, `mode`, `connect`, `disconnect`)
and emit `meta` before the first `sample`. `mode: 'static'` sources are plotted
in full; `mode: 'stream'` sources get the sliding time window.

Helpers in `waveform-source.ts` worth reusing:
- `splitCompleteLines()` — hold back partial trailing lines. Network and serial
  reads split mid-line constantly; skipping this silently corrupts samples.
- `strictNumber()` — `Number('')` is **0**, so a blank or truncated field would
  otherwise become a real-looking 0 V / 0 A reading. Always reject blanks.

## Behaviour notes

- **Time window** — `windowSeconds > 0` pins a fixed-width x axis anchored to
  the newest sample; `0` keeps rescaling to fit. Static files ignore it.
- **Y axis** priority: manual min+max > lock > latch (grow-only) > autoscale.
  Latching is on by default so a transient spike keeps the scale it earned.
- **Zoom** — horizontal and vertical are independently toggleable; unchecking
  both disables zoom/pan entirely.
- **Legend** — checkbox toggles visibility, single click highlights, double
  click isolates. Hiding traces re-evaluates the y extent.
- Redraws are coalesced into one `requestAnimationFrame`, so a 10 ms feed
  cannot outrun the renderer.
- `Chart.register(zoomPlugin)` runs lazily in the constructor, not at module
  scope, because module-scope registration breaks the SSR prerender.

## Gotchas

- Do **not** keep a working copy inside OneDrive. Files On-Demand turns sources
  into cloud placeholders that tools cannot read (`The cloud file provider is
  not running`), and syncing `node_modules` / `.angular/cache` causes spurious
  build failures.
- Web Serial requires Chrome/Edge on https:// or localhost, and `connect()`
  must be triggered by a user gesture (the port picker cannot be bypassed).
- The plotter and the simulator each open their own SSE connection to the data
  server. That is intentional — the plotter subscribes as an ordinary client so
  it behaves identically with the simulator absent.
