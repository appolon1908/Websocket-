package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const contractDigest = "b39cdffe56a8185c91174228f0423df68b1137f34875f6ee52f9914f904bf724"

var errTicketDenied = errors.New("ticket denied")

type config struct {
	listen, middlewareURL, serviceToken, sourceSHA, imageDigest string
	origins                                                     map[string]struct{}
	maxConnections                                              int64
}

type ticketRequest struct {
	Ticket string `json:"ticket"`
}
type principal struct {
	Active     bool      `json:"active"`
	TenantID   string    `json:"tenant_id"`
	CampaignID string    `json:"campaign_id"`
	AgentID    string    `json:"agent_id"`
	Role       string    `json:"role"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type realtimeEvent struct {
	Type       string `json:"type"`
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id"`
	AgentID    string `json:"agent_id,omitempty"`
}

type server struct {
	cfg         config
	client      *http.Client
	active      atomic.Int64
	rejected    atomic.Uint64
	slots       chan struct{}
	mu          sync.Mutex
	perAgent    map[string]int
	connections map[*websocket.Conn]struct{}
	wg          sync.WaitGroup
	draining    atomic.Bool
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	s := newServer(cfg, &http.Client{Timeout: 0})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /version", s.version)
	mux.HandleFunc("GET /metrics", s.metrics)
	mux.HandleFunc("GET /ws/agent", s.agent)
	h := securityHeaders(limitBody(mux))
	httpServer := &http.Server{Addr: cfg.listen, Handler: h, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
		s.shutdown(shutdown)
	}()
	slog.Info("agent realtime gateway starting", "listen", cfg.listen, "contract_digest", contractDigest)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
	if ctx.Err() != nil {
		<-done
	}
}

func newServer(cfg config, client *http.Client) *server {
	return &server{cfg: cfg, client: client, slots: make(chan struct{}, cfg.maxConnections), perAgent: map[string]int{}, connections: map[*websocket.Conn]struct{}{}}
}

func loadConfig() (config, error) {
	c := config{listen: env("LISTEN_ADDR", ":8080"), middlewareURL: strings.TrimRight(os.Getenv("MIDDLEWARE_URL"), "/"), serviceToken: os.Getenv("MIDDLEWARE_SERVICE_TOKEN"), sourceSHA: os.Getenv("SOURCE_SHA"), imageDigest: os.Getenv("IMAGE_DIGEST"), origins: map[string]struct{}{}, maxConnections: 1000}
	for _, o := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.origins[o] = struct{}{}
		}
	}
	if v := os.Getenv("MAX_CONNECTIONS"); v != "" {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil || n < 1 {
			return c, errors.New("MAX_CONNECTIONS must be positive")
		}
		c.maxConnections = n
	}
	if c.middlewareURL == "" || c.serviceToken == "" || len(c.origins) == 0 {
		return c, errors.New("MIDDLEWARE_URL, MIDDLEWARE_SERVICE_TOKEN and ALLOWED_ORIGINS are required")
	}
	return c, nil
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{"status": "ok"})
}
func (s *server) ready(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]any{"status": "draining", "external_effects": false})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.middlewareURL+"/readyz", nil)
	if err == nil {
		req.Header.Set("Authorization", "Bearer "+s.cfg.serviceToken)
		var response *http.Response
		response, err = s.client.Do(req)
		if err == nil {
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			if response.StatusCode != http.StatusOK {
				err = fmt.Errorf("middleware readiness status %d", response.StatusCode)
			}
		}
	}
	if err != nil {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready", "dependency": "middleware", "external_effects": false})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"status": "ready", "external_effects": false})
}
func (s *server) version(w http.ResponseWriter, _ *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{"source_sha": s.cfg.sourceSHA, "image_digest": s.cfg.imageDigest, "contract_version": "1.0.0", "contract_digest": contractDigest})
}
func (s *server) metrics(w http.ResponseWriter, r *http.Request) {
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(provided) != len(s.cfg.serviceToken) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.cfg.serviceToken)) != 1 {
		s.reject(w, "metrics authorization denied", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "codestra_websocket_active_connections %d\ncodestra_websocket_rejected_total %d\n", s.active.Load(), s.rejected.Load())
}

