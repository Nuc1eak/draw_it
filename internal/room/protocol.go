package room

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
)

// Message types exchanged over the WebSocket.
const (
	TypeStrokeStart   = "stroke_start"
	TypeStrokePoints  = "stroke_points"
	TypeStrokeEnd     = "stroke_end"
	TypeUndo          = "undo"
	TypeClear         = "clear"
	TypeCursor        = "cursor"
	TypeWelcome       = "welcome"
	TypeHistory       = "history"
	TypeSynced        = "synced"
	TypeMemberJoined  = "member_joined"
	TypeMemberLeft    = "member_left"
	TypeStrokeRemoved = "stroke_removed"
	TypeCleared       = "cleared"
	TypeError         = "error"
)

// Limits on a single inbound message.
const (
	MaxPointsPerMessage = 500
	MinWidth            = 1
	MaxWidth            = 50
)

// Point is a coordinate normalized to [0,1] on both axes.
type Point [2]float32

// Member is the public view of a room participant.
type Member struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Message is the envelope for every client and server message. Which fields
// are set depends on Type.
type Message struct {
	Type     string    `json:"type"`
	ID       string    `json:"id,omitempty"`
	Author   string    `json:"author,omitempty"`
	Color    string    `json:"color,omitempty"`
	Width    float64   `json:"width,omitempty"`
	Pts      []Point   `json:"pts,omitempty"`
	Pos      *Point    `json:"pos,omitempty"`
	MemberID string    `json:"memberId,omitempty"`
	You      *Member   `json:"you,omitempty"`
	Members  []Member  `json:"members,omitempty"`
	IDs      []string  `json:"ids,omitempty"`
	Msgs     []Message `json:"msgs,omitempty"`
	Code     string    `json:"code,omitempty"`
	Text     string    `json:"msg,omitempty"`
}

// protoError is reported back to the sender as an error message; the
// connection stays open.
type protoError struct {
	Code string
	Text string
}

func (e *protoError) Error() string { return e.Code + ": " + e.Text }

func errorMessage(code, text string) Message {
	return Message{Type: TypeError, Code: code, Text: text}
}

var (
	colorRe    = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	strokeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
)

// validateInbound checks a client message and normalizes its coordinates
// to 4 decimal places in place.
func validateInbound(m *Message) error {
	switch m.Type {
	case TypeStrokeStart:
		if err := validateStrokeID(m.ID); err != nil {
			return err
		}
		if !colorRe.MatchString(m.Color) {
			return &protoError{"bad_color", "color must be #rrggbb"}
		}
		if m.Width < MinWidth || m.Width > MaxWidth {
			return &protoError{"bad_width", fmt.Sprintf("width must be in [%d,%d]", MinWidth, MaxWidth)}
		}
	case TypeStrokePoints:
		if err := validateStrokeID(m.ID); err != nil {
			return err
		}
		if len(m.Pts) == 0 || len(m.Pts) > MaxPointsPerMessage {
			return &protoError{"bad_points", fmt.Sprintf("pts must hold 1..%d points", MaxPointsPerMessage)}
		}
		for i := range m.Pts {
			p, ok := normalizePoint(m.Pts[i])
			if !ok {
				return &protoError{"bad_points", "coordinates must be in [0,1]"}
			}
			m.Pts[i] = p
		}
	case TypeStrokeEnd:
		return validateStrokeID(m.ID)
	case TypeUndo, TypeClear:
	case TypeCursor:
		if m.Pos == nil {
			return &protoError{"bad_cursor", "pos is required"}
		}
		p, ok := normalizePoint(*m.Pos)
		if !ok {
			return &protoError{"bad_cursor", "coordinates must be in [0,1]"}
		}
		m.Pos = &p
	default:
		return &protoError{"unknown_type", fmt.Sprintf("unknown message type %q", m.Type)}
	}
	return nil
}

func validateStrokeID(id string) error {
	if !strokeIDRe.MatchString(id) {
		return &protoError{"bad_id", "id must be 1..32 chars of [A-Za-z0-9_-]"}
	}
	return nil
}

func normalizePoint(p Point) (Point, bool) {
	for i, v := range p {
		f := float64(v)
		if math.IsNaN(f) || f < 0 || f > 1 {
			return p, false
		}
		p[i] = float32(math.Round(f*1e4) / 1e4)
	}
	return p, true
}

func encode(m Message) []byte {
	b, err := json.Marshal(m)
	if err != nil {
		// Message holds only plain strings, numbers and slices of them.
		panic(fmt.Sprintf("room: encode %s: %v", m.Type, err))
	}
	return b
}
