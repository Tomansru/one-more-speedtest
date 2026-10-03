package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer(t *testing.T, cfg serverConfig) http.Handler {
	t.Helper()
	h, err := newServer(cfg)
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	return h
}

func TestPing(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ping", nil))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestDownload(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	tests := []struct {
		name     string
		query    string
		wantCode int
		wantLen  int
	}{
		{"default size", "", http.StatusOK, defaultDownloadSize},
		{"small", "?size=1000", http.StatusOK, 1000},
		{"several payload blocks", "?size=3145829", http.StatusOK, 3145829},
		{"zero", "?size=0", http.StatusBadRequest, -1},
		{"negative", "?size=-5", http.StatusBadRequest, -1},
		{"garbage", "?size=abc", http.StatusBadRequest, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/download"+tt.query, nil))
			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantCode)
			}
			if tt.wantLen >= 0 && rec.Body.Len() != tt.wantLen {
				t.Errorf("body length = %d, want %d", rec.Body.Len(), tt.wantLen)
			}
		})
	}
}

func TestDownloadMethodNotAllowed(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/download", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestUpload(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	body := bytes.Repeat([]byte{'x'}, 123456)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/upload", bytes.NewReader(body)))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var resp struct{ Bytes int64 }
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Bytes != int64(len(body)) {
		t.Errorf("bytes = %d, want %d", resp.Bytes, len(body))
	}
}

func TestUploadTooLarge(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	body := io.LimitReader(zeroReader{}, maxUploadSize+1)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/upload", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestInfoClientIP(t *testing.T) {
	tests := []struct {
		name       string
		trustProxy bool
		headers    map[string]string
		want       string
	}{
		{"remote addr", false, nil, "192.0.2.1"},
		{"ignores XFF when untrusted", false, map[string]string{"X-Forwarded-For": "203.0.113.7"}, "192.0.2.1"},
		{"uses first XFF hop", true, map[string]string{"X-Forwarded-For": "203.0.113.7, 10.0.0.1"}, "203.0.113.7"},
		{"falls back to X-Real-IP", true, map[string]string{"X-Real-IP": "198.51.100.4"}, "198.51.100.4"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newTestServer(t, serverConfig{TrustProxy: tt.trustProxy})
			req := httptest.NewRequest(http.MethodGet, "/api/info", nil) // RemoteAddr is 192.0.2.1:1234
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			var resp struct{ IP string }
			if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if resp.IP != tt.want {
				t.Errorf("ip = %q, want %q", resp.IP, tt.want)
			}
		})
	}
}

func TestStaticIndex(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "<title>") {
		t.Errorf("index page does not look like HTML")
	}
}

func TestStaticMonitor(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	for _, path := range []string{"/monitor", "/monitor.html", "/monitor.js", "/monitor-worker.js"} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
		})
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/monitor", nil))
	if !strings.Contains(rec.Body.String(), "Stability monitor") {
		t.Errorf("/monitor does not serve the monitor page")
	}
}

func TestStaticContentTypes(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	tests := []struct{ path, want string }{
		{"/manifest.webmanifest", "application/manifest+json"},
		{"/favicon.ico", "image/x-icon"},
		{"/favicon.svg", "image/svg+xml"},
		{"/apple-touch-icon.png", "image/png"},
		{"/theme.js", "text/javascript"},
		{"/style.css", "text/css"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			if got, _, _ := strings.Cut(rec.Header().Get("Content-Type"), ";"); got != tt.want {
				t.Errorf("Content-Type = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestManifestIcons(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil))
	var manifest struct {
		StartURL string `json:"start_url"`
		Icons    []struct {
			Src string `json:"src"`
		} `json:"icons"`
		Shortcuts []struct {
			URL string `json:"url"`
		} `json:"shortcuts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &manifest); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if len(manifest.Icons) == 0 {
		t.Fatal("manifest has no icons")
	}

	// Every URL in the manifest is relative to it, i.e. to the site root.
	paths := []string{manifest.StartURL}
	for _, icon := range manifest.Icons {
		paths = append(paths, icon.Src)
	}
	for _, s := range manifest.Shortcuts {
		paths = append(paths, s.URL)
	}
	for _, p := range paths {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/"+strings.TrimPrefix(p, "./"), nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %q from the manifest: status = %d, want %d", p, rec.Code, http.StatusOK)
		}
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
