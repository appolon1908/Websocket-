package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestOriginAndTicketFailClosed(t *testing.T) {
	s := newServer(config{origins: map[string]struct{}{"https://odoo.codestra.co": {}}, maxConnections: 1}, http.DefaultClient)
	for _, tc := range []struct {
		name, origin, ticket string
		want                 int
	}{
		{"wrong origin", "https://evil.example", strings.Repeat("x", 32), http.StatusForbidden},
		{"missing ticket", "https://odoo.codestra.co", "", http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/ws/agent?ticket="+tc.ticket, nil)
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			s.agent(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d", w.Code, tc.want)
			}
		})
	}
}

func TestVersionPinsContract(t *testing.T) {
	s := &server{cfg: config{sourceSHA: "abc", imageDigest: "sha256:def"}}
	w := httptest.NewRecorder()
	s.version(w, httptest.NewRequest(http.MethodGet, "/version", nil))
	if w.Code != 200 || !contains(w.Body.String(), contractDigest) {
		t.Fatal(w.Body.String())
	}
}

func TestReadinessRequiresMiddleware(t *testing.T) {
	for _, tc := range []struct {
		name       string
		upstream   int
		draining   bool
		wantStatus int
	}{
		{"middleware ready", http.StatusOK, false, http.StatusOK},
		{"middleware unavailable", http.StatusServiceUnavailable, false, http.StatusServiceUnavailable},
		{"gateway draining", http.StatusOK, true, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer service" {
					t.Fatal("missing service authorization")
				}
				w.WriteHeader(tc.upstream)
			}))
			defer upstream.Close()
			s := newServer(config{middlewareURL: upstream.URL, serviceToken: "service", maxConnections: 1}, upstream.Client())
			s.draining.Store(tc.draining)
			w := httptest.NewRecorder()
			s.ready(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			if w.Code != tc.wantStatus {
				t.Fatalf("got %d want %d", w.Code, tc.wantStatus)
			}
		})
	}
}
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestStreamEventsForwardsOnlyPrincipalScope(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/realtime/events/stream" || r.Header.Get("X-Tenant-ID") != "tenant-1" || r.Header.Get("X-Campaign-ID") != "campaign-1" || r.Header.Get("X-Agent-ID") != "agent-1" {
			t.Fatalf("unexpected scoped request: %s %#v", r.URL.Path, r.Header)
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, event := range []map[string]string{
			{"type": "telephony.call.ringing.v1", "tenant_id": "tenant-2", "campaign_id": "campaign-1", "agent_id": "agent-1"},
			{"type": "billing.changed.v1", "tenant_id": "tenant-1", "campaign_id": "campaign-1", "agent_id": "agent-1"},
			{"type": "telephony.call.ringing.v1", "tenant_id": "tenant-1", "campaign_id": "campaign-1", "agent_id": "agent-1"},
		} {
			_ = json.NewEncoder(w).Encode(event)
		}
	}))
	defer upstream.Close()
	s := newServer(config{middlewareURL: upstream.URL, serviceToken: "service", maxConnections: 1}, upstream.Client())
	events, errs := s.streamEvents(context.Background(), principal{TenantID: "tenant-1", CampaignID: "campaign-1", AgentID: "agent-1"})
	data := <-events
	if !contains(string(data), "telephony.call.ringing.v1") || s.rejected.Load() != 2 {
		t.Fatalf("unexpected event %s rejected=%d", data, s.rejected.Load())
	}
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
}

func TestCapacityReservationIsAtomic(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		jsonResponse(w, http.StatusUnauthorized, map[string]string{"error": "denied"})
	}))
	defer upstream.Close()
	s := newServer(config{middlewareURL: upstream.URL, serviceToken: "service", origins: map[string]struct{}{"https://odoo.codestra.co": {}}, maxConnections: 1}, upstream.Client())
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/ws/agent?ticket="+strings.Repeat("x", 32), nil)
		r.Header.Set("Origin", "https://odoo.codestra.co")
		return r
	}
	firstDone := make(chan struct{})
	go func() { s.agent(httptest.NewRecorder(), request()); close(firstDone) }()
	<-entered
	second := httptest.NewRecorder()
	s.agent(second, request())
	if second.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want %d", second.Code, http.StatusServiceUnavailable)
	}
	close(release)
	<-firstDone
}

func TestShutdownClosesUpgradedConnections(t *testing.T) {
	streamStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/consume") {
			jsonResponse(w, http.StatusOK, principal{Active: true, TenantID: "tenant-1", CampaignID: "campaign-1", AgentID: "agent-1", Role: "telephony_agent", ExpiresAt: time.Now().Add(time.Minute)})
			return
		}
		close(streamStarted)
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	s := newServer(config{middlewareURL: upstream.URL, serviceToken: "service", origins: map[string]struct{}{"https://odoo.codestra.co": {}}, maxConnections: 1}, upstream.Client())
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/agent", s.agent)
	gateway := httptest.NewServer(mux)
	defer gateway.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(gateway.URL, "http")+"/ws/agent?ticket="+strings.Repeat("x", 32), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://odoo.codestra.co"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	<-streamStarted
	clientClosed := make(chan error, 1)
	go func() { _, _, err := c.Read(ctx); clientClosed <- err }()
	s.shutdown(ctx)
	if s.active.Load() != 0 {
		t.Fatalf("active connections=%d", s.active.Load())
	}
	err = <-clientClosed
	if websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Fatalf("close status=%v err=%v", websocket.CloseStatus(err), err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestTicketAuthorityOutageIsRetryable(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("middleware unavailable")
	})}
	s := newServer(config{
		middlewareURL:  "http://middleware.invalid",
		serviceToken:   "service",
		origins:        map[string]struct{}{"https://odoo.codestra.co": {}},
		maxConnections: 1,
	}, client)
	r := httptest.NewRequest(http.MethodGet, "/ws/agent?ticket="+strings.Repeat("x", 32), nil)
	r.Header.Set("Origin", "https://odoo.codestra.co")
	w := httptest.NewRecorder()
	s.agent(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusServiceUnavailable, w.Body.String())
	}
	if w.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After=%q", w.Header().Get("Retry-After"))
	}
}

func TestRejectedTicketRemainsUnauthorized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer upstream.Close()
	s := newServer(config{
		middlewareURL:  upstream.URL,
		serviceToken:   "service",
		origins:        map[string]struct{}{"https://odoo.codestra.co": {}},
		maxConnections: 1,
	}, upstream.Client())
	r := httptest.NewRequest(http.MethodGet, "/ws/agent?ticket="+strings.Repeat("x", 32), nil)
	r.Header.Set("Origin", "https://odoo.codestra.co")
	w := httptest.NewRecorder()
	s.agent(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want %d: %s", w.Code, http.StatusUnauthorized, w.Body.String())
	}
}

func TestFinalProtectedContractDigest(t *testing.T) {
	const expected = "b39cdffe56a8185c91174228f0423df68b1137f34875f6ee52f9914f904bf724"
	if contractDigest != expected {
		t.Fatalf("contract digest=%s want=%s", contractDigest, expected)
	}
}
