package room

import (
	"encoding/json"
	"math/rand/v2"
	"slices"
	"testing"
)

// replay decodes history frames back into strokes, checking each frame's size.
func replay(t *testing.T, frames [][]byte, maxBytes int) []strokeSnap {
	t.Helper()
	var out []strokeSnap
	idx := make(map[string]int)
	for i, f := range frames {
		if len(f) > maxBytes {
			t.Fatalf("frame %d is %d bytes, limit %d", i, len(f), maxBytes)
		}
		var m Message
		if err := json.Unmarshal(f, &m); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if m.Type != TypeHistory || len(m.Msgs) == 0 {
			t.Fatalf("frame %d: type %q with %d msgs", i, m.Type, len(m.Msgs))
		}
		for _, sm := range m.Msgs {
			switch sm.Type {
			case TypeStrokeStart:
				idx[sm.ID] = len(out)
				out = append(out, strokeSnap{id: sm.ID, author: sm.Author, color: sm.Color, width: sm.Width})
			case TypeStrokePoints:
				if len(sm.Pts) > historyPointsPerMsg {
					t.Fatalf("stroke_points with %d points, want at most %d", len(sm.Pts), historyPointsPerMsg)
				}
				out[idx[sm.ID]].pts = append(out[idx[sm.ID]].pts, sm.Pts...)
			case TypeStrokeEnd:
				out[idx[sm.ID]].ended = true
			default:
				t.Fatalf("unexpected %q in history", sm.Type)
			}
		}
	}
	return out
}

func collect(t *testing.T, snap []strokeSnap, maxBytes int) [][]byte {
	t.Helper()
	var frames [][]byte
	err := writeHistory(snap, maxBytes, func(b []byte) error {
		frames = append(frames, b)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return frames
}

func equalSnaps(a, b []strokeSnap) bool {
	return slices.EqualFunc(a, b, func(x, y strokeSnap) bool {
		return x.id == y.id && x.author == y.author && x.color == y.color &&
			x.width == y.width && x.ended == y.ended && slices.Equal(x.pts, y.pts)
	})
}

// randomPoints returns 4-decimal points, the widest encoding the hub stores.
func randomPoints(r *rand.Rand, n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		x, _ := normalizePoint(Point{float32(r.IntN(9000)+1000) / 1e4, float32(r.IntN(9000)+1000) / 1e4})
		pts[i] = x
	}
	return pts
}

func TestWriteHistoryRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	snap := []strokeSnap{
		{id: "m1:a", author: "m1", color: "#ff0000", width: 3, pts: randomPoints(r, 10), ended: true},
		{id: "m1:empty", author: "m1", color: "#00ff00", width: 1, ended: true},
		{id: "m2:long", author: "m2", color: "#0000ff", width: 50, pts: randomPoints(r, 50_000), ended: true},
		{id: "m3:open", author: "m3", color: "#123456", width: 7.5, pts: randomPoints(r, 1234)},
	}
	frames := collect(t, snap, MaxFrameBytes)
	got := replay(t, frames, MaxFrameBytes)
	if !equalSnaps(got, snap) {
		t.Fatal("replayed history differs from the snapshot")
	}
	if got[3].ended {
		t.Error("stroke in progress was replayed with stroke_end")
	}
	if len(frames) < 2 {
		t.Errorf("50k points fit in %d frame(s); expected the stroke to be split", len(frames))
	}
}

func TestWriteHistoryFullRoomFitsFrameLimit(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	cfg := DefaultConfig()
	var snap []strokeSnap
	for i := range cfg.MaxPoints / cfg.MaxStrokePoints {
		snap = append(snap, strokeSnap{
			id: "m10:stroke-" + string(rune('a'+i)), author: "m10", color: "#abcdef", width: 12.25,
			pts: randomPoints(r, cfg.MaxStrokePoints), ended: true,
		})
	}
	frames := collect(t, snap, MaxFrameBytes)
	got := replay(t, frames, MaxFrameBytes)
	points := 0
	for _, s := range got {
		points += len(s.pts)
	}
	if points != cfg.MaxPoints {
		t.Fatalf("replayed %d points, want %d", points, cfg.MaxPoints)
	}
	t.Logf("%d points in %d frames", points, len(frames))
}

func TestWriteHistoryEmpty(t *testing.T) {
	if frames := collect(t, nil, MaxFrameBytes); len(frames) != 0 {
		t.Fatalf("empty history produced %d frames", len(frames))
	}
}

func TestWriteHistoryRejectsTinyLimit(t *testing.T) {
	snap := []strokeSnap{{id: "m1:a", author: "m1", color: "#000000", width: 1}}
	if err := writeHistory(snap, 40, func([]byte) error { return nil }); err == nil {
		t.Fatal("a message larger than the frame limit was accepted")
	}
}

// TestSnapshotUnaffectedByLaterChanges streams a snapshot while the hub keeps
// appending, undoing and clearing. Run with -race.
func TestSnapshotUnaffectedByLaterChanges(t *testing.T) {
	h, _ := startHub(t, testConfig())
	a := join(t, h, "A", "client-a1")
	draw(t, a, "done", line(700, 0.1), true)
	draw(t, a, "open", line(300, 0.2), false)

	c := join(t, h, "C", "client-c1")
	want := []strokeSnap{
		{id: "m1:done", author: "m1", color: "#112233", width: 4, pts: line(700, 0.1), ended: true},
		{id: "m1:open", author: "m1", color: "#112233", width: 4, pts: line(300, 0.2)},
	}

	framesCh := make(chan [][]byte)
	go func() {
		var frames [][]byte
		writeHistory(c.snapshot, MaxFrameBytes, func(b []byte) error {
			frames = append(frames, b)
			return nil
		})
		framesCh <- frames
	}()

	send(t, a, Message{Type: TypeStrokePoints, ID: "open", Pts: line(400, 0.3)})
	send(t, a, Message{Type: TypeStrokeEnd, ID: "open"})
	send(t, a, Message{Type: TypeUndo})
	draw(t, a, "new", line(50, 0.4), true)
	send(t, a, Message{Type: TypeClear})

	if got := replay(t, <-framesCh, MaxFrameBytes); !equalSnaps(got, want) {
		t.Fatal("snapshot changed after the hub moved on")
	}
}
