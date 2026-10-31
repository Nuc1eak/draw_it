package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"drawing-rooms/internal/room"
	"drawing-rooms/internal/server"
)

type testServer struct {
	*httptest.Server
	cfg room.Config
}

func newTestServer(t *testing.T, cfg room.Config) *testServer {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	reg := room.NewRegistry(ctx, cfg)
	srv := httptest.NewServer(server.New(reg, cfg, nil))
	t.Cleanup(func() {
		cancel()
		reg.Wait()
		srv.Close()
	})
	return &testServer{Server: srv, cfg: cfg}
}

// creatorID is the client ID connect gives the user named "Alice", so Alice
// owns every room created by createRoom.
const creatorID = "client-alice"

func (ts *testServer) createRoom(t *testing.T) string {
	t.Helper()
	resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(`{"clientId":"`+creatorID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create room: status %d", resp.StatusCode)
	}
	var body struct{ Code string }
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Code
}

func (ts *testServer) dial(ctx context.Context, code, name, clientID string) (*websocket.Conn, *http.Response, error) {
	u := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/" + code + "?" +
		url.Values{"name": {name}, "clientId": {clientID}}.Encode()
	return websocket.Dial(ctx, u, nil)
}

type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
	me   room.Member
}

// connect joins a room and consumes the welcome, history and synced messages.
// The read limit is left at the library default on purpose.
func (ts *testServer) connect(t *testing.T, ctx context.Context, code, name string) (*wsClient, []room.Message) {
	t.Helper()
	conn, _, err := ts.dial(ctx, code, name, "client-"+strings.ToLower(name))
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	c := &wsClient{t: t, conn: conn}
	w := c.readType(ctx, room.TypeWelcome)
	c.me = *w.You
	var history []room.Message
	for {
		m := c.read(ctx)
		switch m.Type {
		case room.TypeHistory:
			history = append(history, m.Msgs...)
		case room.TypeSynced:
			return c, history
		default:
			t.Fatalf("%s: got %s before synced", name, m.Type)
		}
	}
}

func (c *wsClient) read(ctx context.Context) room.Message {
	c.t.Helper()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("%s: read: %v", c.me.Name, err)
	}
	var m room.Message
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("%s: decode %s: %v", c.me.Name, data, err)
	}
	return m
}

func (c *wsClient) readType(ctx context.Context, typ string) room.Message {
	c.t.Helper()
	m := c.read(ctx)
	if m.Type != typ {
		c.t.Fatalf("%s: got %s %+v, want %s", c.me.Name, m.Type, m, typ)
	}
	return m
}

func (c *wsClient) write(ctx context.Context, m room.Message) {
	c.t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.conn.Write(ctx, websocket.MessageText, b); err != nil {
		c.t.Fatalf("%s: write %s: %v", c.me.Name, m.Type, err)
	}
}

// barrier returns once the hub has processed everything c sent before it:
// the hub handles a client's messages in order and answers this one with an
// error.
func (c *wsClient) barrier(ctx context.Context) {
	c.t.Helper()
	c.write(ctx, room.Message{Type: "barrier"})
	if m := c.readType(ctx, room.TypeError); m.Code != "unknown_type" {
		c.t.Fatalf("barrier: got error %q", m.Code)
	}
}

