// @ts-check
// One More Speedtest — browser client.
// Measures latency/jitter, download and upload throughput against this server.

const CONNECTIONS = {
  single: { streams: 1, label: "Single connection" },
  // Browsers allow 6 HTTP/1.1 connections per host; one is left free for
  // the latency probe that runs during the transfer.
  multi: { streams: 5, label: "Multi connection" },
};

const DURATIONS = {
  basic: { pings: 20, seconds: 10, grace: 1.5, label: "Basic run" },
  long: { pings: 50, seconds: 30, grace: 3, label: "Long run" },
};

const DOWNLOAD_REQUEST_SIZE = 256 << 20; // bytes per download request; aborted when the phase ends
const UPLOAD_MIN_CHUNK = 1 << 20;
const UPLOAD_MAX_CHUNK = 32 << 20;
const TICK_MS = 100;
const LIVE_WINDOW_S = 1; // window for the live (gauge) speed
const LOADED_PING_INTERVAL_MS = 200; // latency probe rate during transfers

/**
 * The test settings picked on the page.
 * @typedef {object} Mode
 * @property {keyof typeof CONNECTIONS} connections
 * @property {keyof typeof DURATIONS} duration
 * @property {number} streams  parallel transfers per direction
 * @property {number} pings  idle latency samples
 * @property {number} seconds  length of each transfer phase
 * @property {number} grace  warm-up seconds left out of the results
 * @property {string} label
 */

/** @typedef {"download" | "upload"} Direction */
/** @typedef {"ping" | "jitter" | Direction} MetricKind */
/** @typedef {{ping: number, jitter: number}} LatencyStats  milliseconds */

/**
 * One transfer phase.
 * @typedef {object} Throughput
 * @property {number} mbps  speed after the warm-up
 * @property {number} bytes  everything transferred, warm-up included
 * @property {number[]} series  live speed per tick, Mbps
 * @property {LatencyStats | null} latency  latency under load
 */

/**
 * A finished test.
 * @typedef {LatencyStats & {
 *   download: number,
 *   upload: number,
 *   downloadSeries: number[],
 *   uploadSeries: number[],
 *   loaded: Record<Direction, LatencyStats | null>,
 *   mode: Mode,
 *   date: Date,
 *   host: string,
 * }} Result
 */

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Returns the element matching `sel` in `root`; the page markup guarantees it exists.
 * @template {Element} [T=HTMLElement]
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {T}
 */
const $ = (sel, root = document) => /** @type {T} */ (root.querySelector(sel));

const ui = {
  start: $("#start"),
  cancel: $("#cancel"),
  status: $("#status"),
  gauge: $("#gauge"),
  track: /** @type {SVGPathElement} */ ($("#gauge-track")),
  fill: /** @type {SVGPathElement} */ ($("#gauge-fill")),
  ticks: /** @type {SVGGElement} */ ($("#gauge-ticks")),
  readout: $("#readout"),
  readoutPhase: $("#readout-phase"),
  readoutValue: $("#readout-value"),
  readoutUnit: $("#readout-unit"),
  readoutLatency: $("#readout-latency"),
  progress: $("#progress-bar"),
  modeHint: $("#mode-hint"),
  client: $("#client-info"),
  fieldsets: /** @type {NodeListOf<HTMLFieldSetElement>} */ (document.querySelectorAll(".controls .segmented")),
  metrics: {
    ping: $("#m-ping"),
    jitter: $("#m-jitter"),
    download: $("#m-download"),
    upload: $("#m-upload"),
  },
  dialog: /** @type {HTMLDialogElement} */ ($("#results")),
  resultsImage: /** @type {HTMLImageElement} */ ($("#results-image")),
  resultsNote: $("#results-note"),
  saveImage: $("#save-image"),
  copyImage: $("#copy-image"),
  again: $("#again"),
  toast: $("#toast"),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rand = () => Math.random().toString(36).slice(2);

function abortError() {
  return new DOMException("The test was cancelled", "AbortError");
}

/** @param {number} mbps */
function fmtSpeed(mbps) {
  if (!Number.isFinite(mbps)) return "—";
  if (mbps < 10) return mbps.toFixed(2);
  if (mbps < 100) return mbps.toFixed(1);
  return mbps.toFixed(0);
}

/** @param {number} ms */
function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 10 ? ms.toFixed(1) : ms.toFixed(0);
}

