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

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const $ = (sel) => document.querySelector(sel);

const ui = {
  start: $("#start"),
  cancel: $("#cancel"),
  status: $("#status"),
  gauge: $("#gauge"),
  track: $("#gauge-track"),
  fill: $("#gauge-fill"),
  ticks: $("#gauge-ticks"),
  readout: $("#readout"),
  readoutPhase: $("#readout-phase"),
  readoutValue: $("#readout-value"),
  readoutUnit: $("#readout-unit"),
  readoutLatency: $("#readout-latency"),
  progress: $("#progress-bar"),
  modeHint: $("#mode-hint"),
  client: $("#client-info"),
  fieldsets: document.querySelectorAll(".segmented"),
  metrics: {
    ping: $("#m-ping"),
    jitter: $("#m-jitter"),
    download: $("#m-download"),
    upload: $("#m-upload"),
  },
  dialog: $("#results"),
  resultsImage: $("#results-image"),
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

function fmtSpeed(mbps) {
  if (!Number.isFinite(mbps)) return "—";
  if (mbps < 10) return mbps.toFixed(2);
  if (mbps < 100) return mbps.toFixed(1);
  return mbps.toFixed(0);
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 10 ? ms.toFixed(1) : ms.toFixed(0);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function selectedMode() {
  const connections = document.querySelector('input[name="connections"]:checked').value;
  const duration = document.querySelector('input[name="duration"]:checked').value;
  return { connections, duration, ...CONNECTIONS[connections], ...DURATIONS[duration] };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 5000);
}

/* ------------------------------------------------------------------ */
/* Latency                                                             */
/* ------------------------------------------------------------------ */

// One round trip to the server. Uses Resource Timing (request → first byte)
// when available, which excludes JS scheduling noise; falls back to wall clock.
async function pingOnce(signal) {
  const url = new URL(`/api/ping?r=${rand()}`, location.href).href;
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store", signal });
  await res.arrayBuffer();
  const wall = performance.now() - t0;
  if (!res.ok) throw new Error(`Ping failed: HTTP ${res.status}`);

  const entry = performance.getEntriesByName(url).pop();
  if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
    return entry.responseStart - entry.requestStart;
  }
  return wall;
}

// Ping is the median RTT; jitter is the mean absolute difference between
// consecutive RTT samples (the approach used by most browser speed tests).
function latencyStats(samples) {
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i] - samples[i - 1]);
  return {
    ping: median(samples),
    jitter: samples.length > 1 ? jitter / (samples.length - 1) : 0,
  };
}

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

// Pings the server while a transfer saturates the link ("loaded latency"),
// which reveals bufferbloat. One probe is in flight at a time; samples taken
// during the warm-up are skipped, like the warm-up bytes.
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

