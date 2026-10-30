package room

import (
	"io"
	"strings"
)

// CodeAlphabet omits characters that are easy to confuse: 0/O, 1/I/L.
const CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// CodeLen is the length of a room code.
const CodeLen = 5

// newCode draws a random room code from r using rejection sampling, so every
// character of the alphabet is equally likely.
func newCode(r io.Reader) (string, error) {
	n := len(CodeAlphabet)
	limit := 256 - 256%n
	out := make([]byte, 0, CodeLen)
	buf := make([]byte, CodeLen*2)
	for len(out) < CodeLen {
		if _, err := io.ReadFull(r, buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if int(b) < limit && len(out) < CodeLen {
				out = append(out, CodeAlphabet[int(b)%n])
			}
		}
	}
	return string(out), nil
}

// NormalizeCode upper-cases s and reports whether it is a well-formed code.
func NormalizeCode(s string) (string, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != CodeLen {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(CodeAlphabet, s[i]) < 0 {
			return "", false
		}
	}
	return s, true
}
