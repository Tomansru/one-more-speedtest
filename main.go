// Command one-more-speedtest is a small self-hosted network speed test.
//
// It serves a static web UI and a handful of HTTP endpoints used by the
// browser to measure latency, jitter, download and upload throughput.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", envOr("SPEEDTEST_ADDR", ":8080"), "listen address")
	trustProxy := flag.Bool("trust-proxy", os.Getenv("SPEEDTEST_TRUST_PROXY") == "1",
		"trust X-Forwarded-For / X-Real-IP headers when reporting the client IP")
	udpAddr := flag.String("udp-addr", os.Getenv("SPEEDTEST_UDP_ADDR"),
		`UDP address for the monitor's WebRTC probe (default: same as -addr; "off" disables it)`)
	publicIP := flag.String("public-ip", os.Getenv("SPEEDTEST_PUBLIC_IP"),
		"comma-separated IPs browsers should send UDP to, when the server is behind NAT or in Docker")
	flag.Parse()

	if *udpAddr == "" {
		*udpAddr = *addr
	}
	var publicIPs []string
	for ip := range strings.SplitSeq(*publicIP, ",") {
		if ip = strings.TrimSpace(ip); ip != "" {
			if net.ParseIP(ip) == nil {
				log.Fatalf("invalid -public-ip %q", ip)
			}
			publicIPs = append(publicIPs, ip)
		}
	}
	rtc, err := listenRTC(*udpAddr, publicIPs)
	if err != nil {
		log.Fatalf("udp: %v", err)
	}

	handler, err := newServer(serverConfig{TrustProxy: *trustProxy, RTC: rtc})
	if err != nil {
		log.Fatalf("init: %v", err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No Read/WriteTimeout: long-run tests stream data for a minute or more.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("speedtest listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