/** @param {number[]} values */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {string} name
 * @returns {string}
 */
function checkedValue(name) {
  return /** @type {HTMLInputElement} */ ($(`input[name="${name}"]:checked`)).value;
}

/** @returns {Mode} */
function selectedMode() {
  const connections = /** @type {Mode["connections"]} */ (checkedValue("connections"));
  const duration = /** @type {Mode["duration"]} */ (checkedValue("duration"));
  return { connections, duration, ...CONNECTIONS[connections], ...DURATIONS[duration] };
}

/** @param {string} name */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let toastTimer = 0;
/** @param {string} message */
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 5000);
}

/* ------------------------------------------------------------------ */
/* Latency                                                             */
/* ------------------------------------------------------------------ */

/**
 * One round trip to the server, ms. Uses Resource Timing (request → first
 * byte) when available, which excludes JS scheduling noise; falls back to
 * wall clock.
 * @param {AbortSignal} signal
 * @returns {Promise<number>}
 */
async function pingOnce(signal) {
  const url = new URL(`/api/ping?r=${rand()}`, location.href).href;
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store", signal });
  await res.arrayBuffer();
  const wall = performance.now() - t0;
  if (!res.ok) throw new Error(`Ping failed: HTTP ${res.status}`);

  const entry = /** @type {PerformanceResourceTiming | undefined} */ (performance.getEntriesByName(url).pop());
  if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
    return entry.responseStart - entry.requestStart;
  }
  return wall;
}

/**
 * Ping is the median RTT; jitter is the mean absolute difference between
 * consecutive RTT samples (the approach used by most browser speed tests).
 * @param {number[]} samples
 * @returns {LatencyStats}
 */
function latencyStats(samples) {
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i] - samples[i - 1]);
  return {
    ping: median(samples),
    jitter: samples.length > 1 ? jitter / (samples.length - 1) : 0,
  };
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal  ends the sleep early
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Pings the server while a transfer saturates the link ("loaded latency"),
 * which reveals bufferbloat. One probe is in flight at a time; samples taken
 * during the warm-up are skipped, like the warm-up bytes.
 * @param {AbortSignal} signal  stops the probe
 * @param {number} grace  warm-up, s
 * @param {(stats: LatencyStats) => void} onUpdate
 * @returns {Promise<LatencyStats | null>}
 */
async function probeLoadedLatency(signal, grace, onUpdate) {
  const start = performance.now();
  const samples = [];
  while (!signal.aborted) {
    const t0 = performance.now();
    try {
      const rtt = await pingOnce(signal);
      if ((t0 - start) / 1000 >= grace && !signal.aborted) {
        samples.push(rtt);
        onUpdate(latencyStats(samples));
      }
    } catch {
      // A lost probe under heavy load is not fatal; the transfer decides success.
    }
    await sleep(LOADED_PING_INTERVAL_MS - (performance.now() - t0), signal);
  }
  return samples.length ? latencyStats(samples) : null;
}

/**
 * @param {number} count  samples to take
 * @param {AbortSignal} signal
 * @param {(stats: LatencyStats, progress: number) => void} onUpdate
 * @returns {Promise<LatencyStats>}
 */
async function measureLatency(count, signal, onUpdate) {
  await pingOnce(signal); // warm-up: opens the connection, not counted
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push(await pingOnce(signal));
    onUpdate(latencyStats(samples), (i + 1) / count);
  }
  return latencyStats(samples);
}

/* ------------------------------------------------------------------ */
/* Throughput                                                          */
/* ------------------------------------------------------------------ */

/**
 * One download stream: fetches until stopped, reporting every chunk.
 * @param {AbortSignal} signal
 * @param {(bytes: number) => void} add
 */
