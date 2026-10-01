# Build on the runner's native platform and cross-compile, so multi-arch
# images build without emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /speedtest .

FROM scratch
COPY --from=build /speedtest /speedtest
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/speedtest"]
