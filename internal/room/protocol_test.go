package room

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateInbound(t *testing.T) {
	pos := func(x, y float32) *Point { return &Point{x, y} }
	tests := []struct {
		name string
		msg  Message
		code string // empty means valid
	}{
		{"start", Message{Type: TypeStrokeStart, ID: "s1", Color: "#a0B1c2", Width: 3}, ""},
		{"start bad id", Message{Type: TypeStrokeStart, ID: "s 1", Color: "#000000", Width: 3}, "bad_id"},
		{"start long id", Message{Type: TypeStrokeStart, ID: strings.Repeat("a", 33), Color: "#000000", Width: 3}, "bad_id"},
		{"start bad color", Message{Type: TypeStrokeStart, ID: "s1", Color: "red", Width: 3}, "bad_color"},
		{"start thin", Message{Type: TypeStrokeStart, ID: "s1", Color: "#000000", Width: 0.5}, "bad_width"},
		{"start thick", Message{Type: TypeStrokeStart, ID: "s1", Color: "#000000", Width: 51}, "bad_width"},
		{"points", Message{Type: TypeStrokePoints, ID: "s1", Pts: []Point{{0, 0}, {1, 1}}}, ""},
		{"points empty", Message{Type: TypeStrokePoints, ID: "s1"}, "bad_points"},
		{"points too many", Message{Type: TypeStrokePoints, ID: "s1", Pts: make([]Point, MaxPointsPerMessage+1)}, "bad_points"},
		{"points out of range", Message{Type: TypeStrokePoints, ID: "s1", Pts: []Point{{0.5, 1.01}}}, "bad_points"},
		{"points negative", Message{Type: TypeStrokePoints, ID: "s1", Pts: []Point{{-0.1, 0}}}, "bad_points"},
		{"end", Message{Type: TypeStrokeEnd, ID: "s1"}, ""},
		{"end no id", Message{Type: TypeStrokeEnd}, "bad_id"},
		{"undo", Message{Type: TypeUndo}, ""},
		{"clear", Message{Type: TypeClear}, ""},
		{"cursor", Message{Type: TypeCursor, Pos: pos(0.2, 0.3)}, ""},
		{"cursor no pos", Message{Type: TypeCursor}, "bad_cursor"},
		{"cursor out of range", Message{Type: TypeCursor, Pos: pos(2, 0)}, "bad_cursor"},
		{"server type", Message{Type: TypeWelcome}, "unknown_type"},
		{"unknown", Message{Type: "ping"}, "unknown_type"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateInbound(&tt.msg)
			if tt.code == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var pe *protoError
			if !errors.As(err, &pe) || pe.Code != tt.code {
				t.Fatalf("error = %v, want code %q", err, tt.code)
			}
		})
	}
}

func TestValidateInboundRoundsCoordinates(t *testing.T) {
	m := Message{Type: TypeStrokePoints, ID: "s1", Pts: []Point{{0.123456, 0.987654}}}
	if err := validateInbound(&m); err != nil {
		t.Fatal(err)
	}
	if got, want := m.Pts[0], (Point{0.1235, 0.9877}); got != want {
		t.Errorf("point = %v, want %v", got, want)
	}
	if got := string(encode(Message{Type: TypeStrokePoints, Pts: m.Pts})); !strings.Contains(got, "[0.1235,0.9877]") {
		t.Errorf("encoded = %s, want 4-decimal coordinates", got)
	}
}
