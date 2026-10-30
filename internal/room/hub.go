package room

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"time"

	"github.com/coder/websocket"
)

var (
	// ErrRoomFull is returned by Join when the room is at MaxMembers.
	ErrRoomFull = errors.New("room is full")
	// ErrRoomGone is returned when the hub has already shut down.
	ErrRoomGone = errors.New("room no longer exists")
)

// Config holds the tunable limits of rooms and their connections.
type Config struct {
	MaxRooms        int
	MaxMembers      int
	MaxPoints       int // per room; oldest ended strokes are evicted beyond it
	MaxStrokePoints int // a stroke is ended automatically once it reaches this
	MaxMessageBytes int64
	SendBuffer      int
	EmptyTTL        time.Duration
	WriteTimeout    time.Duration
	PingInterval    time.Duration
}

// DefaultConfig returns the production limits.
func DefaultConfig() Config {
	return Config{
		MaxRooms:        500,
		MaxMembers:      10,
		MaxPoints:       500_000,
		MaxStrokePoints: 50_000,
		MaxMessageBytes: 16 * 1024,
		SendBuffer:      1024,
		EmptyTTL:        time.Minute,
		WriteTimeout:    10 * time.Second,
		PingInterval:    30 * time.Second,
	}
}

type stroke struct {
	id     string
	author string // member ID of the connection that drew it
	owner  string // client ID, used for undo across reconnects
	color  string
	width  float64
	pts    []Point
	ended  bool
}

type joinReq struct {
	c     *Client
	reply chan error
}

type inbound struct {
	c   *Client
	msg Message
	err error // set when the frame could not be decoded
}

// Hub owns all state of one room. Every field below the channels is touched
// only by the run goroutine.
type Hub struct {
	code   string
	cfg    Config
	onExit func()

	join    chan joinReq
	leave   chan *Client
	inbound chan inbound
	count   chan chan int
	done    chan struct{}

	members    map[*Client]struct{}
	nextMember int
	strokes    []*stroke
	byID       map[string]*stroke
	total      int
}

func newHub(code string, cfg Config, onExit func()) *Hub {
	return &Hub{
		code:    code,
		cfg:     cfg,
		onExit:  onExit,
		join:    make(chan joinReq),
		leave:   make(chan *Client),
		inbound: make(chan inbound),
		count:   make(chan chan int),
		done:    make(chan struct{}),
		members: make(map[*Client]struct{}),
		byID:    make(map[string]*stroke),
	}
}

// Code returns the room code.
func (h *Hub) Code() string { return h.code }

// Join adds a participant. On success the returned client holds its welcome
// message and history snapshot and must be served with Client.Serve.
func (h *Hub) Join(name, clientID string) (*Client, error) {
	c := &Client{
		hub:      h,
		clientID: clientID,
		send:     make(chan []byte, h.cfg.SendBuffer),
		done:     make(chan struct{}),
	}
	c.member.Name = name
	req := joinReq{c: c, reply: make(chan error, 1)}
	select {
	case h.join <- req:
	case <-h.done:
		return nil, ErrRoomGone
	}
	if err := <-req.reply; err != nil {
		return nil, err
	}
	return c, nil
}

// Leave removes c from the room. It is safe to call more than once.
func (h *Hub) Leave(c *Client) {
	select {
	case h.leave <- c:
	case <-h.done:
	}
}

// Members reports how many participants are in the room.
func (h *Hub) Members() (int, error) {
	reply := make(chan int, 1)
	select {
	case h.count <- reply:
		return <-reply, nil
	case <-h.done:
		return 0, ErrRoomGone
	}
}

func (h *Hub) deliver(ctx context.Context, in inbound) bool {
	select {
	case h.inbound <- in:
		return true
	case <-h.done:
	case <-in.c.done:
	case <-ctx.Done():
	}
	return false
}

func (h *Hub) run(ctx context.Context) {
	defer close(h.done)
	ttl := time.NewTimer(h.cfg.EmptyTTL)
	defer ttl.Stop()
	for {
		select {
		case req := <-h.join:
			if err := h.handleJoin(req.c); err != nil {
				req.reply <- err
				continue
			}
			ttl.Stop()
			req.reply <- nil
		case c := <-h.leave:
			h.remove(c, websocket.StatusNormalClosure, "")
			if len(h.members) == 0 {
				ttl.Reset(h.cfg.EmptyTTL)
			}
		case in := <-h.inbound:
			if _, ok := h.members[in.c]; ok {
				h.handle(in)
			}
			if len(h.members) == 0 {
				ttl.Reset(h.cfg.EmptyTTL)
			}
		case reply := <-h.count:
			reply <- len(h.members)
		case <-ttl.C:
			if len(h.members) == 0 {
				h.onExit()
				return
			}
		case <-ctx.Done():
			for c := range h.members {
				h.remove(c, websocket.StatusGoingAway, "server shutting down")
			}
			h.onExit()
			return
		}
	}
}

func (h *Hub) handleJoin(c *Client) error {
	if len(h.members) >= h.cfg.MaxMembers {
		return ErrRoomFull
	}
	h.nextMember++
	c.seq = h.nextMember
	c.member.ID = "m" + strconv.Itoa(h.nextMember)
	h.members[c] = struct{}{}

	you := c.member
	c.welcome = encode(Message{Type: TypeWelcome, You: &you, Members: h.memberList()})
	c.snapshot = make([]strokeSnap, len(h.strokes))
	for i, s := range h.strokes {
		c.snapshot[i] = s.snap()
	}
	h.broadcast(Message{Type: TypeMemberJoined, Members: []Member{c.member}}, c)
	return nil
}

