package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"drawing-rooms/internal/room"
)

// TestShutdownSendsGoingAway runs the real shutdown sequence and checks that
// a connected client gets a GoingAway close frame before run returns.
func TestShutdownSendsGoingAway(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	runErr := make(chan error, 1)
	go func() { runErr <- run(ctx, ln, room.DefaultConfig(), nil) }()

	resp, err := http.Post(base+"/api/rooms", "application/json", strings.NewReader(`{"clientId":"client-alice"}`))
	if err != nil {
		t.Fatal(err)
	}
	var body struct{ Code string }
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()

	dialCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(base, "http")+"/ws/"+body.Code+"?clientId=client-alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	for {
		_, data, err := conn.Read(dialCtx)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), `"type":"synced"`) {
			break
		}
	}

	stop()
	// The server's close handshake waits for the client's reply, which is
	// sent only once the client reads. Until then run must keep waiting:
	// returning earlier would let the process exit before the frame is sent.
	select {
	case err := <-runErr:
		t.Fatalf("run returned (%v) before the WebSocket connection closed", err)
	case <-time.After(300 * time.Millisecond):
	}
	var ce websocket.CloseError
	_, _, err = conn.Read(dialCtx)
	if !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway {
		t.Fatalf("read after shutdown: %v, want close status %v", err, websocket.StatusGoingAway)
	}

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(shutdownTimeout):
		t.Fatal("run did not return")
	}
	// The listener is closed, so nothing can create a room on stopped hubs.
	if resp, err := http.Post(base+"/api/rooms", "application/json", strings.NewReader(`{"clientId":"client-alice"}`)); err == nil {
		resp.Body.Close()
		t.Fatalf("POST after shutdown succeeded with status %d", resp.StatusCode)
	}
}