async function downloadWorker(signal, add) {
  while (!signal.aborted) {
    const res = await fetch(`/api/download?size=${DOWNLOAD_REQUEST_SIZE}&r=${rand()}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      add(value.byteLength);
    }
  }
}

/** @type {Uint8Array<ArrayBuffer> | undefined} */
let randomBlock;
/** @type {Map<number, Blob>} */
const blobCache = new Map();

/**
 * An upload body of `size` bytes (a multiple of UPLOAD_MIN_CHUNK) of random data.
 * @param {number} size
 * @returns {Blob}
 */
function uploadBlob(size) {
  if (!randomBlock) {
    randomBlock = new Uint8Array(UPLOAD_MIN_CHUNK);
    for (let i = 0; i < randomBlock.length; i += 65536) {
      crypto.getRandomValues(randomBlock.subarray(i, i + 65536));
    }
  }
  let blob = blobCache.get(size);
  if (!blob) {
    blob = new Blob(Array(size / UPLOAD_MIN_CHUNK).fill(randomBlock), { type: "application/octet-stream" });
    blobCache.set(size, blob);
  }
  return blob;
}

/**
 * Sends one upload request; resolves when it completes or is aborted.
 * XHR is used because it reports upload progress in every browser.
 * @param {AbortSignal} signal
 * @param {(bytes: number) => void} add
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
function uploadOnce(signal, add, blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let sent = 0;
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    xhr.upload.onprogress = (e) => {
      add(e.loaded - sent);
      sent = e.loaded;
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        return;
      }
      add(blob.size - sent);
      sent = blob.size;
      resolve();
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.onabort = () => resolve();
    xhr.onloadend = () => signal.removeEventListener("abort", onAbort);

    xhr.open("POST", `/api/upload?r=${rand()}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(blob);
  });
}

/**
 * One upload stream: sends requests until stopped.
 * @param {AbortSignal} signal
 * @param {(bytes: number) => void} add
 */
async function uploadWorker(signal, add) {
  let size = UPLOAD_MIN_CHUNK;
  while (!signal.aborted) {
    const t0 = performance.now();
    await uploadOnce(signal, add, uploadBlob(size));
    // Grow requests on fast links so per-request overhead stays negligible.
    if (performance.now() - t0 < 1000 && size < UPLOAD_MAX_CHUNK) size *= 2;
  }
}

/**
 * Runs `streams` parallel workers for `seconds` and reports throughput and
 * latency under load. The first `grace` seconds (TCP slow start, connection
 * setup) are excluded from the final result.
 * @param {Direction} kind
 * @param {Pick<Mode, "streams" | "seconds" | "grace">} mode
 * @param {AbortSignal} signal
 * @param {(live: number, progress: number, series: number[]) => void} onTick  live speed, Mbps
 * @param {(stats: LatencyStats) => void} onLatency
 * @returns {Promise<Throughput>}
 */
function measureThroughput(kind, { streams, seconds, grace }, signal, onTick, onLatency) {
  const worker = kind === "download" ? downloadWorker : uploadWorker;
  const ctrl = new AbortController();
  const stopWorkers = () => ctrl.abort();
  signal.addEventListener("abort", stopWorkers, { once: true });

  let bytes = 0;
  let failed = 0;
  /** @type {unknown} */
  let lastError;
  /** @param {number} n */
  const add = (n) => {
    if (!ctrl.signal.aborted && n > 0) bytes += n;
  };

  const workers = Array.from({ length: streams }, () =>
    worker(ctrl.signal, add).catch((err) => {
      if (ctrl.signal.aborted) return;
      failed++;
      lastError = err;
    }),
  );
  const latency = probeLoadedLatency(ctrl.signal, grace, onLatency);

  const start = performance.now();
  const history = [{ t: 0, bytes: 0 }];
  /** @type {number[]} */
  const series = [];

  return new Promise((resolve, reject) => {
    /** @param {unknown} [err] */
    const finish = async (err) => {
      clearInterval(timer);
      ctrl.abort();
      signal.removeEventListener("abort", stopWorkers);
      await Promise.allSettled(workers);
      if (err) reject(err);
      else resolve({ ...result(), latency: await latency });
    };

    const result = () => {
      const end = history[history.length - 1];
      const from = history.find((h) => h.t >= grace) ?? history[0];
      const span = end.t - from.t;
      const mbps = span > 0 ? ((end.bytes - from.bytes) * 8) / span / 1e6 : 0;
      return { mbps, bytes: end.bytes, series };
    };

    const timer = setInterval(() => {
      if (signal.aborted) return finish(abortError());
      if (failed === streams) return finish(lastError ?? new Error(`${kind} failed`));

      const t = (performance.now() - start) / 1000;
      history.push({ t, bytes });
      const ref = history.findLast((h) => h.t <= t - LIVE_WINDOW_S) ?? history[0];
      const live = t > ref.t ? ((bytes - ref.bytes) * 8) / (t - ref.t) / 1e6 : 0;
      series.push(live);
      onTick(live, Math.min(t / seconds, 1), series);

      if (t >= seconds) finish();
    }, TICK_MS);
  });
}