func (s *server) agent(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if _, ok := s.cfg.origins[origin]; !ok {
		s.reject(w, "origin denied", http.StatusForbidden)
		return
	}
	if s.draining.Load() {
		s.reject(w, "gateway draining", http.StatusServiceUnavailable)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		s.reject(w, "capacity exceeded", http.StatusServiceUnavailable)
		return
	}
	ticket := r.URL.Query().Get("ticket")
	if len(ticket) < 32 || len(ticket) > 512 {
		s.reject(w, "invalid ticket", http.StatusUnauthorized)
		return
	}
	p, err := s.consumeTicket(r.Context(), ticket)
	if err != nil {
		if errors.Is(err, errTicketDenied) {
			s.reject(w, "ticket denied", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Retry-After", "1")
		s.reject(w, "ticket authority unavailable; obtain a new ticket before retry", http.StatusServiceUnavailable)
		return
	}
	if !p.Active || p.ExpiresAt.Before(time.Now()) || p.TenantID == "" || p.CampaignID == "" || p.AgentID == "" || (p.Role != "telephony_agent" && p.Role != "telephony_supervisor") {
		s.reject(w, "ticket denied", http.StatusUnauthorized)
		return
	}
	key := p.TenantID + "/" + p.CampaignID + "/" + p.AgentID
	s.mu.Lock()
	if s.perAgent[key] >= 1 {
		s.mu.Unlock()
		s.reject(w, "agent already connected", http.StatusConflict)
		return
	}
	s.perAgent[key]++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.perAgent, key); s.mu.Unlock() }()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer c.CloseNow()
	s.mu.Lock()
	if s.draining.Load() {
		s.mu.Unlock()
		_ = c.Close(websocket.StatusGoingAway, "gateway draining")
		return
	}
	s.connections[c] = struct{}{}
	s.mu.Unlock()
	s.wg.Add(1)
	s.active.Add(1)
	defer func() { s.mu.Lock(); delete(s.connections, c); s.mu.Unlock(); s.active.Add(-1); s.wg.Done() }()
	c.SetReadLimit(8 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	events, eventErrors := s.streamEvents(ctx, p)
	reads := make(chan []byte)
	readErrors := make(chan error, 1)
	go func() {
		defer close(reads)
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				readErrors <- err
				return
			}
			select {
			case reads <- data:
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		select {
		case data, ok := <-reads:
			if !ok {
				return
			}
			if subtle.ConstantTimeCompare(data, []byte("ping")) == 1 {
				if !s.write(c, []byte("pong")) {
					return
				}
			}
		case data, ok := <-events:
			if !ok {
				return
			}
			if !s.write(c, data) {
				return
			}
		case <-readErrors:
			return
		case <-eventErrors:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (s *server) write(c *websocket.Conn, data []byte) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, data) == nil
}

func (s *server) streamEvents(ctx context.Context, p principal) (<-chan []byte, <-chan error) {
	out := make(chan []byte)
	errs := make(chan error, 1)
	go func() {
		defer close(out)
		defer close(errs)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.middlewareURL+"/internal/v1/realtime/events/stream", nil)
		if err != nil {
			errs <- err
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.cfg.serviceToken)
		req.Header.Set("Accept", "application/x-ndjson")
		req.Header.Set("X-Tenant-ID", p.TenantID)
		req.Header.Set("X-Campaign-ID", p.CampaignID)
		req.Header.Set("X-Agent-ID", p.AgentID)
		req.Header.Set("X-Role", p.Role)
		resp, err := s.client.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			errs <- fmt.Errorf("event stream status %d", resp.StatusCode)
			return
		}
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 4096), 64<<10)
		for scanner.Scan() {
			data := append([]byte(nil), scanner.Bytes()...)
			var event realtimeEvent
			if json.Unmarshal(data, &event) != nil || !(strings.HasPrefix(event.Type, "telephony.call.") || strings.HasPrefix(event.Type, "telephony.agent.")) || event.TenantID != p.TenantID || event.CampaignID != p.CampaignID || (event.AgentID != "" && event.AgentID != p.AgentID) {
				s.rejected.Add(1)
				continue
			}
			select {
			case out <- data:
			case <-ctx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			errs <- err
		}
	}()
	return out, errs
}

func (s *server) shutdown(ctx context.Context) {
	s.draining.Store(true)
	s.mu.Lock()
	connections := make([]*websocket.Conn, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	for _, c := range connections {
		_ = c.Close(websocket.StatusGoingAway, "server shutdown")
	}
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (s *server) consumeTicket(ctx context.Context, ticket string) (principal, error) {
	b, _ := json.Marshal(ticketRequest{Ticket: ticket})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.middlewareURL+"/internal/v1/realtime/tickets/consume", bytes.NewReader(b))
	if err != nil {
		return principal{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.serviceToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return principal{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		switch resp.StatusCode {
		case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusConflict, http.StatusGone:
			return principal{}, errTicketDenied
		default:
			return principal{}, fmt.Errorf("ticket authority status %d", resp.StatusCode)
		}
	}
	var p principal
	if err = json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&p); err != nil {
		return p, err
	}
	return p, nil
}

func (s *server) reject(w http.ResponseWriter, msg string, status int) {
	s.rejected.Add(1)
	jsonResponse(w, status, map[string]string{"error": msg})
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
		next.ServeHTTP(w, r)
	})
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
