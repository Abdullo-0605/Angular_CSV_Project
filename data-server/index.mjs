/**
 * Testbed Data Server
 * --------------------
 * Standalone Node/Express server that simulates the navy testbed feed.
 *
 *  - A generator continuously WRITES rows to a real CSV file on disk
 *    (`live_data.csv`) while running.
 *  - New rows are also pushed to connected plotters over Server-Sent Events
 *    (SSE) so the Angular plotter can build the waveform in real time.
 *
 * Features driven by the Angular UI:
 *  - Start / Stop generation.
 *  - Commanded power profile that ramps from `startWatts` to `endWatts`
 *    over `rampSeconds` (e.g. 0W -> 50W over a timeline), then holds.
 *  - Scheduled start: begin generating at a specific clock time.
 *  - Per-log selection: only the chosen log columns are generated & written,
 *    so the plotter can capture/build a single log in real time.
 *
 * Uses only `express` (already a project dependency) + Node built-ins.
 * No extra installs required.  Run with:  npm run start:data
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE_CSV = path.join(ROOT, 'data_100.csv'); // used only to read real column names
const LIVE_CSV = path.join(ROOT, 'live_data.csv'); // the generator writes here

const PORT = process.env['PORT'] || 4000;
const MAX_SNAPSHOT_ROWS = 5000; // rows kept in memory for late-joining plotters
const CLAMP_MAX_WATTS = 60; // hard ceiling so oscillation/noise can't run away

const app = express();
app.use(express.json());

/* ---------------------------------------------------------------- CORS --- */
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

/* ----------------------------------------------------- column discovery --- */
// Read the available log column names from the reference CSV so the live
// feed uses the exact same names (C1_Voltage, L1_Current, ... Log 103).
function readAvailableColumns() {
  try {
    const text = fs.readFileSync(SOURCE_CSV, 'utf8');
    const firstLine = text.split(/\r?\n/)[0] ?? '';
    const headers = firstLine.split(',').map((h) => h.trim()).filter(Boolean);
    if (headers.length > 1) {
      return headers.slice(1); // drop the leading "Time" column
    }
  } catch {
    /* fall through to default */
  }
  return Array.from({ length: 100 }, (_, i) => `Log ${i + 1}`);
}
const AVAILABLE_COLUMNS = readAvailableColumns();

/* ------------------------------------------------------ generator state --- */
const state = {
  status: 'idle', // idle | scheduled | running | stopped | completed
  config: null,
  columns: [], // column names currently being generated
  startedAt: 0,
  elapsed: 0, // seconds of generated signal
  rowCount: 0,
  scheduledFor: null, // epoch ms of a pending scheduled start
};

let tickTimer = null;
let scheduleTimer = null;
let tickIndex = 0;
let rows = []; // in-memory ring buffer of recent rows (for snapshots)
let logParams = []; // per-column waveform parameters

/** SSE clients */
const clients = new Set();