/* ------------------------------------------------------------------ */
/* Gauge                                                               */
/* ------------------------------------------------------------------ */

const GAUGE = { cx: 150, cy: 150, r: 122, start: 135, sweep: 270, labelR: 92 };
const SCALES = [
  [0, 5, 10, 50, 100, 250, 500, 750, 1000],
  [0, 100, 250, 500, 1000, 2500, 5000, 7500, 10000],
];

const gauge = {
  scale: SCALES[0],
  target: 0,
  shown: 0,
  raf: 0,
};

/**
 * @param {number} deg
 * @param {number} r
 * @returns {[number, number]}
 */
function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [GAUGE.cx + r * Math.cos(a), GAUGE.cy + r * Math.sin(a)];
}

/**
 * SVG path of the gauge arc filled up to `frac` (0–1).
 * @param {number} frac
 */
function arcPath(frac) {
  const end = GAUGE.start + GAUGE.sweep * frac;
  const [x0, y0] = polar(GAUGE.start, GAUGE.r);
  const [x1, y1] = polar(end, GAUGE.r);
  const large = GAUGE.sweep * frac > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${GAUGE.r} ${GAUGE.r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Position of `v` on the piecewise-linear `scale`, 0–1.
 * @param {number} v
 * @param {number[]} scale
 */
function valueToFrac(v, scale) {
  if (v <= 0) return 0;
  const n = scale.length - 1;
  for (let i = 0; i < n; i++) {
    if (v <= scale[i + 1]) return (i + (v - scale[i]) / (scale[i + 1] - scale[i])) / n;
  }
  return 1;
}

/** @param {number} v */
function tickLabel(v) {
  return v >= 1000 ? `${v / 1000}k` : String(v);
}

function drawTicks() {
  const n = gauge.scale.length - 1;
  ui.ticks.replaceChildren(
    ...gauge.scale.map((v, i) => {
      const [x, y] = polar(GAUGE.start + (GAUGE.sweep * i) / n, GAUGE.labelR);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("class", "gauge-tick");
      text.setAttribute("x", x.toFixed(1));
      text.setAttribute("y", y.toFixed(1));
      text.textContent = tickLabel(v);
      return text;
    }),
  );
}

/** @param {number} value  Mbps */
function setGauge(value) {
  if (value > gauge.scale[gauge.scale.length - 1] && gauge.scale === SCALES[0]) {
    gauge.scale = SCALES[1];
    drawTicks();
  }
  gauge.target = value;
  if (!gauge.raf) gauge.raf = requestAnimationFrame(animateGauge);
}

function animateGauge() {
  gauge.shown += (gauge.target - gauge.shown) * 0.18;
  if (Math.abs(gauge.target - gauge.shown) < 0.01) gauge.shown = gauge.target;
  const frac = valueToFrac(gauge.shown, gauge.scale);
  ui.fill.setAttribute("d", frac > 0.002 ? arcPath(frac) : "");
  gauge.raf = gauge.shown === gauge.target ? 0 : requestAnimationFrame(animateGauge);
}

function resetGauge() {
  gauge.scale = SCALES[0];
  gauge.shown = gauge.target = 0;
  ui.fill.setAttribute("d", "");
  drawTicks();
}

/* ------------------------------------------------------------------ */
/* Sparklines                                                          */
/* ------------------------------------------------------------------ */

/**
 * Draws `points` as a line with a fading area under it into the given box.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} points
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {string} colorA  line colour on the left, a #rrggbb hex
 * @param {string} colorB  line colour on the right and of the area, a #rrggbb hex
 */
function drawSpark(ctx, points, x, y, w, h, colorA, colorB) {
  if (points.length < 2) return;
  const max = Math.max(...points) * 1.1 || 1;
  const step = w / (points.length - 1);
  /** @param {number} i */
  const px = (i) => x + i * step;
  /** @param {number} v */
  const py = (v) => y + h - (v / max) * h;

  ctx.beginPath();
  points.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  const line = ctx.createLinearGradient(x, 0, x + w, 0);
  line.addColorStop(0, colorA);
  line.addColorStop(1, colorB);
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(1.5, h / 26);
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(px(points.length - 1), y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  const area = ctx.createLinearGradient(0, y, 0, y + h);
  area.addColorStop(0, colorB + "55");
  area.addColorStop(1, colorB + "00");
  ctx.fillStyle = area;
  ctx.fill();
}

/**
 * @param {Direction} kind
 * @param {number[]} points
 */
function renderCardSpark(kind, points) {
  /** @type {HTMLCanvasElement} */
  const canvas = $("[data-spark]", ui.metrics[kind]);
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.scale(dpr, dpr);
  drawSpark(ctx, points, 0, 4, width, height - 4, cssVar(`--${kind}-a`), cssVar(`--${kind}-b`));
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {MetricKind} kind
 * @param {string} text
 */
function setMetric(kind, text) {
  $("[data-value]", ui.metrics[kind]).textContent = text;
}

/**
 * Shows ping/jitter measured during the `kind` transfer; null clears it.
 * @param {Direction} kind
 * @param {LatencyStats | null} stats
 */
function setLoaded(kind, stats) {
  for (const metric of /** @type {const} */ (["ping", "jitter"])) {
    const value = stats ? `${fmtMs(stats[metric])} ms` : "—";
    $(`[data-loaded="${kind}"]`, ui.metrics[metric]).textContent = value;
  }
}

/** @param {MetricKind | null} kind  highlighted card; null for none */
function setActive(kind) {
  for (const [k, el] of Object.entries(ui.metrics)) el.classList.toggle("is-active", k === kind);
}

/**
 * @param {"ping" | Direction} phase
 * @param {string} label
 * @param {string} unit
 */
function setPhase(phase, label, unit) {
  ui.gauge.dataset.phase = phase;
  ui.readoutPhase.textContent = label;
  ui.readoutUnit.textContent = unit;
  ui.readoutValue.textContent = "0";
  ui.readoutLatency.textContent = "";
  ui.progress.style.width = "0";
}

/** @param {boolean} running */
function setRunning(running) {
  ui.start.hidden = running;
  ui.readout.hidden = !running;
  ui.cancel.hidden = !running;
  ui.fieldsets.forEach((f) => (f.disabled = running));
}

function updateModeHint() {
  const m = selectedMode();
  const streams = m.streams === 1 ? "1 stream" : `${m.streams} parallel streams`;
  ui.modeHint.textContent = `${streams} · ${m.seconds} s per direction · ${m.pings} ping samples`;
}

function resetMetrics() {
  for (const card of Object.values(ui.metrics)) $("[data-value]", card).textContent = "—";
  setLoaded("download", null);
  setLoaded("upload", null);
  renderCardSpark("download", []);
  renderCardSpark("upload", []);
}

/* ------------------------------------------------------------------ */
/* Test run                                                            */
/* ------------------------------------------------------------------ */

/** @type {AbortController | null} */
let runCtrl = null;
/** @type {Result | null} */
let lastResult = null;
/** @type {{blob: Blob, url: string, date: Date} | null} */
let lastImage = null;

async function runTest() {
  const mode = selectedMode();
  runCtrl = new AbortController();
  const { signal } = runCtrl;

  performance.setResourceTimingBufferSize?.(1000);
  resetMetrics();
  resetGauge();
  setRunning(true);

  try {
    // 1. Latency
    setPhase("ping", "Ping", "ms");
    setActive("ping");
    ui.status.textContent = "Measuring latency…";
    performance.clearResourceTimings();
    const latency = await measureLatency(mode.pings, signal, (s, progress) => {
      setMetric("ping", fmtMs(s.ping));
      setMetric("jitter", fmtMs(s.jitter));
      ui.readoutValue.textContent = fmtMs(s.ping);
      ui.progress.style.width = `${progress * 100}%`;
    });

    // 2. Download, 3. Upload
    const results = /** @type {Record<Direction, Throughput>} */ ({});
    for (const kind of /** @type {const} */ (["download", "upload"])) {
      setPhase(kind, kind === "download" ? "Download" : "Upload", "Mbps");
      setActive(kind);
      resetGauge();
      ui.status.textContent = `Testing ${kind} speed…`;
      performance.clearResourceTimings(); // keep the buffer free for latency probes
      results[kind] = await measureThroughput(
        kind,
        mode,
        signal,
        (live, progress, series) => {
          setGauge(live);
          ui.readoutValue.textContent = fmtSpeed(live);
          setMetric(kind, fmtSpeed(live));
          ui.progress.style.width = `${progress * 100}%`;
          renderCardSpark(kind, series);
        },
        (loaded) => {
          setLoaded(kind, loaded);
          ui.readoutLatency.textContent = `Ping ${fmtMs(loaded.ping)} ms · jitter ${fmtMs(loaded.jitter)} ms`;
        },
      );
      setMetric(kind, fmtSpeed(results[kind].mbps));
      setLoaded(kind, results[kind].latency);
    }

    lastResult = {
      ...latency,
      download: results.download.mbps,
      upload: results.upload.mbps,
      downloadSeries: results.download.series,
      uploadSeries: results.upload.series,
      loaded: { download: results.download.latency, upload: results.upload.latency },
      mode,
      date: new Date(),
      host: location.host,
    };
    ui.status.textContent = "Done. Press Go to run again";
    setActive(null);
    await showResults(lastResult);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    setActive(null);
    if (err.name === "AbortError") {
      ui.status.textContent = "Test cancelled";
    } else {
      console.error(err);
      ui.status.textContent = "Test failed";
      toast(err.message || "Something went wrong");
    }
  } finally {
    runCtrl = null;
    resetGauge();
    ui.gauge.dataset.phase = "idle";
    ui.progress.style.width = "0";
    setRunning(false);
  }
}

/* ------------------------------------------------------------------ */
/* Results image                                                       */
/* ------------------------------------------------------------------ */

const CARD = {
  w: 1200,
  h: 600,
  bg: "#0b0e14",
  surface: "#141a26",
  border: "rgba(255,255,255,0.08)",
  text: "#e8edf5",
  muted: "#8b95a7",
  download: ["#22d3ee", "#38bdf8"],
  upload: ["#a78bfa", "#e879f9"],
};

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {Date} d */
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Draws the shareable results card.
 * @param {Result} r
 * @returns {HTMLCanvasElement}
 */
function renderResultCanvas(r) {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = CARD.w * scale;
  canvas.height = CARD.h * scale;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.scale(scale, scale);

  // Background with soft glows.
  ctx.fillStyle = CARD.bg;
  ctx.fillRect(0, 0, CARD.w, CARD.h);
  /** @type {[number, number, string][]} */
  const glows = [[160, -40, "rgba(34,211,238,0.18)"], [1080, CARD.h + 50, "rgba(167,139,250,0.18)"]];
  for (const [x, y, color] of glows) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, 520);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD.w, CARD.h);
  }

  // Header.
  ctx.save();
  ctx.translate(56, 46);
  ctx.strokeStyle = CARD.download[1];
  ctx.fillStyle = CARD.download[1];
  ctx.lineWidth = 3.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(18, 25, 13, Math.PI, 0);
  ctx.moveTo(18, 25);
  ctx.lineTo(25, 15);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(18, 25, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = CARD.text;
  ctx.font = `400 28px ${FONT}`;
  ctx.fillText("one more", 104, 80);
  const w1 = ctx.measureText("one more ").width;
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText("speedtest", 104 + w1, 80);

  ctx.textAlign = "right";
  ctx.fillStyle = CARD.muted;
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText(fmtDate(r.date), CARD.w - 56, 80);
  ctx.textAlign = "left";

  // Download / Upload panels.
  /** @type {[string, number, number[], string[], number][]} */
  const panels = [
    ["DOWNLOAD", r.download, r.downloadSeries, CARD.download, 56],
    ["UPLOAD", r.upload, r.uploadSeries, CARD.upload, 616],
  ];
  for (const [label, value, series, colors, x] of panels) {
    const y = 124, w = 528, h = 316;
    ctx.fillStyle = CARD.surface;
    ctx.strokeStyle = CARD.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 24);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors[1];
    ctx.beginPath();
    ctx.arc(x + 38, y + 46, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = CARD.muted;
    ctx.font = `600 20px ${FONT}`;
    ctx.letterSpacing = "3px";
    ctx.fillText(label, x + 56, y + 53);
    ctx.letterSpacing = "0px";

    const text = fmtSpeed(value);
    ctx.fillStyle = CARD.text;
    ctx.font = `700 104px ${FONT}`;
    ctx.fillText(text, x + 32, y + 170);
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = CARD.muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText("Mbps", x + 44 + tw, y + 170);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 24);
    ctx.clip();
    drawSpark(ctx, series, x, y + 200, w, h - 200, colors[0], colors[1]);
    ctx.restore();
  }

  // Footer stats. Ping and jitter also show the values measured under load.
  /** @type {[string, string, ("ping" | "jitter")?][]} */
  const stats = [
    ["PING", `${fmtMs(r.ping)} ms`, "ping"],
    ["JITTER", `${fmtMs(r.jitter)} ms`, "jitter"],
    ["CONNECTIONS", r.mode.connections === "single" ? "Single" : `Multi (${r.mode.streams})`],
    ["DURATION", r.mode.duration === "long" ? `Long run (${r.mode.seconds} s)` : `Basic (${r.mode.seconds} s)`],
  ];
  const colW = (CARD.w - 112) / stats.length;
  stats.forEach(([label, value, metric], i) => {
    const x = 56 + i * colW;
    ctx.fillStyle = CARD.muted;
    ctx.font = `600 16px ${FONT}`;
    ctx.letterSpacing = "2px";
    ctx.fillText(label, x, 486);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = CARD.text;
    ctx.font = `600 32px ${FONT}`;
    ctx.fillText(value, x, 526);
    if (metric) drawLoadedLine(ctx, r.loaded, metric, x, 560);
  });

  // Server sits on the "under load" line, right-aligned under the mode columns.
  ctx.fillStyle = CARD.muted;
  ctx.font = `400 18px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(ellipsize(ctx, `Server: ${r.host}`, colW * 2 - 24), CARD.w - 56, 560);
  ctx.textAlign = "left";

  return canvas;
}

/**
 * Shortens `text` with an ellipsis to fit `maxWidth` in the current font.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 */
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

/**
 * Draws "● 45 ● 60 ms under load" with download/upload coloured dots.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Result["loaded"]} loaded
 * @param {"ping" | "jitter"} metric
 * @param {number} x
 * @param {number} y
 */
function drawLoadedLine(ctx, loaded, metric, x, y) {
  ctx.font = `500 18px ${FONT}`;
  for (const kind of /** @type {const} */ (["download", "upload"])) {
    ctx.fillStyle = CARD[kind][1];
    ctx.beginPath();
    ctx.arc(x + 5, y - 6, 5, 0, Math.PI * 2);
    ctx.fill();
    x += 16;
    const text = loaded[kind] ? fmtMs(loaded[kind][metric]) : "—";
    ctx.fillStyle = CARD.text;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + 14;
  }
  ctx.fillStyle = CARD.muted;
  ctx.fillText("ms under load", x - 6, y);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render image"))), "image/png"),
  );
}

/** @param {Result} r */
async function showResults(r) {
  const canvas = renderResultCanvas(r);
  const blob = await canvasToBlob(canvas);
  if (lastImage) URL.revokeObjectURL(lastImage.url);
  lastImage = { blob, url: URL.createObjectURL(blob), date: r.date };
  ui.resultsImage.src = lastImage.url;
  ui.resultsNote.textContent = "";
  ui.dialog.showModal();
}

function saveImage() {
  if (!lastImage) return;
  const d = lastImage.date;
  const a = document.createElement("a");
  a.href = lastImage.url;
  a.download = `speedtest-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
  document.body.append(a);
  a.click();
  a.remove();
  ui.resultsNote.textContent = "Image saved";
}

async function copyImage() {
  if (!lastImage) return;
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    ui.resultsNote.textContent = "Copying images needs HTTPS (or localhost) and a modern browser. Use Download instead.";
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": lastImage.blob })]);
    ui.resultsNote.textContent = "Image copied to clipboard";
  } catch (err) {
    ui.resultsNote.textContent = `Could not copy the image: ${/** @type {Error} */ (err).message}`;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

let clientIp = "";
let copiedTimer = 0;

async function loadClientInfo() {
  try {
    const res = await fetch("/api/info", { cache: "no-store" });
    if (!res.ok) return;
    const { ip } = await res.json();
    if (!ip) return;
    clientIp = ip;
    ui.client.textContent = `Your IP: ${ip}`;
    ui.client.hidden = false;
  } catch {
    // Not critical.
  }
}

/**
 * Copies `text` to the clipboard. The Clipboard API needs a secure context; a
 * page opened over plain HTTP (e.g. by a LAN address) falls back to the old
 * copy command, which every browser still supports.
 * @param {string} text
 * @returns {Promise<boolean>} whether the text was copied
 */
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied: try the fallback.
    }
  }
  const active = document.activeElement;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS ignores select() on read-only fields
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // Not supported.
  }
  area.remove();
  if (active instanceof HTMLElement) active.focus();
  return ok;
}

