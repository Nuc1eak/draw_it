package room

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const waitTimeout = 2 * time.Second

func testConfig() Config {
	cfg := DefaultConfig()
	cfg.EmptyTTL = time.Hour
	return cfg
}

// startHub runs a hub without a registry. exited is closed when the hub
// calls onExit.
func startHub(t *testing.T, cfg Config) (h *Hub, exited chan struct{}) {
	t.Helper()
	exited = make(chan struct{})
	h = newHub("TEST1", cfg, func() { close(exited) })
	ctx, cancel := context.WithCancel(context.Background())
	go h.run(ctx)
	t.Cleanup(func() {
		cancel()
		<-h.done
	})
	return h, exited
}

func join(t *testing.T, h *Hub, name, clientID string) *Client {
	t.Helper()
	c, err := h.Join(name, clientID)
	if err != nil {
		t.Fatalf("join %s: %v", name, err)
	}
	return c
}

func send(t *testing.T, c *Client, m Message) {
	t.Helper()
	if !c.hub.deliver(context.Background(), inbound{c: c, msg: m}) {
		t.Fatalf("deliver %s: hub or client gone", m.Type)
	}
}

func recv(t *testing.T, c *Client) Message {
	t.Helper()
	select {
	case b := <-c.send:
		var m Message
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("decode %s: %v", b, err)
		}
		return m
	case <-time.After(waitTimeout):
		t.Fatalf("%s: no message within %v", c.member.Name, waitTimeout)
		return Message{}
	}
}

func recvType(t *testing.T, c *Client, typ string) Message {
	t.Helper()
	m := recv(t, c)
	if m.Type != typ {
		t.Fatalf("%s: got %s %+v, want %s", c.member.Name, m.Type, m, typ)
	}
	return m
}

// expectQuiet proves c has no pending messages: the hub handles inbound
// messages in order, so a cursor from other must be the next thing c sees.
func expectQuiet(t *testing.T, c, other *Client) {
	t.Helper()
	send(t, other, Message{Type: TypeCursor, Pos: &Point{0.5, 0.5}})
	if m := recv(t, c); m.Type != TypeCursor || m.MemberID != other.member.ID {
		t.Fatalf("%s: got %s %+v, want only the sentinel cursor", c.member.Name, m.Type, m)
	}
}

func line(n int, offset float32) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Point{offset, float32(i%10000) / 10000}
	}
	return pts
}

func draw(t *testing.T, c *Client, id string, pts []Point, end bool) {
	t.Helper()
	send(t, c, Message{Type: TypeStrokeStart, ID: id, Color: "#112233", Width: 4})
	for i := 0; i < len(pts); i += MaxPointsPerMessage {
		send(t, c, Message{Type: TypeStrokePoints, ID: id, Pts: pts[i:min(i+MaxPointsPerMessage, len(pts))]})
	}
	if end {
		send(t, c, Message{Type: TypeStrokeEnd, ID: id})
	}
}

func TestHubRelaysStrokesToOthersOnly(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	if m := recvType(t, a, TypeMemberJoined); m.Members[0] != b.member {
		t.Fatalf("member_joined = %+v, want %+v", m.Members, b.member)
	}

	pts := []Point{{0.1, 0.2}, {0.3, 0.4}}
	draw(t, a, "s1", pts, true)

	start := recvType(t, b, TypeStrokeStart)
	if start.ID != "m1:s1" || start.Author != "m1" || start.Color != "#112233" || start.Width != 4 {
		t.Fatalf("stroke_start = %+v", start)
	}
	if m := recvType(t, b, TypeStrokePoints); m.ID != "m1:s1" || !slices.Equal(m.Pts, pts) {
		t.Fatalf("stroke_points = %+v", m)
	}
	if m := recvType(t, b, TypeStrokeEnd); m.ID != "m1:s1" {
		t.Fatalf("stroke_end = %+v", m)
	}
	expectQuiet(t, a, b)
}

