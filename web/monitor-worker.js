// One More Speedtest — stability monitor probe.
// Runs in a dedicated worker: browsers heavily throttle timers of background
// tabs (Chrome wakes them once a minute after 5 minutes), but not workers, so
// the probe keeps its pace while the page sits behind a game or another app.

const PING_URL = new URL("/api/ping", self.location.href).href;
// Wall-clock jump between two ticks that means the computer slept or the page
// was frozen, rather than the network failing.
const PAUSE_MS = 5000;

let run = 0; // id of the active loop; bumping it stops the previous one

const rand = () => Math.random().toString(36).slice(2);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// One round trip, like pingOnce() on the main page: Resource Timing
// (request → first byte) when available, wall clock otherwise.
async function ping(timeout) {
  const url = `${PING_URL}?r=${rand()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    await res.arrayBuffer();
    const wall = performance.now() - t0;
    if (!res.ok) return { rtt: null, reason: `HTTP ${res.status}` };

    const entry = performance.getEntriesByName(url).pop();
    performance.clearResourceTimings();
    if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
      return { rtt: entry.responseStart - entry.requestStart };
    }
    return { rtt: wall };
  } catch {
    return { rtt: null, reason: ctrl.signal.aborted ? "timeout" : "network error", wall: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function loop(id, interval, timeout) {
  let last = Date.now();
  while (id === run) {
    const t = Date.now();
    if (t - last > interval + PAUSE_MS) postMessage({ type: "pause", from: last, to: t });

    const t0 = performance.now();
    const r = await ping(timeout);
    if (id !== run) return;
    if (r.rtt === null && r.wall > timeout + PAUSE_MS) {
      // The request outlived its own timeout by far: the timer could not fire,
      // so the machine was asleep. Not a network failure.
      postMessage({ type: "pause", from: t, to: Date.now() });
    } else {
      postMessage({ type: "sample", t, rtt: r.rtt, reason: r.reason });
    }
    last = Date.now();
    await sleep(interval - (performance.now() - t0));
  }
}

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    performance.setResourceTimingBufferSize?.(100);
    loop(++run, data.interval, data.timeout);
  } else if (data.type === "stop") {
    run++;
  }
};
