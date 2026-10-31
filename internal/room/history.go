package room

import (
	"bytes"
	"fmt"
)

// MaxFrameBytes caps every outbound frame. It equals the default read limit
// of github.com/coder/websocket, so clients work without raising it.
const MaxFrameBytes = 32 * 1024

// historyPointsPerMsg is how many points one replayed stroke_points carries.
// At ~16 bytes per point a message stays well under MaxFrameBytes.
const historyPointsPerMsg = 500

// strokeSnap is an immutable view of a stroke taken by the hub at join time.
// pts shares its backing array with the live stroke: the hub only appends
// past len(pts), so the elements seen here never change.
type strokeSnap struct {
	id, author, kind, color, text string
	width                         float64
	pts                           []Point
	ended                         bool
}

func (s *stroke) snap() strokeSnap {
	return strokeSnap{
		id:     s.id,
		author: s.author,
		kind:   s.kind,
		color:  s.color,
		text:   s.text,
		width:  s.width,
		pts:    s.pts[:len(s.pts):len(s.pts)],
		ended:  s.ended,
	}
}

// shapeMessage is the single message that carries a fill or a text.
func (s strokeSnap) shapeMessage() Message {
	return Message{Type: s.kind, ID: s.id, Author: s.author, Color: s.color, Width: s.width, Content: s.text, Pos: &s.pts[0]}
}

var (
	historyPrefix = []byte(`{"type":"history","msgs":[`)
	historySuffix = []byte(`]}`)
)

// writeHistory replays snap as the same stroke_start / stroke_points /
// stroke_end messages a live client would see, packed into history frames of
// at most maxBytes each. emit is called once per frame, in order.
func writeHistory(snap []strokeSnap, maxBytes int, emit func([]byte) error) error {
	var buf bytes.Buffer
	n := 0
	flush := func() error {
		if n == 0 {
			return nil
		}
		buf.Write(historySuffix)
		err := emit(bytes.Clone(buf.Bytes()))
		buf.Reset()
		n = 0
		return err
	}
	add := func(m Message) error {
		b := encode(m)
		overhead := len(historyPrefix) + len(historySuffix)
		if overhead+len(b) > maxBytes {
			return fmt.Errorf("room: %s message of %d bytes exceeds frame limit %d", m.Type, len(b), maxBytes)
		}
		if n > 0 && buf.Len()+1+len(b)+len(historySuffix) > maxBytes {
			if err := flush(); err != nil {
				return err
			}
		}
		if n == 0 {
			buf.Write(historyPrefix)
		} else {
			buf.WriteByte(',')
		}
		buf.Write(b)
		n++
		return nil
	}

	for _, s := range snap {
		if s.kind != "" {
			if err := add(s.shapeMessage()); err != nil {
				return err
			}
			continue
		}
		start := Message{Type: TypeStrokeStart, ID: s.id, Author: s.author, Color: s.color, Width: s.width}
		if err := add(start); err != nil {
			return err
		}
		for i := 0; i < len(s.pts); i += historyPointsPerMsg {
			j := min(i+historyPointsPerMsg, len(s.pts))
			if err := add(Message{Type: TypeStrokePoints, ID: s.id, Author: s.author, Pts: s.pts[i:j]}); err != nil {
				return err
			}
		}
		if s.ended {
			if err := add(Message{Type: TypeStrokeEnd, ID: s.id, Author: s.author}); err != nil {
				return err
			}
		}
	}
	return flush()
}
