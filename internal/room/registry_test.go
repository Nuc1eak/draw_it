package room

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func newTestRegistry(t *testing.T, cfg Config) *Registry {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r := NewRegistry(ctx, cfg)
	t.Cleanup(func() {
		cancel()
		r.Wait()
	})
	return r
}

func TestRegistryCreateAndGet(t *testing.T) {
	r := newTestRegistry(t, testConfig())
	code, err := r.Create("client-a1")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := NormalizeCode(code); !ok {
		t.Fatalf("created code %q is not well-formed", code)
	}
	h, ok := r.Get(code)
	if !ok || h.Code() != code {
		t.Fatalf("Get(%q) = %v, %v", code, h, ok)
	}
	if _, ok := r.Get("ZZZZZ"); ok {
		t.Fatal("Get found a room that was never created")
	}
}

func TestRegistryRoomLimit(t *testing.T) {
	r := newTestRegistry(t, DefaultConfig())
	for i := range 500 {
		if _, err := r.Create("client-a1"); err != nil {
			t.Fatalf("room %d: %v", i+1, err)
		}
	}
	if _, err := r.Create("client-a1"); !errors.Is(err, ErrTooManyRooms) {
		t.Fatalf("room 501: err = %v, want ErrTooManyRooms", err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestRegistryCodeCollision(t *testing.T) {
	r := newTestRegistry(t, testConfig())
	r.rand = zeroReader{} // always "AAAAA"
	if code, err := r.Create("client-a1"); err != nil || code != "AAAAA" {
		t.Fatalf("first create = %q, %v", code, err)
	}
	if _, err := r.Create("client-a1"); !errors.Is(err, ErrNoFreeCode) {
		t.Fatalf("second create: err = %v, want ErrNoFreeCode", err)
	}

	// A collision followed by a free code succeeds on retry.
	r.rand = io.MultiReader(bytes.NewReader(make([]byte, 2*CodeLen)), bytes.NewReader(bytes.Repeat([]byte{1}, 2*CodeLen)))
	if code, err := r.Create("client-a1"); err != nil || code != "BBBBB" {
		t.Fatalf("retry create = %q, %v; want BBBBB", code, err)
	}
}

func TestRegistryDropsExpiredRoom(t *testing.T) {
	cfg := testConfig()
	cfg.CreatorGrace = 20 * time.Millisecond
	r := newTestRegistry(t, cfg)
	code, err := r.Create("client-a1")
	if err != nil {
		t.Fatal(err)
	}
	h, _ := r.Get(code)

	deadline := time.Now().Add(waitTimeout)
	for r.Len() > 0 {
		if time.Now().After(deadline) {
			t.Fatal("expired room still registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := r.Get(code); ok {
		t.Fatal("Get found an expired room")
	}
	// A handler that looked the hub up just before expiry gets ErrRoomGone.
	if _, err := h.Join("A", "client-a1"); !errors.Is(err, ErrRoomGone) {
		t.Fatalf("join expired hub: err = %v, want ErrRoomGone", err)
	}
}

func TestRegistryShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := NewRegistry(ctx, testConfig())
	for range 3 {
		if _, err := r.Create("client-a1"); err != nil {
			t.Fatal(err)
		}
	}
	cancel()
	r.Wait()
	if n := r.Len(); n != 0 {
		t.Fatalf("%d rooms left after shutdown", n)
	}
}