// TestTwoClientsSeeEachOthersStrokes is the MVP acceptance test.
func TestTwoClientsSeeEachOthersStrokes(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	b, _ := ts.connect(t, ctx, code, "Bob")
	if m := a.readType(ctx, room.TypeMemberJoined); m.Members[0] != b.me {
		t.Fatalf("Alice saw %+v join, want %+v", m.Members, b.me)
	}

	batch1 := []room.Point{{0.1, 0.1}, {0.15, 0.2}, {0.2, 0.3}}
	batch2 := []room.Point{{0.25, 0.35}, {0.3, 0.4}}
	a.write(ctx, room.Message{Type: room.TypeStrokeStart, ID: "s1", Color: "#e63946", Width: 6})
	a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: "s1", Pts: batch1})
	a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: "s1", Pts: batch2})
	a.write(ctx, room.Message{Type: room.TypeStrokeEnd, ID: "s1"})

	wantID := a.me.ID + ":s1"
	start := b.readType(ctx, room.TypeStrokeStart)
	if start.ID != wantID || start.Author != a.me.ID || start.Color != "#e63946" || start.Width != 6 {
		t.Fatalf("stroke_start = %+v", start)
	}
	for _, want := range [][]room.Point{batch1, batch2} {
		m := b.readType(ctx, room.TypeStrokePoints)
		if m.ID != wantID || m.Author != a.me.ID || !slices.Equal(m.Pts, want) {
			t.Fatalf("stroke_points = %+v, want %v", m, want)
		}
	}
	if m := b.readType(ctx, room.TypeStrokeEnd); m.ID != wantID {
		t.Fatalf("stroke_end = %+v", m)
	}

	// Alice draws locally and must not get her own stroke back: the next
	// thing she sees is Bob's cursor.
	b.write(ctx, room.Message{Type: room.TypeCursor, Pos: &room.Point{0.5, 0.5}})
	if m := a.readType(ctx, room.TypeCursor); m.MemberID != b.me.ID {
		t.Fatalf("cursor from %q, want %q", m.MemberID, b.me.ID)
	}
}

func TestLateJoinerReceivesHistory(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	pts := []room.Point{{0.1, 0.2}, {0.3, 0.4}}
	a.write(ctx, room.Message{Type: room.TypeStrokeStart, ID: "s1", Color: "#000000", Width: 2})
	a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: "s1", Pts: pts})
	a.write(ctx, room.Message{Type: room.TypeStrokeEnd, ID: "s1"})
	a.barrier(ctx)

	_, history := ts.connect(t, ctx, strings.ToLower(code), "Carol")
	types := make([]string, len(history))
	for i, m := range history {
		types[i] = m.Type
	}
	if !slices.Equal(types, []string{room.TypeStrokeStart, room.TypeStrokePoints, room.TypeStrokeEnd}) {
		t.Fatalf("history = %v", types)
	}
	if h := history[1]; h.ID != a.me.ID+":s1" || !slices.Equal(h.Pts, pts) {
		t.Fatalf("history points = %+v", h)
	}
}