func TestHubWelcomeAndSnapshotForLateJoiner(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	draw(t, a, "done", line(3, 0.1), true)
	draw(t, a, "open", line(2, 0.2), false)

	c := join(t, h, "C", "client-c1")
	var w Message
	if err := json.Unmarshal(c.welcome, &w); err != nil {
		t.Fatal(err)
	}
	if w.Type != TypeWelcome || *w.You != c.member || !slices.Equal(w.Members, []Member{a.member, c.member}) {
		t.Fatalf("welcome = %s", c.welcome)
	}
	if len(c.snapshot) != 2 {
		t.Fatalf("snapshot has %d strokes, want 2", len(c.snapshot))
	}
	if s := c.snapshot[0]; s.id != "m1:done" || !s.ended || !slices.Equal(s.pts, line(3, 0.1)) {
		t.Errorf("snapshot[0] = %+v", s)
	}
	if s := c.snapshot[1]; s.id != "m1:open" || s.ended || len(s.pts) != 2 {
		t.Errorf("snapshot[1] = %+v", s)
	}
}

func TestHubUndoRemovesOwnLastStroke(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)

	draw(t, a, "s1", line(2, 0.1), true)
	draw(t, a, "s2", line(2, 0.2), true)
	draw(t, b, "b1", line(2, 0.3), true)
	for range 3 {
		recv(t, a) // b1
	}
	for range 6 {
		recv(t, b) // s1, s2
	}

	send(t, a, Message{Type: TypeUndo})
	for _, c := range []*Client{a, b} {
		if m := recvType(t, c, TypeStrokeRemoved); !slices.Equal(m.IDs, []string{"m1:s2"}) {
			t.Fatalf("%s: removed %v, want [m1:s2]", c.member.Name, m.IDs)
		}
	}

	send(t, b, Message{Type: TypeUndo})
	for _, c := range []*Client{a, b} {
		if m := recvType(t, c, TypeStrokeRemoved); !slices.Equal(m.IDs, []string{"m2:b1"}) {
			t.Fatalf("%s: removed %v, want [m2:b1]", c.member.Name, m.IDs)
		}
	}

	// Ownership follows the client ID, so undo still works after reconnecting.
	h.Leave(a)
	recvType(t, b, TypeMemberLeft)
	a2 := join(t, h, "A", "client-a1")
	recvType(t, b, TypeMemberJoined)
	send(t, a2, Message{Type: TypeUndo})
	if m := recvType(t, b, TypeStrokeRemoved); !slices.Equal(m.IDs, []string{"m1:s1"}) {
		t.Fatalf("removed %v after reconnect, want [m1:s1]", m.IDs)
	}

	// Nothing left to undo: no message at all.
	send(t, a2, Message{Type: TypeUndo})
	recvType(t, a2, TypeStrokeRemoved) // its own earlier undo
	expectQuiet(t, a2, b)
}

func TestHubClear(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)
	draw(t, a, "s1", line(5, 0.1), true)
	for range 3 {
		recv(t, b)
	}

	send(t, b, Message{Type: TypeClear})
	for _, c := range []*Client{a, b} {
		if m := recvType(t, c, TypeCleared); m.MemberID != "m2" {
			t.Fatalf("cleared by %q, want m2", m.MemberID)
		}
	}
	// Points for a stroke that was cleared mid-draw are dropped.
	send(t, a, Message{Type: TypeStrokePoints, ID: "s1", Pts: line(1, 0.5)})
	expectQuiet(t, b, a)

	if c := join(t, h, "C", "client-c1"); len(c.snapshot) != 0 {
		t.Errorf("snapshot after clear has %d strokes", len(c.snapshot))
	}
}

