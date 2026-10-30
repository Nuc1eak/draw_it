package room

import (
	"bytes"
	"crypto/rand"
	"strings"
	"testing"
)

func TestNewCodeLengthAndAlphabet(t *testing.T) {
	seen := make(map[string]bool)
	for range 1000 {
		code, err := newCode(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != CodeLen {
			t.Fatalf("code %q has length %d, want %d", code, len(code), CodeLen)
		}
		for _, r := range code {
			if !strings.ContainsRune(CodeAlphabet, r) {
				t.Fatalf("code %q contains %q outside the alphabet", code, r)
			}
		}
		if _, ok := NormalizeCode(code); !ok {
			t.Fatalf("generated code %q does not normalize", code)
		}
		seen[code] = true
	}
	if len(seen) < 990 {
		t.Errorf("only %d distinct codes out of 1000", len(seen))
	}
}

func TestNewCodeRejectsBiasedBytes(t *testing.T) {
	// Bytes >= 248 would bias the first 8 letters and must be skipped.
	src := append(bytes.Repeat([]byte{255}, 2*CodeLen), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
	code, err := newCode(bytes.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	if code != "ABCDE" {
		t.Errorf("code = %q, want ABCDE", code)
	}
}

func TestNormalizeCode(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"K7QXM", "K7QXM", true},
		{"k7qxm", "K7QXM", true},
		{" k7qxm ", "K7QXM", true},
		{"K7QX", "", false},
		{"K7QXMM", "", false},
		{"K7QX0", "", false}, // zero is excluded
		{"K7QXO", "", false}, // so is O
		{"K7QX1", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		got, ok := NormalizeCode(tt.in)
		if got != tt.want || ok != tt.ok {
			t.Errorf("NormalizeCode(%q) = %q, %v; want %q, %v", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}
