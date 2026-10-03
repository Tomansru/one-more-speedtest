# one-more-speedtest

[![CI](https://github.com/Tomansru/one-more-speedtest/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tomansru/one-more-speedtest/actions/workflows/ci.yml)
[![Docker](https://github.com/Tomansru/one-more-speedtest/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/Tomansru/one-more-speedtest/pkgs/container/one-more-speedtest)

A simple, self-hosted internet speed test. One static Go binary: the backend
uses the Go standard library plus [Pion WebRTC](https://github.com/pion/webrtc)
for the stability monitor's UDP probe, and the UI is plain HTML, CSS and
JavaScript embedded into the binary, with no third-party requests.

It measures:

- **Ping** – median round-trip time of small HTTP requests (after a warm-up request).
- **Jitter** – mean absolute difference between consecutive ping samples.
- **Download** and **Upload** throughput in Mbps.
- **Ping and jitter under load** – the same latency probe keeps running (every
  200 ms) while the download and the upload saturate the link. Comparing it with
  the idle ping shows how much your connection suffers from
  [bufferbloat](https://www.bufferbloat.net/projects/bloat/wiki/Introduction/).

At the end a results card is shown that can be **downloaded as a PNG** or
**copied to the clipboard** as an image.

Clicking the IP address in the top bar copies it to the clipboard. The theme
follows the system by default; the small switch in the footer picks light or
dark instead, and the browser remembers the choice.

<p align="center">
  <a href="docs/screenshots/test-dark.png"><img src="docs/screenshots/test-dark.png" alt="Dark theme: test in progress" width="48%"></a>
  <a href="docs/screenshots/finished-light.png"><img src="docs/screenshots/finished-light.png" alt="Light theme: finished test" width="48%"></a>
</p>

## Stability monitor

A second page, `/monitor` (linked quietly from the footer of the main page),
runs an endless latency test. Start it, leave the tab in the background while
you play or work, and come back to see how stable the connection was:

- **Packet loss** – pings without a reply within 2 s, in %.
- **Drops** – lost pings in a row (at least two) covering at least a second,
  with their start, length and total downtime / uptime share.
- **Latency spikes** – replies more than twice the median and at least 50 ms
  above it.
- **Ping** – min / max / average / median / P95 / P99 over the whole session.
- **Jitter** – current value over the last 10 s, its calmest and worst 10 s,
  the session average and the largest single jump.
- A timeline of ping and jitter (1 min, 10 min, 1 h or the whole session),
  an event log and a CSV export of every sample.

### UDP or TCP

Games use UDP, so the monitor prefers it. On start it checks whether UDP
reaches the server: if it does, the whole session pings over UDP, a 4-byte
probe through a WebRTC data channel that is unordered and has retransmissions
turned off, echoed by the server. A lost packet stays lost and is counted as
such. If UDP can't reach the server (a firewall, a reverse proxy,
`-udp-addr off`), the session pings with HTTP requests over TCP instead, and
the event log says why. A session never mixes the two; the status card shows
which one it uses. Over TCP lost packets are resent, so small loss mostly
shows up as latency spikes rather than lost pings.

The probe keeps its pace (250 ms, 500 ms or 1 s) while the tab is hidden: its
clock runs in a Web Worker, which browsers don't throttle like background tabs.
The tab title shows the current status (🟢 / 🟡 / 🔴). Time the computer spends
asleep is marked as paused and not counted as downtime, and so is time the
browser keeps the tab frozen to save power (reported by Chromium-based browsers
through the `freeze` / `resume` events; elsewhere the jump of the probe's clock
gives it away). Probes in flight during a pause are not counted either.

While a session runs and the page is on screen, the monitor holds a
[screen wake lock](https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API),
so the screen, and with it the computer, doesn't go to sleep. Browsers offer it
only in a secure context (HTTPS or `localhost`) and release it while the page is
hidden; the "Keep screen awake" checkbox next to Start turns it off.

For the UDP probe the browser must reach the server's UDP port (by default the
same port number as `-addr`) directly; reverse proxies only forward HTTP. The
server tells the browser which address to send UDP to:

- `-public-ip`, if set;
- otherwise the address the page was opened with, when it is an IP or
  `localhost`;
- otherwise the server's own interface addresses.

Set `-public-ip` when the server is behind NAT or in Docker and is reached by
a domain name.

## Test modes

| Setting      | Option    | What it does                                  |
|--------------|-----------|-----------------------------------------------|
| Connections  | Single    | 1 HTTP stream per direction                    |
|              | Multi     | 5 parallel HTTP streams per direction          |
| Duration     | Basic run | 20 ping samples, 10 s download, 10 s upload    |
|              | Long run  | 50 ping samples, 30 s download, 30 s upload    |

The first seconds of each transfer phase (1.5 s for a basic run, 3 s for a long
run) are a warm-up for TCP slow start and are excluded from the final speed and
from the loaded latency.

Browsers open at most 6 HTTP/1.1 connections per host, so multi mode uses 5
transfer streams and keeps one connection free for the latency probe.

## Running

Requires Go 1.27+.

```sh
go run .
# open http://localhost:8080
```

Or build a binary:

```sh
go build -o speedtest .
./speedtest -addr :8080
```

Or with Docker, using the image from GitHub Container Registry (`linux/amd64`
and `linux/arm64`):

```sh
docker run --rm -p 8080:8080 -p 8080:8080/udp ghcr.io/tomansru/one-more-speedtest:latest
```

Publishing `8080/udp` enables the monitor's UDP probe. Publish it under the
same port number it has inside the container (`-p 8080:8080/udp`, even if TCP
is mapped elsewhere): the server advertises that port to the browser. Opened
as `http://localhost:8080` or `http://<server-ip>:8080` this works as is; when
the page is opened by a domain name, also pass
`-e SPEEDTEST_PUBLIC_IP=<server-ip>`.

| Tag                          | Built from                          |
|------------------------------|-------------------------------------|
| `latest`, `1`, `1.2`, `1.2.3` | Release tags like `v1.2.3`          |
| `dev-latest`, `sha-<commit>` | Every push to `main`                |

Pull requests only build the image to check it, without publishing it.

To build it yourself:

```sh
docker build -t one-more-speedtest .
docker run --rm -p 8080:8080 -p 8080:8080/udp one-more-speedtest
```

### Docker Compose with Traefik

[`compose.yaml`](compose.yaml) runs the speed test behind an existing
[Traefik](https://traefik.io/) with the Docker provider and HTTPS. By default
the image is built from the source on GitHub (no clone needed); switch to the
published image by swapping `build` for `image` in the file.

```sh
curl -fsSLO https://raw.githubusercontent.com/Tomansru/one-more-speedtest/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/Tomansru/one-more-speedtest/main/.env.example -o .env
# edit .env: SPEEDTEST_HOST, SPEEDTEST_PUBLIC_IP, Traefik network / entrypoint / resolver
docker compose up -d --build
```

| Variable               | Default       | Description                                                    |
|------------------------|---------------|----------------------------------------------------------------|
| `SPEEDTEST_HOST`       | —             | Domain Traefik routes to the speed test (required)             |
| `SPEEDTEST_PUBLIC_IP`  | —             | Public IP browsers send the monitor's UDP probe to             |
| `SPEEDTEST_UDP_PORT`   | `8080`        | UDP port of the probe, published under the same number         |
| `SPEEDTEST_REF`        | `main`        | Branch or tag to build from                                    |
| `TRAEFIK_NETWORK`      | `traefik`     | External Docker network Traefik is attached to                 |
| `TRAEFIK_ENTRYPOINT`   | `websecure`   | Traefik HTTPS entrypoint                                       |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | Traefik certificate resolver                                   |

Traefik only carries HTTP. The monitor's UDP probe goes straight to the
published UDP port, so open it in the firewall and set `SPEEDTEST_PUBLIC_IP`;
without them the monitor pings over HTTP/TCP. Don't attach compression or
buffering middlewares to the router: they distort the measurements.

### Installing as an app

The pages carry a web app manifest, icons for every platform (including a
maskable one for Android) and the matching meta tags, so the speed test can be
added to the home screen or installed as an app. Chromium-based browsers offer
installation only over HTTPS; on iOS, *Share → Add to Home Screen* works over
plain HTTP too. There is no service worker on purpose: the speed test makes no
sense offline, and a cache in the way of `/api/` would only distort results.

### Options

| Flag           | Environment variable        | Default | Description                                                     |
|----------------|-----------------------------|---------|-----------------------------------------------------------------|
| `-addr`        | `SPEEDTEST_ADDR`            | `:8080` | Listen address                                                  |
| `-trust-proxy` | `SPEEDTEST_TRUST_PROXY=1`   | off     | Report the client IP from `X-Forwarded-For` / `X-Real-IP`       |
| `-udp-addr`    | `SPEEDTEST_UDP_ADDR`        | `-addr` | UDP address for the monitor's WebRTC probe; `off` disables it   |
| `-public-ip`   | `SPEEDTEST_PUBLIC_IP`       | —       | Comma-separated IPs browsers should send UDP to (NAT, Docker)   |

Enable `-trust-proxy` only when the server runs behind a reverse proxy you
control. If you put a proxy in front, make sure it does not buffer or compress
`/api/download` and `/api/upload`, otherwise results will be wrong.

Copying the result image to the clipboard requires a secure context (HTTPS or
`localhost`); downloading the image works everywhere.

## API

| Method | Path                       | Description                                         |
|--------|----------------------------|-----------------------------------------------------|
| GET    | `/api/ping`                | Empty `204` response for latency measurement        |
| GET    | `/api/download?size=BYTES` | Streams incompressible random data (max 1 GiB)      |
| POST   | `/api/upload`              | Reads and discards the body (max 256 MiB), returns `{"bytes": N}` |
| GET    | `/api/info`                | Returns `{"ip": "..."}` as seen by the server       |
| POST   | `/api/rtc`                 | Takes a WebRTC offer (`{"type":"offer","sdp":"..."}`), returns the answer; data channel messages up to 64 bytes are echoed back |

## Development

```sh
go vet ./...
go test ./...
```

The UI scripts are plain JavaScript with JSDoc types and `// @ts-check`, served
as they are. Editors with TypeScript support check them as you type; to check
them all (CI does too):

```sh
npx -p typescript@6 tsc -p tsconfig.json         # page scripts
npx -p typescript@6 tsc -p tsconfig.worker.json  # the monitor's worker
```

## License

MIT
