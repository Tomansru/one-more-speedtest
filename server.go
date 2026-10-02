package main

import (
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
)

//go:embed web
var webFS embed.FS

const (
	// payloadSize is the size of the random block repeated in download responses.
	payloadSize = 1 << 20 // 1 MiB
	// defaultDownloadSize is used when the client does not ask for a size.
	defaultDownloadSize = 25 << 20 // 25 MiB
	// maxDownloadSize caps a single download response.
	maxDownloadSize = 1 << 30 // 1 GiB
	// maxUploadSize caps a single upload request body.
	maxUploadSize = 256 << 20 // 256 MiB
)

type serverConfig struct {
	// TrustProxy makes the server report the client IP from proxy headers.
	TrustProxy bool
	// RTC serves the UDP probe of the stability monitor; nil disables it.
	RTC *rtcServer
}

type server struct {
	cfg     serverConfig
	payload []byte
}

// newServer builds the HTTP handler serving the UI and the measurement API.
func newServer(cfg serverConfig) (http.Handler, error) {
	payload := make([]byte, payloadSize)
	// Random bytes keep the payload incompressible for any middlebox on the path.
	if _, err := rand.Read(payload); err != nil {
		return nil, err
	}
	s := &server{cfg: cfg, payload: payload}

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ping", s.handlePing)
	mux.HandleFunc("GET /api/download", s.handleDownload)
	mux.HandleFunc("POST /api/upload", s.handleUpload)
	mux.HandleFunc("GET /api/info", s.handleInfo)
	if cfg.RTC != nil {
		mux.HandleFunc("POST /api/rtc", cfg.RTC.handleRTC)
	}
	mux.HandleFunc("GET /monitor", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, static, "monitor.html")
	})
	mux.Handle("GET /", http.FileServerFS(static))
	return withCommonHeaders(mux), nil
}

func withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
			h.Set("Pragma", "no-cache")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}

// handlePing answers as fast as possible with an empty body.
func (s *server) handlePing(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// handleDownload streams `size` bytes of incompressible data.
func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	size := int64(defaultDownloadSize)
	if v := r.URL.Query().Get("size"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			http.Error(w, "invalid size", http.StatusBadRequest)
			return
		}
		size = min(n, maxDownloadSize)
	}

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)

	for remaining := size; remaining > 0; {
		chunk := s.payload[:min(remaining, int64(len(s.payload)))]
		if _, err := w.Write(chunk); err != nil {
			return // client went away, e.g. the test phase ended
		}
		remaining -= int64(len(chunk))
	}
}

// handleUpload reads and discards the request body.
func (s *server) handleUpload(w http.ResponseWriter, r *http.Request) {
	body := http.MaxBytesReader(w, r.Body, maxUploadSize)
	n, err := io.Copy(io.Discard, body)
	if err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		// Client aborted mid-upload; nothing useful to answer.
		return
	}
	writeJSON(w, map[string]int64{"bytes": n})
}

// handleInfo reports what the server sees about the client.
func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"ip": s.clientIP(r)})
}

func (s *server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
