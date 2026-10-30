package room

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
)

var syncedFrame = encode(Message{Type: TypeSynced})

// Client is one WebSocket connection in a room. The hub writes member, seq,
// welcome and snapshot before Join returns and never touches them again;
// closeCode and closeReason are written before done is closed.
type Client struct {
	hub      *Hub
	clientID string
	member   Member
	seq      int

	send chan []byte
	done chan struct{}

	welcome     []byte
	snapshot    []strokeSnap
	closeCode   websocket.StatusCode
	closeReason string
}

// Member returns the participant identity assigned by the hub.
func (c *Client) Member() Member { return c.member }

// Serve pumps messages between conn and the hub until either side closes.
// When the hub removed the client, the close frame carries the hub's code and
// reason; otherwise the connection is dropped.
func (c *Client) Serve(ctx context.Context, conn *websocket.Conn) {
	defer c.hub.Leave(c)
	conn.SetReadLimit(c.hub.cfg.MaxMessageBytes)

	// Reads get their own context: cancelling the context of an in-flight
	// write makes coder/websocket drop the connection without a close frame.
	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		c.readPump(readCtx, conn)
	}()

	c.writePump(ctx, conn, readDone)
	if c.removed() {
		conn.Close(c.closeCode, c.closeReason)
	} else {
		conn.CloseNow()
	}
	cancelRead()
	<-readDone
}

// removed reports whether the hub has dropped the client.
func (c *Client) removed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *Client) readPump(ctx context.Context, conn *websocket.Conn) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		in := inbound{c: c}
		if typ != websocket.MessageText {
			in.err = errors.New("expected a text frame")
		} else if err := json.Unmarshal(data, &in.msg); err != nil {
			in.err = err
		}
		if !c.hub.deliver(ctx, in) {
			return
		}
	}
}

// writePump sends the welcome, the history snapshot and then live messages
// until the hub removes the client, the reader stops, or a write fails.
func (c *Client) writePump(ctx context.Context, conn *websocket.Conn, readDone <-chan struct{}) {
	cfg := c.hub.cfg
	write := func(b []byte) error {
		if c.removed() {
			return errRemoved
		}
		wctx, cancel := context.WithTimeout(ctx, cfg.WriteTimeout)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}

	err := write(c.welcome)
	if err == nil {
		err = writeHistory(c.snapshot, MaxFrameBytes, write)
	}
	c.snapshot = nil
	if err == nil {
		err = write(syncedFrame)
	}
	if err != nil {
		return
	}

	ping := time.NewTicker(cfg.PingInterval)
	defer ping.Stop()
	for {
		select {
		case b := <-c.send:
			if err := write(b); err != nil {
				return
			}
		case <-c.done:
			return
		case <-readDone:
			return
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, cfg.WriteTimeout)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

var errRemoved = errors.New("room: client removed by hub")