func TestHubEvictsOldestEndedStrokes(t *testing.T) {
	cfg := testConfig()
	cfg.MaxPoints = 10
	h, _ := startHub(t, cfg)
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)

	draw(t, a, "s1", line(6, 0.1), true)
	draw(t, a, "s2", line(4, 0.2), true)
	for range 6 {
		recv(t, b)
	}
	expectQuiet(t, a, b) // exactly at the limit: nothing evicted

	draw(t, a, "s3", line(3, 0.3), false)
	recvType(t, b, TypeStrokeStart)
	recvType(t, b, TypeStrokePoints)
	for _, c := range []*Client{a, b} {
		if m := recvType(t, c, TypeStrokeRemoved); !slices.Equal(m.IDs, []string{"m1:s1"}) {
			t.Fatalf("%s: evicted %v, want [m1:s1]", c.member.Name, m.IDs)
		}
	}
	c := join(t, h, "C", "client-c1")
	var ids []string
	points := 0
	for _, s := range c.snapshot {
		ids = append(ids, s.id)
		points += len(s.pts)
	}
	if !slices.Equal(ids, []string{"m1:s2", "m1:s3"}) || points != 7 {
		t.Errorf("after eviction: strokes %v with %d points, want [m1:s2 m1:s3] with 7", ids, points)
	}
}

func TestHubNeverEvictsStrokesInProgress(t *testing.T) {
	cfg := testConfig()
	cfg.MaxPoints = 5
	h, _ := startHub(t, cfg)
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)

	draw(t, a, "s1", line(8, 0.1), false)
	recvType(t, b, TypeStrokeStart)
	recvType(t, b, TypeStrokePoints)
	expectQuiet(t, b, a)

	// Once it ends, it is the oldest ended stroke and goes.
	send(t, a, Message{Type: TypeStrokeEnd, ID: "s1"})
	recvType(t, b, TypeStrokeEnd)
	if m := recvType(t, b, TypeStrokeRemoved); !slices.Equal(m.IDs, []string{"m1:s1"}) {
		t.Fatalf("evicted %v, want [m1:s1]", m.IDs)
	}
}

func TestHubAutoEndsLongStroke(t *testing.T) {
	cfg := testConfig()
	cfg.MaxStrokePoints = 5
	h, _ := startHub(t, cfg)
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)

	send(t, a, Message{Type: TypeStrokeStart, ID: "s1", Color: "#000000", Width: 2})
	send(t, a, Message{Type: TypeStrokePoints, ID: "s1", Pts: line(3, 0.1)})
	send(t, a, Message{Type: TypeStrokePoints, ID: "s1", Pts: line(4, 0.2)})

	recvType(t, b, TypeStrokeStart)
	recvType(t, b, TypeStrokePoints)
	if m := recvType(t, b, TypeStrokePoints); len(m.Pts) != 2 {
		t.Fatalf("second batch relayed %d points, want 2 (truncated)", len(m.Pts))
	}
	// Both sides learn the stroke is over, the author included.
	recvType(t, b, TypeStrokeEnd)
	recvType(t, a, TypeStrokeEnd)

	send(t, a, Message{Type: TypeStrokePoints, ID: "s1", Pts: line(1, 0.3)})
	send(t, a, Message{Type: TypeStrokeEnd, ID: "s1"})
	expectQuiet(t, b, a)
}

func TestHubKicksSlowClient(t *testing.T) {
	cfg := testConfig()
	cfg.SendBuffer = 2
	h, _ := startHub(t, cfg)
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1") // never drained
	recvType(t, a, TypeMemberJoined)

	for range 3 {
		send(t, a, Message{Type: TypeCursor, Pos: &Point{0.1, 0.1}})
	}
	select {
	case <-b.done:
	case <-time.After(waitTimeout):
		t.Fatal("slow client was not disconnected")
	}
	if b.closeCode != websocket.StatusPolicyViolation {
		t.Errorf("close code = %v, want %v", b.closeCode, websocket.StatusPolicyViolation)
	}
	if m := recvType(t, a, TypeMemberLeft); m.MemberID != b.member.ID {
		t.Errorf("member_left = %q, want %q", m.MemberID, b.member.ID)
	}
	if n, _ := h.Members(); n != 1 {
		t.Errorf("members = %d, want 1", n)
	}
}

