// Package server exposes rooms over HTTP and WebSocket.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/coder/websocket"

	"drawing-rooms/internal/room"
)

const (
	maxNameRunes = 20
	defaultName  = "Guest"
)

var clientIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// Server is the HTTP handler for the API, WebSocket and frontend.
type Server struct {
	reg   *room.Registry
	cfg   room.Config
	mux   *http.ServeMux
	conns sync.WaitGroup // WebSocket connections, which http.Server.Shutdown does not track
}

// New returns the handler. static serves the frontend; nil disables it.
func New(reg *room.Registry, cfg room.Config, static http.FileSystem) *Server {
	s := &Server{reg: reg, cfg: cfg, mux: http.NewServeMux()}
	s.mux.HandleFunc("POST /api/rooms", s.createRoom)
	s.mux.HandleFunc("GET /api/rooms/{code}", s.roomInfo)
	s.mux.HandleFunc("GET /ws/{code}", s.connect)
	if static != nil {
		s.mux.Handle("GET /", http.FileServer(static))
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// WaitConns blocks until every WebSocket connection has finished closing, or
// until ctx is done.
func (s *Server) WaitConns(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		s.conns.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientID string `json:"clientId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || !clientIDRe.MatchString(body.ClientID) {
		http.Error(w, `body must be {"clientId": "<8..64 chars of [A-Za-z0-9_-]>"}`, http.StatusBadRequest)
		return
	}
	code, err := s.reg.Create(body.ClientID)
	if err != nil {
		slog.Warn("create room", "err", err)
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"code": code})
}

func (s *Server) roomInfo(w http.ResponseWriter, r *http.Request) {
	h, ok := s.lookup(r)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	n, err := h.Members()
	if err != nil {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": h.Code(), "members": n, "capacity": s.cfg.MaxMembers})
}

// connect checks the room and joins it before upgrading, so a missing or full
// room is reported with a plain HTTP status.
func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	h, ok := s.lookup(r)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	clientID := r.URL.Query().Get("clientId")
	if !clientIDRe.MatchString(clientID) {
		http.Error(w, "clientId must be 8..64 chars of [A-Za-z0-9_-]", http.StatusBadRequest)
		return
	}
	c, err := h.Join(cleanName(r.URL.Query().Get("name")), clientID)
	switch {
	case errors.Is(err, room.ErrRoomFull):
		http.Error(w, err.Error(), http.StatusConflict)
		return
	case errors.Is(err, room.ErrRoomGone):
		http.Error(w, "room not found", http.StatusNotFound)
		return
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.conns.Add(1)
	defer s.conns.Done()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		h.Leave(c)
		return
	}
	c.Serve(r.Context(), conn)
}

func (s *Server) lookup(r *http.Request) (*room.Hub, bool) {
	code, ok := room.NormalizeCode(r.PathValue("code"))
	if !ok {
		return nil, false
	}
	return s.reg.Get(code)
}

func cleanName(name string) string {
	name = strings.TrimSpace(strings.ToValidUTF8(name, ""))
	if name == "" {
		return defaultName
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		name = string([]rune(name)[:maxNameRunes])
	}
	return name
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
