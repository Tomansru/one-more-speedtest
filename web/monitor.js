// One More Speedtest — stability monitor.
// Pings the server until stopped (see monitor-worker.js) and keeps session
// statistics: ping distribution, rolling jitter, lost pings, spikes and drops.

const TIMEOUT_MS = 2000; // a ping without a reply in this time is lost
const JITTER_WINDOW_MS = 10_000; // rolling window for the current jitter
const JITTER_MIN_JUMPS = 5; // jumps needed in the window before jitter is reported
const UNSTABLE_MS = 30_000; // a loss or spike keeps the status "unstable" this long
const SPIKE_MIN_SAMPLES = 20; // replies needed before spikes are detected
const SPIKE_MIN_DELTA_MS = 50;
const DROP_STREAK = 2; // consecutive lost pings that make a drop
const MERGE_MS = 10_000; // losses and spikes this close share one event row
const MAX_SAMPLES = 400_000; // raw samples kept for the chart and the CSV
const MAX_EVENTS = 500;
const HIST_STEP_MS = 0.1; // RTT histogram resolution, used for percentiles
const HIST_BINS = TIMEOUT_MS / HIST_STEP_MS + 1;

const FLAG_SPIKE = 1;

const $ = (sel) => document.querySelector(sel);

const ui = {
  toggle: $("#toggle"),
  interval: $("#interval"),
  status: $("#status"),
  stateLabel: $("#state-label"),
  stateDetail: $("#state-detail"),
  nowPing: $("#now-ping"),
  elapsed: $("#elapsed"),
  sent: $("#sent"),
  cards: {
    ping: $("#c-ping"),
    jitter: $("#c-jitter"),
    loss: $("#c-loss"),
    drops: $("#c-drops"),
  },
  chartPing: $("#chart-ping"),
  chartJitter: $("#chart-jitter"),
  events: $("#events"),
  eventsEmpty: $("#events-empty"),
  exportCsv: $("#export"),
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 10 ? ms.toFixed(1) : ms.toFixed(0);
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return "—";
  if (p === 0) return "0";
  if (p < 1) return p.toFixed(2);
  return p < 10 ? p.toFixed(1) : p.toFixed(0);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(t, seconds = true) {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return seconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

// 1:02:03 / 2:03
function fmtElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// 0.8 s / 12 s / 3 min 12 s / 1 h 05 min
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${pad2(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${pad2(Math.floor((sec % 3600) / 60))} min`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ------------------------------------------------------------------ */
/* Session statistics                                                  */
/* ------------------------------------------------------------------ */

function newSession(interval) {
  return {
    interval,
    start: Date.now(),
    end: null,
    // One entry per ping: send time, RTT (NaN = lost), |Δ| to the previous
    // reply (NaN = none) and flags.
    t: [],
    rtt: [],
    jump: [],
    flags: [],
    hist: new Uint32Array(HIST_BINS),
    sent: 0,
    received: 0,
    lost: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    last: NaN,
    prevRtt: NaN,
    jumpSum: 0,
    jumpCount: 0,
    jumpMax: 0,
    window: [], // {t, jump} inside JITTER_WINDOW_MS
    windowSum: 0,
    jitter: NaN,
    jitterMin: Infinity,
    jitterMax: -Infinity,
    spikes: 0,
    lastSpike: 0,
    lastLoss: 0,
    streak: 0, // consecutive lost pings
    streakStart: 0,
    streakReason: "",
    drops: [], // {start, end, pings, reason}; end is null while it lasts
    pauses: [], // {from, to}
    paused: 0,
    events: [],
    eventsVersion: 0,
  };
}

function percentile(s, p) {
  if (!s.received) return NaN;
  const target = Math.max(1, Math.ceil(p * s.received));
  let acc = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    acc += s.hist[i];
    if (acc >= target) return Math.min(Math.max((i + 0.5) * HIST_STEP_MS, s.min), s.max);
  }
  return s.max;
}

function pushSample(s, t, rtt, jump, flags) {
  s.t.push(t);
  s.rtt.push(rtt);
  s.jump.push(jump);
  s.flags.push(flags);
  if (s.t.length > MAX_SAMPLES) {
    const n = MAX_SAMPLES / 10;
    for (const a of [s.t, s.rtt, s.jump, s.flags]) a.splice(0, n);
  }
}

function addEvent(s, event) {
  s.events.push(event);
  if (s.events.length > MAX_EVENTS) s.events.shift();
  s.eventsVersion++;
}

// Losses and spikes come in bursts; close ones are folded into one row.
function addMergedEvent(s, kind, t, value, reason) {
  const last = s.events.at(-1);
  if (last?.kind === kind && t - last.end <= MERGE_MS) {
    last.end = t;
    last.count++;
    last.max = Math.max(last.max, value);
    s.eventsVersion++;
    return;
  }
  addEvent(s, { kind, t, end: t, count: 1, max: value, reason });
}

function addSample(s, { t, rtt, reason }) {
  s.sent++;

  if (rtt === null) {
    s.lost++;
    s.lastLoss = t;
    s.last = NaN;
    s.prevRtt = NaN;
    if (s.streak === 0) {
      s.streakStart = t;
      s.streakReason = reason;
    }
    s.streak++;
    if (s.streak === DROP_STREAK) {
      const drop = { start: s.streakStart, end: null, pings: s.streak, reason: s.streakReason };
      s.drops.push(drop);
      addEvent(s, { kind: "drop", t: drop.start, drop });
    } else if (s.streak > DROP_STREAK) {
      s.drops.at(-1).pings = s.streak;
    }
    pushSample(s, t, NaN, NaN, 0);
    return;
  }

  if (s.streak) endStreak(s, t);

  const median = s.received >= SPIKE_MIN_SAMPLES ? percentile(s, 0.5) : NaN;
  s.received++;
  s.sum += rtt;
  s.min = Math.min(s.min, rtt);
  s.max = Math.max(s.max, rtt);
  s.last = rtt;
  s.hist[Math.min(HIST_BINS - 1, Math.floor(rtt / HIST_STEP_MS))]++;

  let jump = NaN;
  if (Number.isFinite(s.prevRtt)) {
    jump = Math.abs(rtt - s.prevRtt);
    s.jumpSum += jump;
    s.jumpCount++;
    s.jumpMax = Math.max(s.jumpMax, jump);
    s.window.push({ t, jump });
    s.windowSum += jump;
  }
  s.prevRtt = rtt;
  while (s.window.length && s.window[0].t <= t - JITTER_WINDOW_MS) s.windowSum -= s.window.shift().jump;
  if (s.window.length >= JITTER_MIN_JUMPS) {
    s.jitter = s.windowSum / s.window.length;
    s.jitterMin = Math.min(s.jitterMin, s.jitter);
    s.jitterMax = Math.max(s.jitterMax, s.jitter);
  } else {
    s.jitter = NaN;
  }

  let flags = 0;
  if (rtt > median + Math.max(SPIKE_MIN_DELTA_MS, median)) {
    flags |= FLAG_SPIKE;
    s.spikes++;
    s.lastSpike = t;
    addMergedEvent(s, "spike", t, rtt);
  }
  pushSample(s, t, rtt, jump, flags);
}

// A reply (or the end of the session) closes a run of lost pings.
function endStreak(s, t) {
  if (s.streak >= DROP_STREAK) {
    s.drops.at(-1).end = t;
    s.eventsVersion++;
  } else {
    addMergedEvent(s, "loss", s.streakStart, 1, s.streakReason);
  }
  s.streak = 0;
}

function addPause(s, { from, to }) {
  s.pauses.push({ from, to });
  s.paused += to - from;
  addEvent(s, { kind: "pause", t: from, end: to });
}

function finishSession(s) {
  s.end = Date.now();
  if (s.streak) endStreak(s, s.end);
  addEvent(s, { kind: "stop", t: s.end });
}

function downtime(s, now) {
  let total = 0;
  let longest = 0;
  for (const d of s.drops) {
    const len = (d.end ?? now) - d.start;
    total += len;
    longest = Math.max(longest, len);
  }
  return { total, longest };
}

function sessionState(s, now) {
  if (!s) return { state: "idle", label: "Idle", detail: "Press Start to begin" };
  if (s.end) {
    const drops = s.drops.length === 1 ? "1 drop" : `${s.drops.length} drops`;
    return { state: "stopped", label: "Stopped", detail: `Ran for ${fmtDuration(s.end - s.start)} · ${drops}` };
  }
  if (s.streak >= DROP_STREAK) {
    return { state: "down", label: "Down", detail: `No reply for ${fmtDuration(now - s.streakStart)}` };
  }
  if (!s.sent) return { state: "stable", label: "Starting…", detail: "Waiting for the first reply" };
  if (s.lastLoss && now - s.lastLoss < UNSTABLE_MS) {
    const dropped = s.drops.at(-1)?.end >= s.lastLoss;
    return { state: "unstable", label: "Unstable", detail: `${dropped ? "Connection dropped" : "Lost ping"} in the last 30 s` };
  }
  if (s.lastSpike && now - s.lastSpike < UNSTABLE_MS) {
    return { state: "unstable", label: "Unstable", detail: "Latency spike in the last 30 s" };
  }
  return { state: "stable", label: "Stable", detail: "No drops, losses or spikes in the last 30 s" };
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

const CHART_PAD = { left: 40, right: 8, top: 8, bottom: 6, axis: 20 };
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map(
  (s) => s * 1000,
);

function lowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

// Aggregates the samples of [from, to) into n equal time buckets.
function bucketize(s, from, to, n) {
  const width = (to - from) / n;
  const b = Array.from({ length: n }, () => ({ count: 0, sum: 0, max: 0, lost: 0, jsum: 0, jn: 0, spike: false }));
  for (let i = lowerBound(s.t, from); i < s.t.length && s.t[i] < to; i++) {
    const k = b[Math.min(n - 1, Math.floor((s.t[i] - from) / width))];
    const rtt = s.rtt[i];
    if (Number.isNaN(rtt)) {
      k.lost++;
      continue;
    }
    k.count++;
    k.sum += rtt;
    k.max = Math.max(k.max, rtt);
    if (s.flags[i] & FLAG_SPIKE) k.spike = true;
    if (!Number.isNaN(s.jump[i])) {
      k.jsum += s.jump[i];
      k.jn++;
    }
  }
  return { buckets: b, width };
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w: width, h: height };
}

// Splits bucket points into line segments: a bucket with only lost pings or a
// long time gap (pause) breaks the line.
function segments(buckets, x, value, gapBuckets) {
  const out = [];
  let seg = null;
  let lastIdx = -Infinity;
  buckets.forEach((b, i) => {
    if (!b.count) {
      if (b.lost) seg = null;
      return;
    }
    const v = value(b);
    if (!Number.isFinite(v)) return;
    if (!seg || i - lastIdx > gapBuckets) out.push((seg = []));
    seg.push({ x: x(i), v, b });
    lastIdx = i;
  });
  return out;
}

function drawGrid(ctx, plot, yMax, colors) {
  ctx.font = `11px ${cssVar("--font")}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    const y = Math.round(plot.y + plot.h - f * plot.h) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.fillText(String(Number((yMax * f).toFixed(1))), plot.x - 6, y);
  }
}

function drawTimeGrid(ctx, plot, from, to, colors, labels) {
  const span = to - from;
  const step = TIME_STEPS.find((st) => (st / span) * plot.w >= 90) ?? TIME_STEPS.at(-1);
  const offset = new Date(from).getTimezoneOffset() * 60_000;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let t = Math.ceil((from - offset) / step) * step + offset; t <= to; t += step) {
    const x = Math.round(plot.x + ((t - from) / span) * plot.w) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    if (labels) {
      ctx.fillStyle = colors.muted;
      ctx.fillText(fmtClock(t, step < 60_000), x, plot.y + plot.h + 5);
    }
  }
}

// Shades [start, end) time ranges over the full plot height.
function drawBands(ctx, plot, from, to, ranges, color) {
  ctx.fillStyle = color;
  for (const [start, end] of ranges) {
    if (end <= from || start >= to) continue;
    const x0 = plot.x + ((Math.max(start, from) - from) / (to - from)) * plot.w;
    const x1 = plot.x + ((Math.min(end, to) - from) / (to - from)) * plot.w;
    ctx.fillRect(x0, plot.y, Math.max(2, x1 - x0), plot.h);
  }
}

function strokeSegments(ctx, segs, y, color, fillTo) {
  for (const seg of segs) {
    if (fillTo !== undefined) {
      ctx.beginPath();
      seg.forEach((p, i) => (i ? ctx.lineTo(p.x, fillTo.y(p)) : ctx.moveTo(p.x, fillTo.y(p))));
      ctx.lineTo(seg.at(-1).x, fillTo.base);
      ctx.lineTo(seg[0].x, fillTo.base);
      ctx.closePath();
      ctx.fillStyle = fillTo.color;
      ctx.fill();
    }
    ctx.beginPath();
    if (seg.length === 1) {
      ctx.arc(seg[0].x, y(seg[0]), 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      continue;
    }
    seg.forEach((p, i) => (i ? ctx.lineTo(p.x, y(p)) : ctx.moveTo(p.x, y(p))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

function renderCharts(s, now) {
  const ping = setupCanvas(ui.chartPing);
  const jit = setupCanvas(ui.chartJitter);
  if (!s) return;

  const windowMs = Number(document.querySelector('input[name="window"]:checked').value) * 1000;
  const to = s.end ?? now;
  // A young session fills the plot instead of hugging its right edge.
  const from = Math.min(windowMs ? Math.max(to - windowMs, s.start) : s.start, to - 10_000);

  const colors = {
    ping: cssVar("--download-b"),
    jitter: cssVar("--upload-b"),
    loss: cssVar("--danger"),
    spike: cssVar("--warn"),
    muted: cssVar("--muted"),
    grid: cssVar("--track"),
  };
  const plotOf = ({ w, h }, axis) => ({
    x: CHART_PAD.left,
    y: CHART_PAD.top,
    w: w - CHART_PAD.left - CHART_PAD.right,
    h: h - CHART_PAD.top - (axis ? CHART_PAD.axis : CHART_PAD.bottom),
  });
  const pp = plotOf(ping, false);
  const jp = plotOf(jit, true);
  if (pp.w < 20 || pp.h < 10) return;

  const n = Math.max(10, Math.floor(pp.w / 3));
  const { buckets, width } = bucketize(s, from, to, n);
  const bx = (i) => pp.x + ((i + 0.5) / n) * pp.w;
  const gap = Math.max(2, Math.ceil((s.interval * 3) / width));

  const drops = s.drops.map((d) => [d.start, d.end ?? to]);
  const pauses = s.pauses.map((p) => [p.from, p.to]);
  // Single lost pings get a mark of their own; drops are already shaded.
  const lostMarks = [];
  buckets.forEach((b, i) => {
    const t0 = from + i * width;
    const t1 = t0 + width;
    if (b.lost && !drops.some(([a, z]) => t0 < z && t1 > a)) lostMarks.push([t0, t1]);
  });

  // Ping: shaded worst value per bucket, line for the average, spike dots.
  const pingMax = niceCeil(Math.max(10, ...buckets.map((b) => b.max)) * 1.05);
  const py = (v) => pp.y + pp.h - (Math.min(v, pingMax) / pingMax) * pp.h;
  drawGrid(ping.ctx, pp, pingMax, colors);
  drawTimeGrid(ping.ctx, pp, from, to, colors, false);
  drawBands(ping.ctx, pp, from, to, pauses, `${colors.muted}33`);
  drawBands(ping.ctx, pp, from, to, drops, `${colors.loss}55`);
  drawBands(ping.ctx, pp, from, to, lostMarks, `${colors.loss}aa`);
  const pingSegs = segments(buckets, bx, (b) => b.sum / b.count, gap);
  strokeSegments(ping.ctx, pingSegs, (p) => py(p.v), colors.ping, {
    y: (p) => py(p.b.max),
    base: pp.y + pp.h,
    color: `${colors.ping}33`,
  });
  ping.ctx.fillStyle = colors.spike;
  buckets.forEach((b, i) => {
    if (!b.spike) return;
    ping.ctx.beginPath();
    ping.ctx.arc(bx(i), py(b.max), 3, 0, Math.PI * 2);
    ping.ctx.fill();
  });

  // Jitter: average |Δ| between consecutive pings per bucket.
  const jitterOf = (b) => (b.jn ? b.jsum / b.jn : NaN);
  const jitterMax = niceCeil(Math.max(5, ...buckets.map((b) => jitterOf(b) || 0)) * 1.05);
  const jy = (v) => jp.y + jp.h - (Math.min(v, jitterMax) / jitterMax) * jp.h;
  drawGrid(jit.ctx, jp, jitterMax, colors);
  drawTimeGrid(jit.ctx, jp, from, to, colors, true);
  drawBands(jit.ctx, jp, from, to, pauses, `${colors.muted}33`);
  drawBands(jit.ctx, jp, from, to, drops, `${colors.loss}55`);
  strokeSegments(jit.ctx, segments(buckets, bx, jitterOf, gap), (p) => jy(p.v), colors.jitter, {
    y: (p) => jy(p.v),
    base: jp.y + jp.h,
    color: `${colors.jitter}26`,
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

let session = null;
let worker = null;
let renderQueued = false;
let renderedEvents = -1;

function setStat(card, name, text) {
  ui.cards[card].querySelector(`[data-stat="${name}"]`).textContent = text;
}

function setValue(card, text) {
  ui.cards[card].querySelector("[data-value]").textContent = text;
}

function renderStats(s, now) {
  const has = s && s.received > 0;
  setValue("ping", has ? fmtMs(percentile(s, 0.5)) : "—");
  setStat("ping", "min", has ? `${fmtMs(s.min)} ms` : "—");
  setStat("ping", "max", has ? `${fmtMs(s.max)} ms` : "—");
  setStat("ping", "avg", has ? `${fmtMs(s.sum / s.received)} ms` : "—");
  setStat("ping", "p95", has ? `${fmtMs(percentile(s, 0.95))} ms` : "—");
  setStat("ping", "p99", has ? `${fmtMs(percentile(s, 0.99))} ms` : "—");

  const hasJitter = s && Number.isFinite(s.jitterMax);
  setValue("jitter", s ? fmtMs(s.jitter) : "—");
  setStat("jitter", "min", hasJitter ? `${fmtMs(s.jitterMin)} ms` : "—");
  setStat("jitter", "max", hasJitter ? `${fmtMs(s.jitterMax)} ms` : "—");
  setStat("jitter", "avg", s?.jumpCount ? `${fmtMs(s.jumpSum / s.jumpCount)} ms` : "—");
  setStat("jitter", "jump", s?.jumpCount ? `${fmtMs(s.jumpMax)} ms` : "—");

  setValue("loss", s?.sent ? fmtPct((s.lost / s.sent) * 100) : "—");
  setStat("loss", "lost", s ? `${s.lost.toLocaleString()} of ${s.sent.toLocaleString()}` : "—");
  setStat("loss", "spikes", s ? s.spikes.toLocaleString() : "—");
  setStat("loss", "last", s?.lastLoss ? fmtClock(s.lastLoss) : "—");

  const down = s ? downtime(s, now) : null;
  const monitored = s ? (s.end ?? now) - s.start - s.paused : 0;
  const uptime = monitored > 0 ? Math.max(0, 1 - down.total / monitored) * 100 : NaN;
  setValue("drops", s ? String(s.drops.length) : "—");
  setStat("drops", "downtime", s ? (down.total ? fmtDuration(down.total) : "0 s") : "—");
  setStat("drops", "longest", down?.longest ? fmtDuration(down.longest) : "—");
  setStat("drops", "uptime", !s || !Number.isFinite(uptime) ? "—" : uptime === 100 ? "100%" : `${(Math.floor(uptime * 100) / 100).toFixed(2)}%`);

  for (const [card, bad] of [
    ["loss", s?.lost > 0],
    ["drops", s?.drops.length > 0],
  ]) {
    ui.cards[card].classList.toggle("is-bad", Boolean(bad));
  }
}

function eventText(e, now) {
  const many = e.count > 1 ? ` ×${e.count}` : "";
  switch (e.kind) {
    case "start":
      return ["Monitoring started", `ping every ${e.interval >= 1000 ? `${e.interval / 1000} s` : `${e.interval} ms`}`];
    case "stop":
      return ["Monitoring stopped", ""];
    case "drop": {
      const d = e.drop;
      const pings = `${d.pings} pings lost (${d.reason})`;
      return d.end ? ["Connection drop", `${fmtDuration(d.end - d.start)} · ${pings}`] : ["Connection down", `ongoing for ${fmtDuration(now - d.start)} · ${pings}`];
    }
    case "loss":
      return [`Lost ping${many}`, e.reason];
    case "spike":
      return [`Latency spike${many}`, `${e.count > 1 ? "up to " : ""}${fmtMs(e.max)} ms`];
    case "pause":
      return ["Paused", `computer asleep or tab frozen for ${fmtDuration(e.end - e.t)}`];
    case "offline":
      return ["Browser went offline", "the device lost its network connection"];
    case "online":
      return ["Browser back online", ""];
  }
  return [e.kind, ""];
}

function renderEvents(s, now) {
  const ongoing = s?.streak >= DROP_STREAK;
  const version = s ? s.eventsVersion : -1;
  if (version === renderedEvents && !ongoing) return;
  renderedEvents = version;

  const items = (s?.events ?? []).toReversed().map((e) => {
    const li = document.createElement("li");
    li.className = `event event-${e.kind}`;
    if (e.kind === "drop" && !e.drop.end) li.classList.add("is-ongoing");
    const time = document.createElement("time");
    time.dateTime = new Date(e.t).toISOString();
    // Pauses state their length in the detail; drops and merged rows show a range.
    const end = e.kind === "drop" ? e.drop.end : e.kind === "pause" ? null : e.end;
    time.textContent = end && end - e.t >= 1000 ? `${fmtClock(e.t)}–${fmtClock(end)}` : fmtClock(e.t);
    const [title, detail] = eventText(e, now);
    const label = document.createElement("span");
    label.className = "event-title";
    label.textContent = title;
    const info = document.createElement("span");
    info.className = "event-detail";
    info.textContent = detail;
    li.append(time, label, info);
    return li;
  });
  ui.events.replaceChildren(...items);
  ui.eventsEmpty.hidden = items.some((li) => !li.classList.contains("event-start") && !li.classList.contains("event-stop"));
}

function renderStatus(s, now) {
  const st = sessionState(s, now);
  ui.status.dataset.state = st.state;
  ui.stateLabel.textContent = st.label;
  ui.stateDetail.textContent = st.detail;
  ui.nowPing.textContent = !s || !s.sent ? "—" : Number.isNaN(s.last) ? "lost" : `${fmtMs(s.last)} ms`;
  ui.elapsed.textContent = s ? fmtElapsed((s.end ?? now) - s.start) : "—";
  ui.sent.textContent = s ? s.sent.toLocaleString() : "—";
  return st;
}

// The tab title doubles as a status light while the page is in the background.
const BASE_TITLE = document.title;
function updateTitle(s, now) {
  if (!s || s.end) {
    document.title = BASE_TITLE;
    return;
  }
  const st = sessionState(s, now);
  const ping = Number.isNaN(s.last) ? "lost" : `${fmtMs(s.last)} ms`;
  if (st.state === "down") document.title = `🔴 Down ${fmtDuration(now - s.streakStart)} · Monitor`;
  else if (st.state === "unstable") document.title = `🟡 ${ping} · Unstable`;
  else document.title = `🟢 ${s.sent ? ping : "…"} · Monitor`;
}

function render() {
  renderQueued = false;
  const now = Date.now();
  renderStatus(session, now);
  renderStats(session, now);
  renderEvents(session, now);
  renderCharts(session, now);
}

// Rendering waits for the next frame, which never comes while the tab is
// hidden: the work is done once, when the user looks again.
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

/* ------------------------------------------------------------------ */
/* Control                                                             */
/* ------------------------------------------------------------------ */

let clock = 0;

function selectedInterval() {
  return Number(document.querySelector('input[name="interval"]:checked').value);
}

function start() {
  const interval = selectedInterval();
  session = newSession(interval);
  addEvent(session, { kind: "start", t: session.start, interval });
  renderedEvents = -1;

  worker ??= createWorker();
  worker.postMessage({ type: "start", interval, timeout: TIMEOUT_MS });

  ui.toggle.textContent = "Stop";
  ui.toggle.classList.add("is-running");
  ui.interval.disabled = true;
  ui.exportCsv.disabled = false;
  clock = setInterval(() => {
    updateTitle(session, Date.now());
    queueRender();
  }, 1000);
  updateTitle(session, Date.now());
  queueRender();
}

function stop() {
  worker?.postMessage({ type: "stop" });
  clearInterval(clock);
  finishSession(session);
  ui.toggle.textContent = "Start";
  ui.toggle.classList.remove("is-running");
  ui.interval.disabled = false;
  updateTitle(session, Date.now());
  queueRender();
}

const running = () => session && !session.end;

function createWorker() {
  const w = new Worker("monitor-worker.js");
  w.onmessage = ({ data }) => {
    if (!running()) return;
    if (data.type === "sample") addSample(session, data);
    else if (data.type === "pause") addPause(session, data);
    updateTitle(session, Date.now());
    queueRender();
  };
  w.onerror = (err) => {
    console.error(err);
    if (running()) stop();
    ui.stateDetail.textContent = "The probe failed to start";
  };
  return w;
}

function exportCsv() {
  const s = session;
  if (!s) return;
  const rows = ["time,ping_ms,status"];
  for (let i = 0; i < s.t.length; i++) {
    const rtt = s.rtt[i];
    const status = Number.isNaN(rtt) ? "lost" : s.flags[i] & FLAG_SPIKE ? "spike" : "ok";
    rows.push(`${new Date(s.t[i]).toISOString()},${Number.isNaN(rtt) ? "" : rtt.toFixed(2)},${status}`);
  }
  const blob = new Blob([`${rows.join("\n")}\n`], { type: "text/csv" });
  const d = new Date(s.start);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `stability-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

ui.toggle.addEventListener("click", () => (running() ? stop() : start()));
ui.exportCsv.addEventListener("click", exportCsv);
document.querySelectorAll('input[name="window"]').forEach((el) => el.addEventListener("change", queueRender));
window.addEventListener("resize", queueRender);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", queueRender);

for (const kind of ["offline", "online"]) {
  window.addEventListener(kind, () => {
    if (!running()) return;
    addEvent(session, { kind, t: Date.now() });
    queueRender();
  });
}

window.addEventListener("beforeunload", (e) => {
  if (running() && session.sent) e.preventDefault();
});

render();
