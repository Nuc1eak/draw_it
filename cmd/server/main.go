// Command server runs the collaborative drawing service.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"drawing-rooms/internal/room"
	"drawing-rooms/internal/server"
)

const shutdownTimeout = 10 * time.Second

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	web := flag.String("web", "web", "directory with frontend files")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
	if err := run(ctx, ln, room.DefaultConfig(), http.Dir(*web)); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}

// run serves on ln until ctx is cancelled, then shuts down in an order that
// lets every client get a close frame: stop accepting requests first, so no
// room is created after the hubs stop; then close the rooms; then wait for the
// WebSocket connections, which http.Server.Shutdown does not track.
func run(ctx context.Context, ln net.Listener, cfg room.Config, static http.FileSystem) error {
	hubCtx, closeRooms := context.WithCancel(context.Background())
	defer closeRooms()
	reg := room.NewRegistry(hubCtx, cfg)
	handler := server.New(reg, cfg, static)
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	slog.Info("listening", "addr", ln.Addr().String())

	select {
	case <-ctx.Done():
	case err := <-serveErr:
		return err
	}

	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	closeRooms()
	reg.Wait()
	return handler.WaitConns(shutdownCtx)
}
