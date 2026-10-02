package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

const (
	// maxRTCPeers caps concurrent WebRTC sessions.
	maxRTCPeers = 100
	// maxOfferSize caps the SDP offer body.
	maxOfferSize = 64 << 10
	// maxEchoSize is the largest message echoed back; probes are a few bytes.
	maxEchoSize = 64
	// maxEchoRate caps echoed messages per second and peer (the UI sends ≤ 4/s).
	maxEchoRate = 50
	// rtcSetupTimeout closes peers that never finish connecting.
	rtcSetupTimeout = 15 * time.Second
	// rtcIdleTimeout closes peers that stopped sending probes.
	rtcIdleTimeout = 60 * time.Second
	// gatherTimeout bounds waiting for the answer's candidates.
	gatherTimeout = 5 * time.Second
)

// rtcServer answers WebRTC offers with an ICE-lite peer that echoes every
// data channel message. The browser opens the channel unordered and without
// retransmissions, so it behaves like plain UDP: a lost probe stays lost.
// All peers share one UDP port.
type rtcServer struct {
	mux       ice.UDPMux
	publicIPs []string
	peers     atomic.Int64
}

func newRTCServer(conn net.PacketConn, publicIPs []string) *rtcServer {
	return &rtcServer{mux: webrtc.NewICEUDPMux(nil, conn), publicIPs: publicIPs}
}

type rtcPeer struct {
	pc      *webrtc.PeerConnection
	created time.Time
	last    atomic.Int64 // unix nanos of the last message
	done    chan struct{}
	once    sync.Once
	release func()

	mu      sync.Mutex // guards the echo rate window
	window  time.Time
	inRange int
}

func (p *rtcPeer) close() {
	p.once.Do(func() {
		close(p.done)
		_ = p.pc.Close()
		p.release()
	})
}

// handleRTC takes an SDP offer as JSON ({"type":"offer","sdp":"..."}) and
// returns the answer with all candidates included, so no trickle ICE is needed.
func (rs *rtcServer) handleRTC(w http.ResponseWriter, r *http.Request) {
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOfferSize)).Decode(&offer); err != nil ||
		offer.Type != webrtc.SDPTypeOffer {
		http.Error(w, "invalid offer", http.StatusBadRequest)
		return
	}

	if rs.peers.Add(1) > maxRTCPeers {
		rs.peers.Add(-1)
		http.Error(w, "too many sessions", http.StatusServiceUnavailable)
		return
	}
	api, err := rs.api(r)
	if err != nil {
		rs.peers.Add(-1)
		http.Error(w, "webrtc setup failed", http.StatusInternalServerError)
		return
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		rs.peers.Add(-1)
		http.Error(w, "webrtc setup failed", http.StatusInternalServerError)
		return
	}
	p := &rtcPeer{pc: pc, created: time.Now(), done: make(chan struct{}), release: func() { rs.peers.Add(-1) }}
	p.last.Store(p.created.UnixNano())

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			go p.close() // closing from inside a pion callback can deadlock
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { p.echo(dc) })

	if err := pc.SetRemoteDescription(offer); err != nil {
		p.close()
		http.Error(w, "invalid offer", http.StatusBadRequest)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		p.close()
		http.Error(w, "invalid offer", http.StatusBadRequest)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		p.close()
		http.Error(w, "webrtc setup failed", http.StatusInternalServerError)
		return
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
		p.close()
		http.Error(w, "webrtc setup timed out", http.StatusInternalServerError)
		return
	case <-r.Context().Done():
		p.close()
		return
	}

	go p.watch()
	writeJSON(w, pc.LocalDescription())
}

func (p *rtcPeer) echo(dc *webrtc.DataChannel) {
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		now := time.Now()
		p.last.Store(now.UnixNano())
		if len(msg.Data) > maxEchoSize || !p.allow(now) {
			return
		}
		if msg.IsString {
			_ = dc.SendText(string(msg.Data))
		} else {
			_ = dc.Send(msg.Data)
		}
	})
}

// allow is a fixed one-second window rate limit shared by the peer's channels.
func (p *rtcPeer) allow(now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if now.Sub(p.window) >= time.Second {
		p.window = now
		p.inRange = 0
	}
	p.inRange++
	return p.inRange <= maxEchoRate
}

// watch closes peers that never connect or went quiet, e.g. a closed tab
// whose goodbye packets were lost.
func (p *rtcPeer) watch() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-p.done:
			return
		case now := <-t.C:
			connected := p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
			if !connected && now.Sub(p.created) > rtcSetupTimeout ||
				now.Sub(time.Unix(0, p.last.Load())) > rtcIdleTimeout {
				p.close()
				return
			}
		}
	}
}

// api builds the per-request WebRTC settings: ICE-lite (the browser does the
// connectivity checks), one shared UDP port, and the address to advertise.
func (rs *rtcServer) api(r *http.Request) (*webrtc.API, error) {
	var se webrtc.SettingEngine
	se.SetLite(true)
	se.SetICEUDPMux(rs.mux)
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.SetIncludeLoopbackCandidate(true)

	ips := rs.advertisedIPs(r)
	network := webrtc.NetworkTypeUDP4
	if len(ips) > 0 && net.ParseIP(ips[0]).To4() == nil {
		network = webrtc.NetworkTypeUDP6
	}
	if len(ips) > 0 {
		se.SetNetworkTypes([]webrtc.NetworkType{network})
		err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        ips,
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		})
		if err != nil {
			return nil, err
		}
	} else {
		se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6})
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(se)), nil
}

// advertisedIPs picks the address the browser should send UDP to: the
// configured public IP, else the IP the page was opened with (which reaches
// this host over TCP, so likely over UDP too), else the local interfaces.
func (rs *rtcServer) advertisedIPs(r *http.Request) []string {
	if len(rs.publicIPs) > 0 {
		return rs.publicIPs
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if strings.EqualFold(host, "localhost") {
		return []string{"127.0.0.1"}
	}
	if ip := net.ParseIP(host); ip != nil {
		return []string{ip.String()}
	}
	return nil
}

// listenRTC opens the shared UDP port; addr "off" disables the UDP probe.
func listenRTC(addr string, publicIPs []string) (*rtcServer, error) {
	if addr == "off" {
		return nil, nil
	}
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, err
	}
	log.Printf("WebRTC (UDP) probe on %s", conn.LocalAddr())
	return newRTCServer(conn, publicIPs), nil
}
