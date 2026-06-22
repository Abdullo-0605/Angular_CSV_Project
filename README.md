# CsvWaveformPlotter

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.3.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Real-time testbed feed (data server)

The Live Capture feature is fed by a standalone Node/Express **data server** that
simulates the testbed: a generator continuously writes rows to a real CSV file
on disk (`live_data.csv`) and streams each new row to the plotter over
Server-Sent Events (SSE).

Run it in a **separate terminal** alongside `ng serve`:

```bash
npm run start:data
```

It listens on `http://localhost:4000` (override with the `PORT` env var) and
exposes:

| Method | Endpoint        | Purpose                                              |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/api/logs`     | Available log column names                           |
| POST   | `/api/start`    | Start/schedule generation (power ramp, logs, timing) |
| POST   | `/api/stop`     | Stop generation                                      |
| POST   | `/api/reset`    | Stop + clear the live CSV                            |
| GET    | `/api/status`   | Current generator status                             |
| GET    | `/api/stream`   | SSE stream consumed by the plotter                   |
| GET    | `/api/download` | Download the generated `live_data.csv`               |

In the app, open **Live Capture**, set the power range (e.g. 0 W → 50 W) and
ramp/timeline, optionally schedule a start time, check which log(s) to capture,
then press **Start**. The plotter builds the waveform in real time as the CSV is
written. Double-click a legend entry to display only that trace.

> The data server is decoupled behind `LiveDataService`, so the simulated
> generator can later be replaced by the real testbed feed without changing the
> plotter.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