func (h *Hub) memberList() []Member {
	cs := make([]*Client, 0, len(h.members))
	for c := range h.members {
		cs = append(cs, c)
	}
	slices.SortFunc(cs, func(a, b *Client) int { return a.seq - b.seq })
	out := make([]Member, len(cs))
	for i, c := range cs {
		out[i] = c.member
	}
	return out
}

// remove drops c from the room, finishing any stroke it left open.
func (h *Hub) remove(c *Client, code websocket.StatusCode, reason string) {
	if _, ok := h.members[c]; !ok {
		return
	}
	delete(h.members, c)
	c.closeCode, c.closeReason = code, reason
	close(c.done)
	for _, s := range h.strokes {
		if s.author == c.member.ID && !s.ended {
			s.ended = true
			h.broadcast(Message{Type: TypeStrokeEnd, ID: s.id, Author: s.author}, nil)
		}
	}
	h.broadcast(Message{Type: TypeMemberLeft, MemberID: c.member.ID}, nil)
}

// broadcast sends m to every member except skip. Members whose buffer is full
// are disconnected; they reconnect and resync from history.
func (h *Hub) broadcast(m Message, skip *Client) {
	data := encode(m)
	var slow []*Client
	for c := range h.members {
		if c == skip {
			continue
		}
		select {
		case c.send <- data:
		default:
			slow = append(slow, c)
		}
	}
	for _, c := range slow {
		h.remove(c, websocket.StatusPolicyViolation, "slow consumer")
	}
}

func (h *Hub) sendTo(c *Client, m Message) {
	select {
	case c.send <- encode(m):
	default:
		h.remove(c, websocket.StatusPolicyViolation, "slow consumer")
	}
}

func (h *Hub) handle(in inbound) {
	c, m := in.c, in.msg
	if in.err != nil {
		h.sendTo(c, errorMessage("bad_json", in.err.Error()))
		return
	}
	if err := validateInbound(&m); err != nil {
		var pe *protoError
		if errors.As(err, &pe) {
			h.sendTo(c, errorMessage(pe.Code, pe.Text))
		}
		return
	}
	switch m.Type {
	case TypeStrokeStart:
		id := c.member.ID + ":" + m.ID
		if _, dup := h.byID[id]; dup {
			h.sendTo(c, errorMessage("duplicate_stroke", "stroke id already used"))
			return
		}
		s := &stroke{id: id, author: c.member.ID, owner: c.clientID, color: m.Color, width: m.Width}
		h.strokes = append(h.strokes, s)
		h.byID[id] = s
		h.broadcast(Message{Type: TypeStrokeStart, ID: id, Author: s.author, Color: s.color, Width: s.width}, c)
	case TypeStrokePoints:
		s := h.byID[c.member.ID+":"+m.ID]
		if s == nil || s.ended {
			return // cleared, undone or evicted while being drawn
		}
		pts := m.Pts[:min(len(m.Pts), h.cfg.MaxStrokePoints-len(s.pts))]
		s.pts = append(s.pts, pts...)
		h.total += len(pts)
		h.broadcast(Message{Type: TypeStrokePoints, ID: s.id, Author: s.author, Pts: pts}, c)
		if len(s.pts) >= h.cfg.MaxStrokePoints {
			s.ended = true
			h.broadcast(Message{Type: TypeStrokeEnd, ID: s.id, Author: s.author}, nil)
		}
		h.evict()
	case TypeStrokeEnd:
		s := h.byID[c.member.ID+":"+m.ID]
		if s == nil || s.ended {
			return
		}
		s.ended = true
		h.broadcast(Message{Type: TypeStrokeEnd, ID: s.id, Author: s.author}, c)
		h.evict()
	case TypeUndo:
		for i := len(h.strokes) - 1; i >= 0; i-- {
			if s := h.strokes[i]; s.owner == c.clientID {
				h.dropStrokes(map[*stroke]bool{s: true})
				h.broadcast(Message{Type: TypeStrokeRemoved, IDs: []string{s.id}}, nil)
				return
			}
		}
	case TypeClear:
		h.strokes = nil
		h.byID = make(map[string]*stroke)
		h.total = 0
		h.broadcast(Message{Type: TypeCleared, MemberID: c.member.ID}, nil)
	case TypeCursor:
		h.broadcast(Message{Type: TypeCursor, MemberID: c.member.ID, Pos: m.Pos}, c)
	}
}

// evict drops the oldest ended strokes until the room is within MaxPoints.
func (h *Hub) evict() {
	excess := h.total - h.cfg.MaxPoints
	if excess <= 0 {
		return
	}
	drop := make(map[*stroke]bool)
	var ids []string
	for _, s := range h.strokes {
		if excess <= 0 {
			break
		}
		if s.ended {
			drop[s] = true
			ids = append(ids, s.id)
			excess -= len(s.pts)
		}
	}
	if len(ids) == 0 {
		return
	}
	h.dropStrokes(drop)
	h.broadcast(Message{Type: TypeStrokeRemoved, IDs: ids}, nil)
}

func (h *Hub) dropStrokes(drop map[*stroke]bool) {
	h.strokes = slices.DeleteFunc(h.strokes, func(s *stroke) bool {
		if !drop[s] {
			return false
		}
		delete(h.byID, s.id)
		h.total -= len(s.pts)
		return true
	})
}