func TestHubRoomFull(t *testing.T) {
	cfg := testConfig()
	cfg.MaxMembers = 2
	h, _ := startHub(t, cfg)
	join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	if _, err := h.Join("C", "client-c1"); !errors.Is(err, ErrRoomFull) {
		t.Fatalf("third join: err = %v, want ErrRoomFull", err)
	}
	h.Leave(b)
	join(t, h, "C", "client-c1")
}

func TestHubEndsOpenStrokesOnLeave(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)
	draw(t, a, "s1", line(2, 0.1), false)
	recvType(t, b, TypeStrokeStart)
	recvType(t, b, TypeStrokePoints)

	h.Leave(a)
	h.Leave(a) // second leave is a no-op
	if m := recvType(t, b, TypeStrokeEnd); m.ID != "m1:s1" {
		t.Fatalf("stroke_end = %+v", m)
	}
	recvType(t, b, TypeMemberLeft)
	if c := join(t, h, "C", "client-c1"); !c.snapshot[0].ended {
		t.Error("stroke left open after its author left")
	}
}

func TestHubRejectsInvalidMessages(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	b := join(t, h, "B", "client-b1")
	recvType(t, a, TypeMemberJoined)

	send(t, a, Message{Type: TypeStrokeStart, ID: "s1", Color: "blue", Width: 2})
	if m := recvType(t, a, TypeError); m.Code != "bad_color" {
		t.Fatalf("error code = %q, want bad_color", m.Code)
	}
	a.hub.deliver(context.Background(), inbound{c: a, err: fmt.Errorf("unexpected EOF")})
	if m := recvType(t, a, TypeError); m.Code != "bad_json" {
		t.Fatalf("error code = %q, want bad_json", m.Code)
	}
	send(t, a, Message{Type: TypeStrokeStart, ID: "s1", Color: "#000000", Width: 2})
	send(t, a, Message{Type: TypeStrokeStart, ID: "s1", Color: "#000000", Width: 2})
	if m := recvType(t, a, TypeError); m.Code != "duplicate_stroke" {
		t.Fatalf("error code = %q, want duplicate_stroke", m.Code)
	}
	recvType(t, b, TypeStrokeStart) // only the first start is relayed

	// Points for a stroke that does not exist are ignored silently.
	send(t, a, Message{Type: TypeStrokePoints, ID: "nope", Pts: line(1, 0.1)})
	expectQuiet(t, b, a)
}

func TestHubExpiresWhenEmpty(t *testing.T) {
	cfg := testConfig()
	cfg.EmptyTTL = 50 * time.Millisecond
	h, exited := startHub(t, cfg)
	a := join(t, h, "A", "client-a1")
	h.Leave(a)
	select {
	case <-exited:
	case <-time.After(waitTimeout):
		t.Fatal("empty room did not expire")
	}
	if _, err := h.Join("B", "client-b1"); !errors.Is(err, ErrRoomGone) {
		t.Fatalf("join after expiry: err = %v, want ErrRoomGone", err)
	}
}

func TestHubExpiresIfNobodyJoins(t *testing.T) {
	cfg := testConfig()
	cfg.EmptyTTL = 50 * time.Millisecond
	_, exited := startHub(t, cfg)
	select {
	case <-exited:
	case <-time.After(waitTimeout):
		t.Fatal("unused room did not expire")
	}
}

func TestHubStaysWhileOccupied(t *testing.T) {
	cfg := testConfig()
	cfg.EmptyTTL = 50 * time.Millisecond
	h, exited := startHub(t, cfg)
	join(t, h, "A", "client-a1")
	select {
	case <-exited:
		t.Fatal("occupied room expired")
	case <-time.After(4 * cfg.EmptyTTL):
	}
	if n, err := h.Members(); err != nil || n != 1 {
		t.Fatalf("members = %d, %v; want 1, nil", n, err)
	}
}