/* --------------------------------------------------------------- helpers --- */
// Stable pseudo-random in [0,1) seeded by index + salt, so each log column
// gets distinct but reproducible waveform parameters.
function seeded(i, salt) {
  const x = Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function makeLogParams(columns) {
  return columns.map((_, i) => ({
    gain: 0.85 + seeded(i, 1) * 0.3, // 0.85 .. 1.15 of commanded power
    amp: 0.5 + seeded(i, 2) * 2.5, // oscillation amplitude (W)
    freq: 0.05 + seeded(i, 3) * 0.45, // oscillation frequency (Hz)
    phase: seeded(i, 4) * Math.PI * 2, // phase offset
    noise: 0.3, // +/- random noise (W)
  }));
}

// Commanded power (W) at elapsed time t (s): ramp from start -> end, then hold.
function targetWatts(t, cfg) {
  if (cfg.rampSeconds <= 0) return cfg.endWatts;
  if (t <= 0) return cfg.startWatts;
  if (t >= cfg.rampSeconds) return cfg.endWatts;
  return cfg.startWatts + (cfg.endWatts - cfg.startWatts) * (t / cfg.rampSeconds);
}

function valueFor(i, t, cfg) {
  const p = logParams[i];
  const base = targetWatts(t, cfg);
  const osc = p.amp * Math.sin(2 * Math.PI * p.freq * t + p.phase);
  const noise = (Math.random() * 2 - 1) * p.noise;
  let v = base * p.gain + osc + noise;
  if (v < 0) v = 0;
  if (v > CLAMP_MAX_WATTS) v = CLAMP_MAX_WATTS;
  return v;
}

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

function publicStatus(extra = {}) {
  return {
    status: state.status,
    columns: state.columns,
    config: state.config,
    elapsed: Number(state.elapsed.toFixed(3)),
    rowCount: state.rowCount,
    scheduledFor: state.scheduledFor,
    csvFile: LIVE_CSV,
    ...extra,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    try {
      sse(res, event, data);
    } catch {
      clients.delete(res);
    }
  }
}

function clearTimers() {
  if (tickTimer) clearInterval(tickTimer);
  if (scheduleTimer) clearTimeout(scheduleTimer);
  tickTimer = null;
  scheduleTimer = null;
}

/* ------------------------------------------------------- generator loop --- */
function tick() {
  const cfg = state.config;
  const intervalSec = cfg.intervalMs / 1000;
  const t = tickIndex * intervalSec; // clean 0, 0.1, 0.2 ... like the sample CSV
  const time = Number(t.toFixed(3));

  const values = state.columns.map((_, i) => Number(valueFor(i, t, cfg).toFixed(6)));
  const row = { time, values };

  rows.push(row);
  if (rows.length > MAX_SNAPSHOT_ROWS) rows.shift();
  state.rowCount += 1;
  state.elapsed = t;
  tickIndex += 1;

  // Real file write — the CSV keeps growing on disk as data is generated.
  fs.appendFile(LIVE_CSV, `${time},${values.join(',')}\n`, () => {});

  broadcast('row', row);

  // Auto-stop when an optional run duration is reached.
  if (cfg.durationSeconds > 0 && t >= cfg.durationSeconds) {
    stopGenerator('completed');
  }
}

function normalizeConfig(body) {
  return {
    intervalMs: clamp(body.intervalMs, 10, 10000, 100),
    startWatts: clamp(body.startWatts, 0, 1000, 0),
    endWatts: clamp(body.endWatts, 0, 1000, 50),
    rampSeconds: clamp(body.rampSeconds, 0, 100000, 10),
    durationSeconds: clamp(body.durationSeconds, 0, 100000, 0), // 0 = run until stopped
  };
}

function resolveColumns(body) {
  let columns =
    Array.isArray(body.selectedLogs) && body.selectedLogs.length
      ? body.selectedLogs.filter((c) => AVAILABLE_COLUMNS.includes(c))
      : AVAILABLE_COLUMNS.slice();
  if (columns.length === 0) columns = AVAILABLE_COLUMNS.slice(0, 1);
  return columns;
}

function startGenerator(body) {
  clearTimers();

  const config = normalizeConfig(body);
  const columns = resolveColumns(body);

  state.config = config;
  state.columns = columns;
  state.startedAt = Date.now();
  state.elapsed = 0;
  state.rowCount = 0;
  state.scheduledFor = null;
  state.status = 'running';

  logParams = makeLogParams(columns);
  rows = [];
  tickIndex = 0;

  // Truncate the live CSV and write a fresh header for this capture.
  fs.writeFileSync(LIVE_CSV, `Time,${columns.join(',')}\n`);

  // Tell every connected plotter to clear and re-init for the new capture.
  broadcast('reset', {});
  broadcast('meta', { columns, config, status: state.status });
  broadcast('status', publicStatus());

  tickTimer = setInterval(tick, config.intervalMs);
  console.log(
    `[generator] started — ${columns.length} log(s), ${config.startWatts}W -> ${config.endWatts}W over ${config.rampSeconds}s @ ${config.intervalMs}ms`,
  );
}

function scheduleGenerator(body) {
  clearTimers();

  const startEpochMs = Number(body.startEpochMs);
  const delay = Number.isFinite(startEpochMs) ? startEpochMs - Date.now() : -1;

  // No future time supplied -> start immediately.
  if (!Number.isFinite(startEpochMs) || delay <= 0) {
    startGenerator(body);
    return;
  }

  state.status = 'scheduled';
  state.config = normalizeConfig(body);
  state.columns = resolveColumns(body);
  state.scheduledFor = startEpochMs;
  state.rowCount = 0;
  state.elapsed = 0;

  broadcast('status', publicStatus());
  scheduleTimer = setTimeout(() => startGenerator(body), delay);
  console.log(`[generator] scheduled to start in ${(delay / 1000).toFixed(1)}s`);
}

function stopGenerator(reason = 'stopped') {
  clearTimers();
  state.status = reason === 'completed' ? 'completed' : 'stopped';
  state.scheduledFor = null;
  broadcast('status', publicStatus());
  console.log(`[generator] ${state.status} at ${state.elapsed.toFixed(1)}s (${state.rowCount} rows)`);
}

/* ------------------------------------------------------------ endpoints --- */
app.get('/api/logs', (_req, res) => {
  res.json({ columns: AVAILABLE_COLUMNS });
});

app.get('/api/status', (_req, res) => {
  res.json(publicStatus());
});

app.post('/api/start', (req, res) => {
  scheduleGenerator(req.body || {});
  res.json(publicStatus());
});

app.post('/api/stop', (_req, res) => {
  stopGenerator('stopped');
  res.json(publicStatus());
});

app.post('/api/reset', (_req, res) => {
  clearTimers();
  state.status = 'idle';
  state.columns = [];
  state.config = null;
  state.rowCount = 0;
  state.elapsed = 0;
  state.scheduledFor = null;
  rows = [];
  tickIndex = 0;
  try {
    fs.writeFileSync(LIVE_CSV, '');
  } catch {
    /* ignore */
  }
  broadcast('reset', {});
  broadcast('status', publicStatus());
  res.json(publicStatus());
});

app.get('/api/download', (_req, res) => {
  if (!fs.existsSync(LIVE_CSV)) {
    return res.status(404).send('No live data has been generated yet.');
  }
  res.download(LIVE_CSV, 'live_data.csv');
});

// Server-Sent Events stream — the plotter subscribes here and receives a
// catch-up snapshot followed by every new row in real time.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n');

  clients.add(res);

  // Catch the new client up with the current capture.
  sse(res, 'meta', { columns: state.columns, config: state.config, status: state.status });
  if (rows.length) {
    sse(res, 'snapshot', { rows });
  }
  sse(res, 'status', publicStatus());

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

/* ---------------------------------------------------------------- root --- */
app.get('/', (_req, res) => {
  res.json({
    service: 'testbed-data-server',
    status: state.status,
    columns: AVAILABLE_COLUMNS.length,
    liveCsv: LIVE_CSV,
    endpoints: ['/api/logs', '/api/status', '/api/start', '/api/stop', '/api/reset', '/api/stream', '/api/download'],
  });
});

app.listen(PORT, () => {
  console.log(`Testbed data server listening on http://localhost:${PORT}`);
  console.log(`Discovered ${AVAILABLE_COLUMNS.length} log columns from ${path.basename(SOURCE_CSV)}`);
  console.log(`Generated data will be written to ${LIVE_CSV}`);
});
