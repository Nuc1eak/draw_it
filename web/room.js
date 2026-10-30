// Room logic shared by the page (app.js) and its tests: protocol state,
// outgoing stroke messages and the texts the page shows. No DOM access here.

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const STATUS_ROOM_CLOSED = 4000;
export const MAX_POINTS_PER_MSG = 500;
export const WARN_MS = 5 * 60 * 1000;

// randomId makes a client ID. crypto.randomUUID exists only in secure
// contexts (HTTPS or localhost), so plain HTTP on a LAN address needs the
// fallback.
export function randomId(c = globalThis.crypto) {
  if (c.randomUUID) return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isRoomCode(code) {
  return code.length === 5 && [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

// roomProblem turns the result of GET /api/rooms/{code} into a user-facing
// reason the room cannot be joined, or null. status is null when the request
// itself failed. Fatal reasons mean retrying will not help.
export function roomProblem(code, status, info) {
  if (!isRoomCode(code)) return { text: "Невірний код кімнати.", fatal: true };
  if (status === null) return { text: "Немає з'єднання з сервером.", fatal: false };
  if (status === 404) return { text: "Кімнату не знайдено.", fatal: true };
  if (status < 200 || status >= 300) return { text: `Помилка ${status}`, fatal: false };
  if (info.members >= info.capacity) return { text: "Кімната заповнена.", fatal: true };
  return null;
}

export const CLOSE_REASONS = {
  creator_left: "Творець закрив кімнату.",
  creator_gone: "Творець не повертався 5 хвилин, тому кімнату закрито.",
  expired: "Минула година з моменту створення, тому кімнату закрито.",
};

// closeOutcome says what the page shows when the server closes the room:
// the creator who closed it goes back to the lobby, everyone else keeps the
// canvas with an explanation.
export function closeOutcome(reason, isCreator) {
  if (reason === "creator_left" && isCreator) return { lobby: true };
  return { lobby: false, text: CLOSE_REASONS[reason] ?? "Кімнату закрито." };
}

export function leaveLabel({ closed, creator }) {
  if (closed) return "До лобі";
  return creator ? "Закрити кімнату" : "Вийти";
}

// countdownText is shown during the last WARN_MS of a room's lifetime.
export function countdownText(leftMs) {
  if (leftMs > WARN_MS) return null;
  const secs = Math.max(0, Math.ceil(leftMs / 1000));
  return `Кімната закриється через ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

// normalizePoint maps a pointer position to [0,1] on both axes, rounded to
// the 4 decimals the server stores.
export function normalizePoint(x, y, rect) {
  const norm = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
  return [norm((x - rect.left) / rect.width), norm((y - rect.top) / rect.height)];
}

// Room mirrors the server's room state for one connection and builds the
// messages for the user's own strokes.
export class Room {
  constructor() {
    this.seq = 0; // kept across reconnects; stroke IDs also carry the member ID
    this.reset();
  }

  reset() {
    this.me = null;
    this.members = new Map(); // id -> {id, name, creator}
    this.strokes = new Map(); // id -> {color, width, pts}, in drawing order
    this.current = null; // own stroke being drawn: {id, localId, pending}
    this.expiresAt = 0;
  }

  // apply updates the state from one server message; now is the current
  // time in ms on the clock countdown() is later called with. It returns what
  // the page has to update.
  apply(msg, now) {
    const fx = {
      redraw: false,
      draws: [], // {stroke, from}: draw stroke.pts from index from onwards
      members: false,
      resetCursors: false,
      cursor: null,
      cursorGone: null,
      status: undefined,
      error: null,
    };
    switch (msg.type) {
      case "welcome":
        this.reset();
        this.me = msg.you;
        this.members = new Map(msg.members.map((m) => [m.id, m]));
        this.expiresAt = now + msg.expiresIn;
        Object.assign(fx, { redraw: true, members: true, resetCursors: true, status: "Синхронізація…" });
        break;
      case "history":
        for (const m of msg.msgs) this.#applyStroke(m, fx);
        break;
      case "synced":
        fx.status = "";
        break;
      case "stroke_start":
      case "stroke_points":
      case "stroke_end":
        this.#applyStroke(msg, fx);
        break;
      case "stroke_removed":
        for (const id of msg.ids) this.strokes.delete(id);
        if (this.current && msg.ids.includes(this.current.id)) this.current = null;
        fx.redraw = true;
        break;
      case "cleared":
        this.strokes.clear();
        this.current = null;
        fx.redraw = true;
        break;
      case "member_joined":
        for (const m of msg.members) this.members.set(m.id, m);
        fx.members = true;
        break;
      case "member_left":
        this.members.delete(msg.memberId);
        fx.members = true;
        fx.cursorGone = msg.memberId;
        break;
      case "cursor":
        fx.cursor = { id: msg.memberId, pos: msg.pos, name: this.members.get(msg.memberId)?.name ?? "?" };
        break;
      case "error":
        fx.error = `Помилка: ${msg.msg}`;
        break;
    }
    return fx;
  }

  #applyStroke(msg, fx) {
    if (msg.type === "stroke_start") {
      this.strokes.set(msg.id, { color: msg.color, width: msg.width, pts: [] });
    } else if (msg.type === "stroke_points") {
      const s = this.strokes.get(msg.id);
      if (!s) return; // removed or cleared meanwhile
      fx.draws.push({ stroke: s, from: s.pts.length });
      s.pts.push(...msg.pts);
    } else if (msg.type === "stroke_end" && this.current?.id === msg.id) {
      // The server ended our stroke at its length limit and ignores further
      // points, so stop sending them.
      this.current = null;
    }
  }

  // startStroke begins an own stroke at point p. It returns the messages to
  // send and the stroke to draw, or null before the welcome.
  startStroke(p, color, width) {
    if (!this.me) return null;
    const localId = `s${++this.seq}`;
    const id = `${this.me.id}:${localId}`;
    const stroke = { color, width, pts: [p] };
    this.strokes.set(id, stroke);
    this.current = { id, localId, pending: [p] };
    return { msgs: [{ type: "stroke_start", id: localId, color, width }], stroke };
  }

  // addPoint extends the own stroke; it returns what to draw, or null when no
  // own stroke is in progress.
  addPoint(p) {
    const cur = this.current;
    const stroke = cur && this.strokes.get(cur.id);
    if (!stroke) return null;
    const from = stroke.pts.length;
    stroke.pts.push(p);
    cur.pending.push(p);
    return { stroke, from };
  }

  // flush returns the pending points as stroke_points messages the server
  // accepts (at most MAX_POINTS_PER_MSG each).
  flush() {
    const cur = this.current;
    if (!cur) return [];
    const msgs = [];
    while (cur.pending.length) {
      msgs.push({ type: "stroke_points", id: cur.localId, pts: cur.pending.splice(0, MAX_POINTS_PER_MSG) });
    }
    return msgs;
  }

  endStroke() {
    if (!this.current) return [];
    const msgs = [...this.flush(), { type: "stroke_end", id: this.current.localId }];
    this.current = null;
    return msgs;
  }

  countdown(now) {
    return this.me ? countdownText(this.expiresAt - now) : null;
  }
}