func TestLateJoinerReceivesLargeHistory(t *testing.T) {
	cfg := room.DefaultConfig()
	// Every frame gets its own deadline, so a short one is fine for an 8 MB
	// history as long as each frame is small.
	cfg.WriteTimeout = 500 * time.Millisecond
	ts := newTestServer(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")

	r := rand.New(rand.NewPCG(7, 8))
	strokes := cfg.MaxPoints / cfg.MaxStrokePoints
	for s := range strokes {
		id := fmt.Sprintf("s%d", s)
		a.write(ctx, room.Message{Type: room.TypeStrokeStart, ID: id, Color: "#336699", Width: 12})
		for sent := 0; sent < cfg.MaxStrokePoints; sent += room.MaxPointsPerMessage {
			pts := make([]room.Point, room.MaxPointsPerMessage)
			for i := range pts {
				pts[i] = room.Point{float32(r.IntN(9000)+1000) / 1e4, float32(r.IntN(9000)+1000) / 1e4}
			}
			a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: id, Pts: pts})
		}
		a.write(ctx, room.Message{Type: room.TypeStrokeEnd, ID: id})
	}
	// Each stroke hit MaxStrokePoints, so the server ended it and told the
	// author too; the author's own stroke_end was then ignored.
	for s := range strokes {
		if m := a.readType(ctx, room.TypeStrokeEnd); m.ID != fmt.Sprintf("%s:s%d", a.me.ID, s) {
			t.Fatalf("auto stroke_end for %q, want s%d", m.ID, s)
		}
	}
	a.barrier(ctx)

	conn, _, err := ts.dial(ctx, code, "Carol", "client-carol")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	c := &wsClient{t: t, conn: conn}

	began := time.Now()
	points, frames, bytes := 0, 0, 0
	ended := 0
	for synced := false; !synced; {
		_, data, err := conn.Read(ctx) // default 32 KB read limit
		if err != nil {
			t.Fatalf("read after %d frames: %v", frames, err)
		}
		if len(data) > room.MaxFrameBytes {
			t.Fatalf("frame of %d bytes exceeds %d", len(data), room.MaxFrameBytes)
		}
		frames++
		bytes += len(data)
		var m room.Message
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatal(err)
		}
		switch m.Type {
		case room.TypeWelcome:
			c.me = *m.You
		case room.TypeHistory:
			for _, sm := range m.Msgs {
				switch sm.Type {
				case room.TypeStrokePoints:
					points += len(sm.Pts)
				case room.TypeStrokeEnd:
					ended++
				}
			}
		case room.TypeSynced:
			synced = true
		default:
			t.Fatalf("got %s during sync", m.Type)
		}
	}
	t.Logf("synced %d points in %d frames (%d KB) in %v", points, frames, bytes/1024, time.Since(began))
	if points != cfg.MaxPoints || ended != strokes {
		t.Fatalf("history had %d points and %d ended strokes, want %d and %d", points, ended, cfg.MaxPoints, strokes)
	}

	// One more batch goes over the limit and evicts the oldest stroke for everyone.
	a.readType(ctx, room.TypeMemberJoined)
	a.write(ctx, room.Message{Type: room.TypeStrokeStart, ID: "extra", Color: "#336699", Width: 12})
	a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: "extra", Pts: []room.Point{{0.5, 0.5}}})
	c.readType(ctx, room.TypeStrokeStart)
	c.readType(ctx, room.TypeStrokePoints)
	want := []string{a.me.ID + ":s0"}
	for _, cl := range []*wsClient{c, a} {
		if m := cl.readType(ctx, room.TypeStrokeRemoved); !slices.Equal(m.IDs, want) {
			t.Fatalf("evicted %v, want %v", m.IDs, want)
		}
	}
}

func TestConnectErrors(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	code := ts.createRoom(t)

	tests := []struct {
		name, code, clientID string
		status               int
	}{
		{"unknown room", "ZZZZZ", "client-x1", http.StatusNotFound},
		{"malformed code", "abc", "client-x1", http.StatusNotFound},
		{"missing client id", code, "", http.StatusBadRequest},
		{"short client id", code, "abc", http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			conn, resp, err := ts.dial(ctx, tt.code, "X", tt.clientID)
			if err == nil {
				conn.CloseNow()
				t.Fatal("dial succeeded")
			}
			if resp == nil || resp.StatusCode != tt.status {
				t.Fatalf("response = %v, want status %d", resp, tt.status)
			}
		})
	}
}

func TestRoomFull(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	for i := range ts.cfg.MaxMembers {
		ts.connect(t, ctx, code, fmt.Sprintf("User%d", i))
	}
	conn, resp, err := ts.dial(ctx, code, "Late", "client-late")
	if err == nil {
		conn.CloseNow()
		t.Fatal("11th client was admitted")
	}
	if resp == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("response = %v, want 409", resp)
	}
}

func TestRoomInfo(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	ts.connect(t, ctx, code, "Alice")

	resp, err := http.Get(ts.URL + "/api/rooms/" + strings.ToLower(code))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var info struct {
		Code              string
		Members, Capacity int
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || info.Code != code || info.Members != 1 || info.Capacity != 10 {
		t.Fatalf("info = %d %+v", resp.StatusCode, info)
	}

	resp, err = http.Get(ts.URL + "/api/rooms/ZZZZZ")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown room: status %d, want 404", resp.StatusCode)
	}
}

