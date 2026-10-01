FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /speedtest .

FROM scratch
COPY --from=build /speedtest /speedtest
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/speedtest"]
