# Project
Realtime collaborative drawing rooms. Go backend, WebSocket, vanilla JS + canvas frontend in /web.
@DESIGN.md

# Commands
- Run: go run ./cmd/server
- Test: go test -race ./...
- Test frontend: node --test web/ (logic lives in web/room.js; app.js is DOM glue)
- Lint: go vet ./...

# Conventions
- Standard library net/http for routing; WebSocket via github.com/coder/websocket
- One hub goroutine per room owns room state; no shared mutable state across goroutines without a channel or mutex
- All new code needs tests; always run go test -race before finishing
- Keep dependencies minimal; ask before adding a new one