func TestCreateRoomLimit(t *testing.T) {
	cfg := room.DefaultConfig()
	cfg.MaxRooms = 1
	ts := newTestServer(t, cfg)
	ts.createRoom(t)
	resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(`{"clientId":"`+creatorID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", resp.StatusCode)
	}
}

func TestCreateRoomRequiresClientID(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	for _, body := range []string{"", "{}", `{"clientId":"short"}`, `{"clientId":"has spaces in it"}`} {
		resp, err := http.Post(ts.URL+"/api/rooms", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("body %q: status %d, want 400", body, resp.StatusCode)
		}
	}
}

// readClose reads until the connection closes and returns its close status.
func (c *wsClient) readClose(ctx context.Context) websocket.CloseError {
	c.t.Helper()
	for {
		_, _, err := c.conn.Read(ctx)
		if err == nil {
			continue
		}
		var ce websocket.CloseError
		if !errors.As(err, &ce) {
			c.t.Fatalf("%s: connection ended without a close frame: %v", c.me.Name, err)
		}
		return ce
	}
}

func TestCreatorClosesRoom(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	b, _ := ts.connect(t, ctx, code, "Bob")
	if !a.me.Creator || b.me.Creator {
		t.Fatalf("creator flags: Alice=%v Bob=%v", a.me.Creator, b.me.Creator)
	}
	a.readType(ctx, room.TypeMemberJoined)

	b.write(ctx, room.Message{Type: room.TypeCloseRoom})
	if m := b.readType(ctx, room.TypeError); m.Code != "forbidden" {
		t.Fatalf("Bob closing the room: error %q, want forbidden", m.Code)
	}

	a.write(ctx, room.Message{Type: room.TypeCloseRoom})
	for _, c := range []*wsClient{a, b} {
		if ce := c.readClose(ctx); ce.Code != room.StatusRoomClosed || ce.Reason != room.ReasonCreatorLeft {
			t.Fatalf("%s: closed with %v %q, want %v %q", c.me.Name, ce.Code, ce.Reason, room.StatusRoomClosed, room.ReasonCreatorLeft)
		}
	}
	resp, err := http.Get(ts.URL + "/api/rooms/" + code)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("closed room: status %d, want 404", resp.StatusCode)
	}
}

