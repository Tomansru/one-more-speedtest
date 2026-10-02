# Build on the runner's native platform and cross-compile, so multi-arch
# images build without emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /speedtest .

FROM scratch
COPY --from=build /speedtest /speedtest
USER 65534:65534
# TCP for the UI and API, UDP for the stability monitor's WebRTC probe.
EXPOSE 8080/tcp 8080/udp
ENTRYPOINT ["/speedtest"]