async function copyClientIp() {
  if (!clientIp) return;
  const ok = await copyText(clientIp);
  ui.client.textContent = ok ? "Copied to clipboard" : "Could not copy, select it instead";
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (ui.client.textContent = `Your IP: ${clientIp}`), ok ? 1500 : 4000);
}

// The sparklines of a finished test are drawn once; redraw them when their
// size or colours change.
function redrawSparks() {
  if (!lastResult || runCtrl) return;
  renderCardSpark("download", lastResult.downloadSeries);
  renderCardSpark("upload", lastResult.uploadSeries);
}

ui.track.setAttribute("d", arcPath(1));
resetGauge();
updateModeHint();
loadClientInfo();

document.querySelectorAll(".controls input").forEach((el) => el.addEventListener("change", updateModeHint));
ui.client.addEventListener("click", copyClientIp);
ui.start.addEventListener("click", () => {
  if (!runCtrl) runTest();
});
ui.cancel.addEventListener("click", () => runCtrl?.abort());
ui.saveImage.addEventListener("click", saveImage);
ui.copyImage.addEventListener("click", copyImage);
ui.again.addEventListener("click", () => {
  ui.dialog.close();
  if (!runCtrl) runTest();
});
ui.dialog.addEventListener("click", (e) => {
  // Clicks on the backdrop target the dialog element itself but land outside its box.
  if (e.target !== ui.dialog) return;
  const box = ui.dialog.getBoundingClientRect();
  const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
  if (!inside) ui.dialog.close();
});
window.addEventListener("resize", redrawSparks);
window.addEventListener("themechange", redrawSparks);
