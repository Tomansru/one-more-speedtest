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
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", envOr("SPEEDTEST_ADDR", ":8080"), "listen address")
	trustProxy := flag.Bool("trust-proxy", os.Getenv("SPEEDTEST_TRUST_PROXY") == "1",
		"trust X-Forwarded-For / X-Real-IP headers when reporting the client IP")
	flag.Parse()

	handler, err := newServer(serverConfig{TrustProxy: *trustProxy})
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
