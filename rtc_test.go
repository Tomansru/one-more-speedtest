package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func newRTCTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	srv := httptest.NewServer(newTestServer(t, serverConfig{RTC: newRTCServer(conn, nil)}))
	t.Cleanup(srv.Close)
	return srv
}

// TestRTCEcho opens an unordered, unreliable data channel like the browser
// does and expects every probe to come back unchanged.
func TestRTCEcho(t *testing.T) {
	srv := newRTCTestServer(t)

	var se webrtc.SettingEngine
	se.SetIncludeLoopbackCandidate(true)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("peer: %v", err)
	}
	t.Cleanup(func() { pc.Close() })

	ordered := false
	retransmits := uint16(0)
	dc, err := pc.CreateDataChannel("ping", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retransmits})
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}
	opened := make(chan struct{})
	echoed := make(chan []byte, 1)
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { echoed <- msg.Data })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local: %v", err)
	}
	body, _ := json.Marshal(pc.LocalDescription())
	res, err := http.Post(srv.URL+"/api/rtc", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post offer: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	var answer webrtc.SessionDescription
	if err := json.NewDecoder(res.Body).Decode(&answer); err != nil {
		t.Fatalf("decode answer: %v", err)
	}
	if !strings.Contains(answer.SDP, "a=ice-lite") || !strings.Contains(answer.SDP, "127.0.0.1") {
		t.Errorf("answer should be ICE-lite with a 127.0.0.1 candidate:\n%s", answer.SDP)
	}
	if err := pc.SetRemoteDescription(answer); err != nil {
		t.Fatalf("set remote: %v", err)
	}

	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("data channel did not open")
	}
	probe := []byte{0, 0, 0, 42}
	if err := dc.Send(probe); err != nil {
		t.Fatalf("send: %v", err)
	}
	select {
	case got := <-echoed:
		if !bytes.Equal(got, probe) {
			t.Errorf("echo = %v, want %v", got, probe)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no echo")
	}
}

func TestRTCInvalidOffer(t *testing.T) {
	srv := newRTCTestServer(t)
	for _, body := range []string{"", "not json", `{"type":"answer","sdp":""}`, `{"type":"offer","sdp":"garbage"}`} {
		res, err := http.Post(srv.URL+"/api/rtc", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want %d", body, res.StatusCode, http.StatusBadRequest)
		}
	}
}

func TestRTCDisabled(t *testing.T) {
	h := newTestServer(t, serverConfig{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/rtc", strings.NewReader("{}")))
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 404 or 405", rec.Code)
	}
}

func TestAdvertisedIPs(t *testing.T) {
	tests := []struct {
		host   string
		public []string
		want   string
	}{
		{"localhost:8080", nil, "127.0.0.1"},
		{"192.0.2.10:8080", nil, "192.0.2.10"},
		{"[2001:db8::1]:8080", nil, "2001:db8::1"},
		{"speed.example.com", nil, ""},
		{"192.0.2.10:8080", []string{"203.0.113.5"}, "203.0.113.5"},
	}
	for _, tt := range tests {
		rs := &rtcServer{publicIPs: tt.public}
		req := httptest.NewRequest(http.MethodPost, "/api/rtc", nil)
		req.Host = tt.host
		if got := strings.Join(rs.advertisedIPs(req), ","); got != tt.want {
			t.Errorf("host %q, public %v: got %q, want %q", tt.host, tt.public, got, tt.want)
		}
	}
}
