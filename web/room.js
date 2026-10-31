// Room logic shared by the page (app.js) and its tests: protocol state,
// outgoing stroke messages and the texts the page shows. No DOM access here.

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const STATUS_ROOM_CLOSED = 4000;
export const MAX_POINTS_PER_MSG = 500;
export const WARN_MS = 5 * 60 * 1000;
export const MAX_MEMBERS = 10; // mirrors the server's default capacity
export const MAX_RECENTS = 10;
export const ERASER_COLOR = "#FFFFFF"; // the canvas is white, so erasing is drawing
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 50;
export const DEFAULT_WIDTH = 6;
export const MAX_TEXT_LENGTH = 200; // mirrors MaxTextRunes on the server
export const FILL_TOLERANCE = 40; // per channel, so a fill ignores faint noise
export const PALETTE = [
  { hex: "#1B1B19", name: "Чорний" },
  { hex: "#6B7280", name: "Сірий" },
  { hex: "#E03131", name: "Червоний" },
  { hex: "#F76707", name: "Помаранчевий" },
  { hex: "#F59F00", name: "Жовтий" },
  { hex: "#2F9E44", name: "Зелений" },
  { hex: "#1098AD", name: "Бірюзовий" },
  { hex: "#1971C2", name: "Синій" },
  { hex: "#7048E8", name: "Фіолетовий" },
  { hex: "#D6336C", name: "Рожевий" },
];
export const AVATAR_TINTS = ["#DCE6FF", "#FFDCD4", "#D8F0DE", "#EEDFFA"];

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
// itself failed. Fatal reasons mean retrying will not help; those with a
// screen get a page of their own instead of a line in the lobby.
export function roomProblem(code, status, info) {
  if (!isRoomCode(code)) return { text: "Невірний код кімнати.", fatal: true };
  if (status === null) return { text: "Немає з'єднання з сервером.", fatal: false };
  if (status === 404) return { text: "Кімнату не знайдено.", fatal: true, screen: "not-found" };
  if (status < 200 || status >= 300) return { text: `Помилка ${status}`, fatal: false };
  if (info.members >= info.capacity) {
    return { text: "Кімната заповнена.", fatal: true, screen: "full", members: info.members, capacity: info.capacity };
  }
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

export function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// hexToHsv converts #rrggbb to hue in [0,360) and saturation and brightness
// in [0,1].
export function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta + 6) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: h * 60, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }) {
  const channel = (n) => {
    const k = (n + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

// textSize is the font size of a text in units of the 1000-wide canvas.
export function textSize(width) {
  return 12 + width * 2;
}

// floodFill paints the region connected to pixel (x,y) of opaque RGBA data
// with color and reports whether anything changed. The region ends at pixels
// that differ from the start pixel by more than FILL_TOLERANCE and at the edge
// of the image. It then grows by one pixel to cover the antialiased rim of the
// lines around it, which would otherwise stay as a pale halo.
export function floodFill(data, w, h, x, y, color) {
  const start = (y * w + x) * 4;
  const seed = [data[start], data[start + 1], data[start + 2]];
  if (seed.every((c, i) => c === color[i])) return false;

  const same = (p) => {
    const i = p * 4;
    return Math.abs(data[i] - seed[0]) <= FILL_TOLERANCE
      && Math.abs(data[i + 1] - seed[1]) <= FILL_TOLERANCE
      && Math.abs(data[i + 2] - seed[2]) <= FILL_TOLERANCE;
  };
  const region = new Uint8Array(w * h);
  const stack = new Int32Array(w * h); // each pixel is pushed at most once
  let top = 0;
  const visit = (p) => {
    if (!region[p] && same(p)) {
      region[p] = 1;
      stack[top++] = p;
    }
  };
  visit(y * w + x);
  while (top > 0) {
    const p = stack[--top];
    const col = p % w;
    if (col > 0) visit(p - 1);
    if (col < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }

  const paint = (p) => {
    const i = p * 4;
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  };
  for (let p = 0; p < region.length; p++) {
    if (!region[p]) continue;
    const col = p % w;
    paint(p);
    if (col > 0) paint(p - 1);
    if (col < w - 1) paint(p + 1);
    if (p >= w) paint(p - w);
    if (p < w * (h - 1)) paint(p + w);
  }
  return true;
}

// pushRecent puts color first, without duplicates, keeping MAX_RECENTS.
export function pushRecent(recents, color) {
  return [color, ...recents.filter((c) => c !== color)].slice(0, MAX_RECENTS);
}

function hashOf(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash;
}

// The server assigns no colors, so each member gets stable ones from the ID.
export function memberColor(id) {
  return PALETTE[hashOf(id) % PALETTE.length].hex;
}

export function memberTint(id) {
  return AVATAR_TINTS[hashOf(id) % AVATAR_TINTS.length];
}

export function initial(name) {
  return [...name.trim()][0]?.toLocaleUpperCase("uk") ?? "?";
}

// Brush is the tool the user draws with. hsv is kept apart from color because
// a gray or black hex has lost its hue, and the picker must not jump.
export class Brush {
  constructor() {
    this.color = PALETTE[7].hex;
    this.hsv = hexToHsv(this.color);
    this.width = DEFAULT_WIDTH;
    this.tool = "brush"; // brush, fill or text
    this.eraser = false;
    this.recents = [];
  }

  get strokeColor() {
    return this.eraser ? ERASER_COLOR : this.color;
  }

  // pick selects a ready-made color: a default or a recent one.
  pick(hex) {
    const hsv = hexToHsv(hex);
    if (hsv.s === 0 || hsv.v === 0) hsv.h = this.hsv.h;
    this.hsv = hsv;
    this.color = hex;
    this.eraser = false;
  }

  setHsv(part) {
    Object.assign(this.hsv, part);
    this.color = hsvToHex(this.hsv);
    this.eraser = false;
  }

  // markUsed records the pen color once a stroke is drawn with it.
  markUsed() {
    if (!this.eraser) this.recents = pushRecent(this.recents, this.color);
  }

  setWidth(width) {
    this.width = width;
  }

  setTool(tool) {
    this.tool = tool;
    this.eraser = false;
  }

  // The eraser is a white brush, so it always leaves fill and text.
  toggleEraser() {
    this.eraser = !this.eraser;
    if (this.eraser) this.tool = "brush";
  }
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
    // id -> {color, width, pts}, in drawing order; fills and texts also have
    // a kind, texts their text, and pts holds just their position.
    this.strokes = new Map();
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
      case "fill":
      case "text":
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
    if (msg.type === "fill" || msg.type === "text") {
      const s = { kind: msg.type, color: msg.color, width: msg.width, text: msg.text, pts: [msg.pos] };
      this.strokes.set(msg.id, s);
      fx.draws.push({ stroke: s, from: 0 });
    } else if (msg.type === "stroke_start") {
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

  // startFill and addText make an own fill or text at point p. Like
  // startStroke they return the messages to send and what to draw, or null
  // before the welcome.
  startFill(p, color) {
    return this.#shape({ type: "fill", pos: p, color });
  }

  addText(p, text, color, width) {
    return this.#shape({ type: "text", pos: p, color, width, text });
  }

  #shape(msg) {
    if (!this.me) return null;
    const localId = `s${++this.seq}`;
    const { type: kind, pos, ...rest } = msg;
    const stroke = { kind, ...rest, pts: [pos] };
    this.strokes.set(`${this.me.id}:${localId}`, stroke);
    return { msgs: [{ ...msg, id: localId }], stroke };
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