async function downloadWorker(signal, add) {
  while (!signal.aborted) {
    const res = await fetch(`/api/download?size=${DOWNLOAD_REQUEST_SIZE}&r=${rand()}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      add(value.byteLength);
    }
  }
}

let randomBlock;
const blobCache = new Map();

function uploadBlob(size) {
  if (!randomBlock) {
    randomBlock = new Uint8Array(UPLOAD_MIN_CHUNK);
    for (let i = 0; i < randomBlock.length; i += 65536) {
      crypto.getRandomValues(randomBlock.subarray(i, i + 65536));
    }
  }
  if (!blobCache.has(size)) {
    blobCache.set(size, new Blob(Array(size / UPLOAD_MIN_CHUNK).fill(randomBlock), {
      type: "application/octet-stream",
    }));
  }
  return blobCache.get(size);
}

// XHR is used because it reports upload progress in every browser.
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

async function uploadWorker(signal, add) {
  let size = UPLOAD_MIN_CHUNK;
  while (!signal.aborted) {
    const t0 = performance.now();
    await uploadOnce(signal, add, uploadBlob(size));
    // Grow requests on fast links so per-request overhead stays negligible.
    if (performance.now() - t0 < 1000 && size < UPLOAD_MAX_CHUNK) size *= 2;
  }
}

// Runs `streams` parallel workers for `seconds` and reports throughput and
// latency under load. The first `grace` seconds (TCP slow start, connection
// setup) are excluded from the final result.
function measureThroughput(kind, { streams, seconds, grace }, signal, onTick, onLatency) {
  const worker = kind === "download" ? downloadWorker : uploadWorker;
  const ctrl = new AbortController();
  const stopWorkers = () => ctrl.abort();
  signal.addEventListener("abort", stopWorkers, { once: true });

  let bytes = 0;
  let failed = 0;
  let lastError;
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
  const series = [];

  return new Promise((resolve, reject) => {
    const finish = async (err) => {
      clearInterval(timer);
      ctrl.abort();
      signal.removeEventListener("abort", stopWorkers);
      await Promise.allSettled(workers);
      if (err) reject(err);
      else resolve({ ...result(), latency: await latency });
    };

    const result = () => {
      const end = history.at(-1);
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

function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [GAUGE.cx + r * Math.cos(a), GAUGE.cy + r * Math.sin(a)];
}

function arcPath(frac) {
  const end = GAUGE.start + GAUGE.sweep * frac;
  const [x0, y0] = polar(GAUGE.start, GAUGE.r);
  const [x1, y1] = polar(end, GAUGE.r);
  const large = GAUGE.sweep * frac > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${GAUGE.r} ${GAUGE.r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function valueToFrac(v, scale) {
  if (v <= 0) return 0;
  const n = scale.length - 1;
  for (let i = 0; i < n; i++) {
    if (v <= scale[i + 1]) return (i + (v - scale[i]) / (scale[i + 1] - scale[i])) / n;
  }
  return 1;
}

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

function setGauge(value) {
  if (value > gauge.scale.at(-1) && gauge.scale === SCALES[0]) {
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

function drawSpark(ctx, points, x, y, w, h, colorA, colorB) {
  if (points.length < 2) return;
  const max = Math.max(...points) * 1.1 || 1;
  const step = w / (points.length - 1);
  const px = (i) => x + i * step;
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

function renderCardSpark(kind, points) {
  const canvas = ui.metrics[kind].querySelector("[data-spark]");
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawSpark(ctx, points, 0, 4, width, height - 4, cssVar(`--${kind}-a`), cssVar(`--${kind}-b`));
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

function setMetric(kind, text) {
  ui.metrics[kind].querySelector("[data-value]").textContent = text;
}

// Shows ping/jitter measured during the `kind` transfer; null clears it.
function setLoaded(kind, stats) {
  for (const metric of ["ping", "jitter"]) {
    const value = stats ? `${fmtMs(stats[metric])} ms` : "—";
    ui.metrics[metric].querySelector(`[data-loaded="${kind}"]`).textContent = value;
  }
}

function setActive(kind) {
  for (const [k, el] of Object.entries(ui.metrics)) el.classList.toggle("is-active", k === kind);
}

function setPhase(phase, label, unit) {
  ui.gauge.dataset.phase = phase;
  ui.readoutPhase.textContent = label;
  ui.readoutUnit.textContent = unit;
  ui.readoutValue.textContent = "0";
  ui.readoutLatency.textContent = "";
  ui.progress.style.width = "0";
}

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
  for (const kind of Object.keys(ui.metrics)) setMetric(kind, "—");
  setLoaded("download", null);
  setLoaded("upload", null);
  renderCardSpark("download", []);
  renderCardSpark("upload", []);
}

/* ------------------------------------------------------------------ */
/* Test run                                                            */
/* ------------------------------------------------------------------ */

let runCtrl = null;
let lastResult = null;
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
    const results = {};
    for (const kind of ["download", "upload"]) {
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
  } catch (err) {
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
  h: 630,
  bg: "#0b0e14",
  surface: "#141a26",
  border: "rgba(255,255,255,0.08)",
  text: "#e8edf5",
  muted: "#8b95a7",
  download: ["#22d3ee", "#38bdf8"],
  upload: ["#a78bfa", "#e879f9"],
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderResultCanvas(r) {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = CARD.w * scale;
  canvas.height = CARD.h * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // Background with soft glows.
  ctx.fillStyle = CARD.bg;
  ctx.fillRect(0, 0, CARD.w, CARD.h);
  for (const [x, y, color] of [[160, -40, "rgba(34,211,238,0.18)"], [1080, 680, "rgba(167,139,250,0.18)"]]) {
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

  ctx.fillStyle = CARD.muted;
  ctx.font = `400 18px ${FONT}`;
  ctx.fillText(`Server: ${r.host}`, 56, 604);

  return canvas;
}

// Draws "● 45 ● 60 ms under load" with download/upload coloured dots.
function drawLoadedLine(ctx, loaded, metric, x, y) {
  ctx.font = `500 18px ${FONT}`;
  for (const kind of ["download", "upload"]) {
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

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render image"))), "image/png"),
  );
}

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
    ui.resultsNote.textContent = `Could not copy the image: ${err.message}`;
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

async function loadClientInfo() {
  try {
    const res = await fetch("/api/info", { cache: "no-store" });
    if (!res.ok) return;
    const { ip } = await res.json();
    if (ip) ui.client.textContent = `Your IP: ${ip}`;
  } catch {
    // Not critical.
  }
}

ui.track.setAttribute("d", arcPath(1));
resetGauge();
updateModeHint();
loadClientInfo();

document.querySelectorAll('.segmented input').forEach((el) => el.addEventListener("change", updateModeHint));
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
window.addEventListener("resize", () => {
  if (!lastResult || runCtrl) return;
  renderCardSpark("download", lastResult.downloadSeries);
  renderCardSpark("upload", lastResult.uploadSeries);
});