// TestSlowClientGetsPolicyViolation checks the close frame a kicked client
// actually receives. Bob reads nothing, so the server's write to him blocks on
// a full TCP buffer, while he keeps sending. The kick used to cancel that
// in-flight write and drop the connection without a close frame.
func TestSlowClientGetsPolicyViolation(t *testing.T) {
	cfg := room.DefaultConfig()
	cfg.SendBuffer = 16
	ts := newTestServer(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	b, _ := ts.connect(t, ctx, code, "Bob")
	a.readType(ctx, room.TypeMemberJoined)

	kicked := make(chan struct{})
	go func() {
		defer close(kicked)
		for {
			_, data, err := a.conn.Read(ctx)
			if err != nil {
				return
			}
			var m room.Message
			if json.Unmarshal(data, &m) == nil && m.Type == room.TypeMemberLeft && m.MemberID == b.me.ID {
				return
			}
		}
	}()
	// Bob's bad messages are answered only to Bob, so the hub keeps handling
	// his reads while his writes are stuck.
	bobDone := make(chan struct{})
	go func() {
		defer close(bobDone)
		for {
			select {
			case <-kicked:
				return
			case <-time.After(time.Millisecond):
			}
			if b.conn.Write(ctx, websocket.MessageText, []byte(`{"type":"nope"}`)) != nil {
				return
			}
		}
	}()

	pts := make([]room.Point, room.MaxPointsPerMessage)
	for i := range pts {
		pts[i] = room.Point{0.1234, 0.5678}
	}
	for n := 0; ; n++ {
		select {
		case <-kicked:
		default:
			id := fmt.Sprintf("s%d", n/50)
			if n%50 == 0 {
				a.write(ctx, room.Message{Type: room.TypeStrokeStart, ID: id, Color: "#000000", Width: 2})
			}
			a.write(ctx, room.Message{Type: room.TypeStrokePoints, ID: id, Pts: pts})
			continue
		}
		break
	}
	<-bobDone

	if ce := b.readClose(ctx); ce.Code != websocket.StatusPolicyViolation {
		t.Fatalf("Bob closed with %v %q, want %v", ce.Code, ce.Reason, websocket.StatusPolicyViolation)
	}
}

func TestInboundMessageLimit(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	b, _ := ts.connect(t, ctx, code, "Bob")
	a.readType(ctx, room.TypeMemberJoined)

	padded := func(size int) []byte {
		msg := []byte(`{"type":"cursor","pos":[0.5,0.5]}`)
		return append(msg, strings.Repeat(" ", size-len(msg))...)
	}
	limit := int(ts.cfg.MaxMessageBytes)

	if err := a.conn.Write(ctx, websocket.MessageText, padded(limit)); err != nil {
		t.Fatal(err)
	}
	if m := b.readType(ctx, room.TypeCursor); m.MemberID != a.me.ID {
		t.Fatalf("cursor from %q, want %q", m.MemberID, a.me.ID)
	}

	if err := a.conn.Write(ctx, websocket.MessageText, padded(limit+1)); err != nil {
		t.Fatal(err)
	}
	if ce := a.readClose(ctx); ce.Code != websocket.StatusMessageTooBig {
		t.Fatalf("oversized message: closed with %v, want %v", ce.Code, websocket.StatusMessageTooBig)
	}
	if m := b.readType(ctx, room.TypeMemberLeft); m.MemberID != a.me.ID {
		t.Fatalf("member_left %q, want %q", m.MemberID, a.me.ID)
	}
}

func TestLateJoinerReceivesFillsAndTexts(t *testing.T) {
	ts := newTestServer(t, room.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	code := ts.createRoom(t)
	a, _ := ts.connect(t, ctx, code, "Alice")
	b, _ := ts.connect(t, ctx, code, "Bob")
	a.readType(ctx, room.TypeMemberJoined)

	pos := room.Point{0.25, 0.5}
	a.write(ctx, room.Message{Type: room.TypeFill, ID: "s1", Color: "#ff0000", Pos: &pos})
	a.write(ctx, room.Message{Type: room.TypeText, ID: "s2", Color: "#00ff00", Width: 8, Content: "Привіт", Pos: &pos})
	if m := b.readType(ctx, room.TypeFill); m.Author != a.me.ID || m.Color != "#ff0000" || *m.Pos != pos {
		t.Fatalf("live fill = %+v", m)
	}
	if m := b.readType(ctx, room.TypeText); m.Content != "Привіт" {
		t.Fatalf("live text = %+v", m)
	}

	_, history := ts.connect(t, ctx, code, "Carol")
	if len(history) != 2 || history[0].Type != room.TypeFill || history[1].Type != room.TypeText {
		t.Fatalf("history = %+v", history)
	}
	if history[1].Content != "Привіт" || history[1].Width != 8 || *history[1].Pos != pos {
		t.Fatalf("history text = %+v", history[1])
	}
}

func TestFrontendIsAlwaysRevalidated(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "style.css"), []byte("body {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := room.DefaultConfig()
	ctx, cancel := context.WithCancel(context.Background())
	reg := room.NewRegistry(ctx, cfg)
	srv := httptest.NewServer(server.New(reg, cfg, http.Dir(dir)))
	t.Cleanup(func() {
		cancel()
		reg.Wait()
		srv.Close()
	})

	resp, err := http.Get(srv.URL + "/style.css")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
}
