// Command server runs the collaborative drawing service.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"drawing-rooms/internal/room"
	"drawing-rooms/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	web := flag.String("web", "web", "directory with frontend files")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := room.DefaultConfig()
	reg := room.NewRegistry(ctx, cfg)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(reg, cfg, http.Dir(*web)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown", "err", err)
	}
	reg.Wait()
}
