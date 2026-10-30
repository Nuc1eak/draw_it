package room

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"sync"
)

var (
	// ErrTooManyRooms is returned by Create when MaxRooms rooms are open.
	ErrTooManyRooms = errors.New("too many rooms")
	// ErrNoFreeCode is returned by Create when every attempt collided.
	ErrNoFreeCode = errors.New("could not find a free room code")
)

const codeAttempts = 10

// Registry maps room codes to running hubs.
type Registry struct {
	ctx  context.Context
	cfg  Config
	rand io.Reader
	wg   sync.WaitGroup

	mu    sync.Mutex
	rooms map[string]*Hub
}

// NewRegistry returns a registry whose hubs stop when ctx is cancelled.
func NewRegistry(ctx context.Context, cfg Config) *Registry {
	return &Registry{ctx: ctx, cfg: cfg, rand: rand.Reader, rooms: make(map[string]*Hub)}
}

// Create starts a new empty room and returns its code. The room expires after
// EmptyTTL if nobody joins.
func (r *Registry) Create() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.rooms) >= r.cfg.MaxRooms {
		return "", ErrTooManyRooms
	}
	for range codeAttempts {
		code, err := newCode(r.rand)
		if err != nil {
			return "", err
		}
		if _, taken := r.rooms[code]; taken {
			continue
		}
		var h *Hub
		h = newHub(code, r.cfg, func() { r.remove(code, h) })
		r.rooms[code] = h
		r.wg.Go(func() { h.run(r.ctx) })
		return code, nil
	}
	return "", ErrNoFreeCode
}

// Get returns the hub for an already normalized code.
func (r *Registry) Get(code string) (*Hub, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.rooms[code]
	return h, ok
}

// Len reports the number of open rooms.
func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.rooms)
}

// Wait blocks until every hub has stopped.
func (r *Registry) Wait() { r.wg.Wait() }

func (r *Registry) remove(code string, h *Hub) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rooms[code] == h {
		delete(r.rooms, code)
	}
}
