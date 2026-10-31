import {
  Brush,
  CARD_BORDERS,
  LAYOUT_GAP,
  MAX_MEMBERS,
  MAX_RECENTS,
  MAX_TEXT_LENGTH,
  MAX_WIDTH,
  MIN_WIDTH,
  ERASER_COLOR,
  PALETTE,
  Room,
  STATUS_ROOM_CLOSED,
  closeOutcome,
  floodFill,
  hexToRgb,
  hsvToHex,
  initial,
  isRoomCode,
  leaveLabel,
  memberColor,
  memberTint,
  normalizePoint,
  randomId,
  roomProblem,
  textSize,
  toolbarLayout,
} from "./room.js";

// The canvas has one fixed resolution for everyone, so normalized coordinates
// mean the same thing on every screen and a fill covers the same pixels;
// CSS only scales it. Line widths are relative to a 1000px-wide canvas.
const CANVAS_W = 2000;
const CANVAS_H = 1250;
const ASPECT = CANVAS_W / CANVAS_H;
const REF_WIDTH = 1000;
const TEXT_LINE_HEIGHT = 1.2; // keep in sync with .text-entry in style.css
const FLUSH_MS = 30;
const CURSOR_MS = 50;

const $ = (sel) => document.querySelector(sel);
const canvas = $("#canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true }); // fills read pixels
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

const room = new Room();
const brush = new Brush();
const state = {
  code: null,
  ws: null,
  target: null, // the code being joined, kept for "try again"
  attempt: 0, // bumped to abandon a join still waiting for the server
  leaving: false,
  welcomed: false,
  closed: false, // the room was closed; the canvas stays for viewing
  backoff: 500,
  cursors: new Map(), // member id -> {el, label, timer}
  lastCursor: 0,
};

const clientId = (() => {
  let id = load("clientId");
  if (!id) {
    id = randomId();
    save("clientId", id);
  }
  return id;
})();

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------- lobby ----------

$("#name").value = load("name") || "";

const SCREENS = ["lobby", "connecting", "not-found", "full", "room"];

function showScreen(name) {
  for (const id of SCREENS) $(`#${id}`).hidden = id !== name;
  if (name === "room") resize();
}

function showLobby(error = "") {
  state.code = null;
  showScreen("lobby");
  $("#lobby-error").textContent = error;
  history.replaceState(null, "", location.pathname);
}

function showConnecting(code) {
  state.target = code;
  for (const el of document.querySelectorAll(".room-ref")) el.textContent = code;
  showScreen("connecting");
}

function showProblem(problem) {
  if (!problem.screen) {
    showLobby(problem.text);
    return;
  }
  state.code = null;
  if (problem.screen === "full") {
    $("#full-count").textContent = `${problem.members} з ${problem.capacity}`;
    $("#seats").replaceChildren(...Array.from({ length: problem.capacity }, () => document.createElement("span")));
  }
  showScreen(problem.screen);
  $(`#${problem.screen} .primary`).focus();
}

async function createRoom() {
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    if (!res.ok) throw new Error(res.status === 503 ? "Сервер перевантажений, спробуйте пізніше." : `Помилка ${res.status}`);
    const { code } = await res.json();
    enterRoom(code);
  } catch (err) {
    showLobby(err.message);
  }
}

// joinRoom opens an existing room, unless the server says it cannot be joined.
async function joinRoom(code) {
  const attempt = ++state.attempt;
  showConnecting(code);
  const problem = await checkRoom(code);
  if (attempt !== state.attempt) return; // cancelled meanwhile
  if (problem) showProblem(problem);
  else enterRoom(code);
}

$("#create").addEventListener("click", createRoom);
for (const el of document.querySelectorAll(".create-new")) el.addEventListener("click", createRoom);

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  joinRoom($("#code").value.trim().toUpperCase());
});

$("#other-code").addEventListener("click", () => {
  showLobby();
  $("#code").select();
  $("#code").focus();
});

$("#retry").addEventListener("click", () => joinRoom(state.target));

async function checkRoom(code) {
  if (!isRoomCode(code)) return roomProblem(code, null, null);
  try {
    const res = await fetch(`/api/rooms/${code}`);
    return roomProblem(code, res.status, res.ok ? await res.json() : null);
  } catch {
    return roomProblem(code, null, null);
  }
}

function enterRoom(code) {
  save("name", $("#name").value.trim());
  state.code = code;
  state.leaving = false;
  state.backoff = 500;
  room.reset();
  setClosed(false);
  history.replaceState(null, "", `#${code}`);
  $("#room-code").textContent = code;
  showConnecting(code);
  connect();
}

$("#leave").addEventListener("click", () => {
  if (room.me?.creator && !state.closed && state.ws?.readyState === WebSocket.OPEN) {
    // The server answers by closing every connection, ours included.
    if (confirm("Закрити кімнату для всіх учасників?")) send({ type: "close_room" });
    return;
  }
  leaveToLobby();
});

$("#cancel").addEventListener("click", leaveToLobby);

function leaveToLobby() {
  state.attempt++;
  state.leaving = true;
  state.ws?.close(1000);
  showLobby();
}

function roomClosed(reason) {
  const outcome = closeOutcome(reason, room.me?.creator ?? false);
  if (outcome.lobby) {
    showLobby();
    return;
  }
  setClosed(true);
  showScreen("room");
  $("#closed-text").textContent = outcome.text;
}

// setClosed switches between drawing and viewing a closed room's canvas.
function setClosed(closed) {
  state.closed = closed;
  room.current = null;
  $("#closed").hidden = !closed;
  for (const el of document.querySelectorAll(".tool-group")) el.inert = closed;
  if (closed) {
    closeText();
    for (const id of [...state.cursors.keys()]) removeCursor(id);
    setStatus("");
  }
  updateLeaveButton();
}

function updateLeaveButton() {
  const label = leaveLabel({ closed: state.closed, creator: room.me?.creator ?? false });
  $("#leave").setAttribute("aria-label", label);
  $("#leave").title = label;
}

$("#save").addEventListener("click", () => {
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `room-${$("#room-code").textContent}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
});

$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Посилання скопійовано");
  } catch {
    toast(`Код кімнати: ${state.code}`);
  }
});

// ---------- connection ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ name: $("#name").value.trim(), clientId });
  const ws = new WebSocket(`${proto}//${location.host}/ws/${state.code}?${params}`);
  state.ws = ws;
  state.welcomed = false;
  setStatus("Підключення…");

  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = async (e) => {
    if (state.ws !== ws || state.leaving) return;
    room.current = null;
    if (e.code === STATUS_ROOM_CLOSED) {
      roomClosed(e.reason);
      return;
    }
    // The browser hides the HTTP status of a failed upgrade, so ask why.
    if (!state.welcomed) {
      const problem = await checkRoom(state.code);
      if (state.ws !== ws || state.leaving) return; // cancelled meanwhile
      if (problem?.fatal) {
        showProblem(problem);
        return;
      }
    }
    setStatus("З'єднання втрачено, перепідключення…");
    setTimeout(() => { if (state.ws === ws && !state.leaving) connect(); }, state.backoff);
    state.backoff = Math.min(state.backoff * 2, 8000);
  };
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function sendAll(msgs) {
  for (const m of msgs) send(m);
}

function handle(msg) {
  if (msg.type === "welcome") {
    state.welcomed = true;
    state.backoff = 500;
  }
  const fx = room.apply(msg, performance.now());
  if (fx.resetCursors) for (const id of [...state.cursors.keys()]) removeCursor(id);
  if (fx.cursorGone) removeCursor(fx.cursorGone);
  if (fx.members) {
    renderMembers();
    updateLeaveButton();
  }
  if (fx.redraw) redraw();
  else for (const d of fx.draws) drawFrom(d.stroke, d.from);
  if (fx.cursor) moveCursor(fx.cursor);
  if (fx.status !== undefined) setStatus(fx.status);
  if (msg.type === "synced") showScreen("room");
  if (fx.error) toast(fx.error);
}

// ---------- drawing ----------

function drawFrom(s, from) {
  if (s.kind === "fill") {
    drawFill(s);
    return;
  }
  if (s.kind === "text") {
    drawText(s);
    return;
  }
  for (let i = from; i < s.pts.length; i++) drawSegment(s, s.pts[i - 1] ?? s.pts[i], s.pts[i]);
}

function drawSegment(s, a, b) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = (s.width * w) / REF_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (a === b) {
    ctx.beginPath();
    ctx.arc(a[0] * w, a[1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(a[0] * w, a[1] * h);
  ctx.lineTo(b[0] * w, b[1] * h);
  ctx.stroke();
}

function drawFill(s) {
  const [x, y] = s.pts[0];
  const col = Math.min(Math.floor(x * CANVAS_W), CANVAS_W - 1);
  const row = Math.min(Math.floor(y * CANVAS_H), CANVAS_H - 1);
  const image = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  if (floodFill(image.data, CANVAS_W, CANVAS_H, col, row, hexToRgb(s.color))) ctx.putImageData(image, 0, 0);
}

function drawText(s) {
  const size = (textSize(s.width) * CANVAS_W) / REF_WIDTH;
  ctx.fillStyle = s.color;
  ctx.font = `500 ${size}px Manrope, system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  // The same baseline as in the editor, so the text stays put when committed.
  const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = ctx.measureText(s.text);
  const baseline = (TEXT_LINE_HEIGHT * size - ascent - descent) / 2 + ascent;
  ctx.fillText(s.text, s.pts[0][0] * CANVAS_W, s.pts[0][1] * CANVAS_H + baseline);
}

function redraw() {
  ctx.fillStyle = ERASER_COLOR;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  for (const s of room.strokes.values()) drawFrom(s, 0);
}

function resize() {
  // The card hugs the canvas, so the space to fit into is the workspace's.
  const space = $(".workspace");
  if (!space.clientWidth) return; // the room is hidden
  const stacked = getComputedStyle($(".workspace-row")).flexDirection === "column";
  const toolbar = $("#toolbar").style;
  let w = space.clientWidth - CARD_BORDERS;
  let h = Math.floor(w / ASPECT);
  if (!stacked) {
    const layout = toolbarLayout(space.clientWidth, space.clientHeight);
    w = layout.canvasW;
    h = layout.canvasH;
    toolbar.setProperty("--toolbar-w", `${layout.toolbarW}px`);
    toolbar.setProperty("--ui", layout.scale);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

// The space also changes when the toolbar wraps or the closed banner appears.
new ResizeObserver(resize).observe($(".workspace"));

const pointOf = (e) => normalizePoint(e.clientX, e.clientY, canvas.getBoundingClientRect());

const canDraw = () => !state.closed && state.ws?.readyState === WebSocket.OPEN;

// placed finishes a fill or text: it is whole from the start, unlike a stroke.
function placed(made) {
  if (!made) return;
  sendAll(made.msgs);
  drawFrom(made.stroke, 0);
  brush.markUsed();
  renderBrush();
}

canvas.addEventListener("pointerdown", (e) => {
  if (!canDraw() || e.button !== 0) return;
  if (brush.tool === "text") return; // the click that follows opens the editor
  if (brush.tool === "fill") {
    placed(room.startFill(pointOf(e), brush.color));
    return;
  }
  const started = room.startStroke(pointOf(e), brush.strokeColor, brush.width);
  if (!started) return;
  canvas.setPointerCapture(e.pointerId);
  brush.markUsed();
  renderBrush();
  sendAll(started.msgs);
  drawFrom(started.stroke, 0);
});

canvas.addEventListener("pointermove", (e) => {
  const p = pointOf(e);
  const now = performance.now();
  if (now - state.lastCursor > CURSOR_MS) {
    state.lastCursor = now;
    send({ type: "cursor", pos: p });
  }
  const added = room.addPoint(p);
  if (added) drawFrom(added.stroke, added.from);
});

// ---------- text ----------

const textInput = $("#text-input");
textInput.maxLength = MAX_TEXT_LENGTH;
let textDraft = null; // {pos, color, width} while the editor is open

// A click, not pointerdown: an open editor must first lose focus and commit.
canvas.addEventListener("click", (e) => {
  if (brush.tool !== "text" || !canDraw()) return;
  const pos = pointOf(e);
  textDraft = { pos, color: brush.color, width: brush.width };
  textInput.value = "";
  textInput.style.left = `${pos[0] * 100}%`;
  textInput.style.top = `${pos[1] * 100}%`;
  textInput.style.color = textDraft.color;
  textInput.style.fontSize = `${(textSize(textDraft.width) * canvas.clientWidth) / REF_WIDTH}px`;
  textInput.hidden = false;
  textInput.focus();
});

function closeText() {
  textDraft = null;
  textInput.hidden = true;
}

function commitText() {
  if (!textDraft) return;
  const { pos, color, width } = textDraft;
  const text = textInput.value.trim();
  closeText();
  if (text && canDraw()) placed(room.addText(pos, text, color, width));
}

textInput.addEventListener("blur", commitText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitText();
  if (e.key === "Escape") closeText();
});

const endStroke = () => sendAll(room.endStroke());
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

setInterval(() => sendAll(room.flush()), FLUSH_MS);

$("#undo").addEventListener("click", () => send({ type: "undo" }));
$("#clear").addEventListener("click", () => {
  if (confirm("Очистити полотно для всіх?")) send({ type: "clear" });
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && state.code && e.target !== textInput) {
    e.preventDefault();
    send({ type: "undo" });
  }
});

// ---------- brush ----------

function swatch(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "swatch";
  button.setAttribute("aria-label", label);
  button.append(document.createElement("span"));
  return button;
}

const setDot = (button, color) => button.firstChild.style.setProperty("--dot", color);
const setPressed = (button, on) => button.setAttribute("aria-pressed", String(on));

// Controls are built once and updated in place so keyboard focus survives.
const paletteButtons = PALETTE.map(({ hex, name }) => {
  const button = swatch(name);
  setDot(button, hex);
  button.addEventListener("click", () => { brush.pick(hex); renderBrush(); });
  $("#palette").append(button);
  return { button, hex };
});

const recentButtons = Array.from({ length: MAX_RECENTS }, (_, i) => {
  const button = swatch("");
  button.addEventListener("click", () => { brush.pick(brush.recents[i]); renderBrush(); });
  $("#recents").append(button);
  return button;
});

$("#width").min = MIN_WIDTH;
$("#width").max = MAX_WIDTH;
$("#width").addEventListener("input", (e) => { brush.setWidth(Number(e.target.value)); renderBrush(); });

const toolButtons = [...document.querySelectorAll(".tool-btn")];
for (const button of toolButtons) {
  button.addEventListener("click", () => { brush.setTool(button.dataset.tool); renderBrush(); });
}

function renderBrush() {
  const { color, eraser, recents, hsv } = brush;
  const pen = (c) => !eraser && c === color;
  for (const { button, hex } of paletteButtons) setPressed(button, pen(hex));
  recentButtons.forEach((button, i) => {
    const c = recents[i];
    button.disabled = !c;
    button.setAttribute("aria-label", c ? `Останній колір ${c}` : "Порожній слот");
    setDot(button, c ?? "none");
    setPressed(button, Boolean(c) && pen(c));
  });
  for (const button of toolButtons) setPressed(button, !eraser && button.dataset.tool === brush.tool);
  setPressed($("#eraser"), eraser);
  $("#width").value = brush.width;
  $("#width-value").textContent = brush.width;
  canvas.dataset.tool = brush.tool;

  const style = $("#room").style;
  style.setProperty("--current", color);
  style.setProperty("--sv-hue", hsvToHex({ h: hsv.h, s: 1, v: 1 }));
  $("#saturation").style.setProperty(
    "--track",
    `linear-gradient(to right, ${hsvToHex({ ...hsv, s: 0 })}, ${hsvToHex({ ...hsv, s: 1 })})`,
  );
  $("#sv-marker").style.left = `${hsv.s * 100}%`;
  $("#sv-marker").style.top = `${(1 - hsv.v) * 100}%`;
  $("#preview-hex").textContent = color;
  $("#hue").value = hsv.h;
  $("#saturation").value = hsv.s * 100;
  $("#brightness").value = hsv.v * 100;
}

function pickFromSquare(e) {
  const r = $("#sv").getBoundingClientRect();
  const clamp = (v) => Math.min(1, Math.max(0, v));
  brush.setHsv({ s: clamp((e.clientX - r.left) / r.width), v: 1 - clamp((e.clientY - r.top) / r.height) });
  renderBrush();
}

$("#sv").addEventListener("pointerdown", (e) => {
  $("#sv").setPointerCapture(e.pointerId);
  pickFromSquare(e);
});
$("#sv").addEventListener("pointermove", (e) => {
  if ($("#sv").hasPointerCapture(e.pointerId)) pickFromSquare(e);
});

for (const [id, read] of [
  ["#hue", (v) => ({ h: v })],
  ["#saturation", (v) => ({ s: v / 100 })],
  ["#brightness", (v) => ({ v: v / 100 })],
]) {
  $(id).addEventListener("input", (e) => { brush.setHsv(read(Number(e.target.value))); renderBrush(); });
}

$("#eraser").addEventListener("click", () => { brush.toggleEraser(); renderBrush(); });

renderBrush();

// ---------- members & cursors ----------

// The list opens beside the toolbar, over the canvas, and goes away by itself.
$("#members-panel").addEventListener("beforetoggle", (e) => {
  if (e.newState !== "open") return;
  const panel = $("#members-panel").style;
  const toolbar = $("#toolbar").getBoundingClientRect();
  const stacked = getComputedStyle($(".workspace-row")).flexDirection === "column";
  const top = stacked ? toolbar.top + LAYOUT_GAP : $("#members-toggle").getBoundingClientRect().top;
  panel.top = `${top}px`;
  panel.maxHeight = `${innerHeight - top - LAYOUT_GAP}px`;
  panel.right = `${stacked ? LAYOUT_GAP : innerWidth - toolbar.left + LAYOUT_GAP}px`;
});

function renderMembers() {
  const list = $("#members");
  list.replaceChildren();
  for (const [id, { name, creator }] of room.members) {
    const li = document.createElement("li");
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = initial(name);
    avatar.style.setProperty("--tint", memberTint(id));
    avatar.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "member-name";
    label.textContent = name;
    label.title = name;
    const note = document.createElement("span");
    note.className = "helper";
    note.textContent = [id === room.me?.id && "ви", creator && "творець"].filter(Boolean).join(", ");
    const text = document.createElement("span");
    text.className = "member-text";
    text.append(label, note);
    li.append(avatar, text);
    list.append(li);
  }
  $("#member-count").textContent = `${room.members.size} з ${MAX_MEMBERS}`;
}

function moveCursor({ id, pos, name }) {
  let c = state.cursors.get(id);
  if (!c) {
    const el = $("#cursor-template").content.firstElementChild.cloneNode(true);
    el.style.color = memberColor(id);
    $("#cursors").append(el);
    c = { el, label: el.querySelector("span"), timer: 0 };
    state.cursors.set(id, c);
  }
  c.label.textContent = name;
  c.el.style.left = `${pos[0] * 100}%`;
  c.el.style.top = `${pos[1] * 100}%`;
  c.el.style.opacity = "1";
  clearTimeout(c.timer);
  c.timer = setTimeout(() => { c.el.style.opacity = "0"; }, 3000);
}

function removeCursor(id) {
  const c = state.cursors.get(id);
  if (!c) return;
  clearTimeout(c.timer);
  c.el.remove();
  state.cursors.delete(id);
}

// ---------- room lifetime ----------

setInterval(() => {
  const el = $("#countdown");
  const text = state.code && !state.closed && state.welcomed ? room.countdown(performance.now()) : null;
  el.hidden = text === null;
  if (text !== null) el.textContent = text;
}, 1000);

// ---------- misc ----------

// Texts are drawn on the canvas, which does not wait for the web font.
document.fonts.load("16px Manrope", "Аa").then(redraw);
redraw();

function setStatus(text) {
  $("#status").textContent = text;
}

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// A shared link (#CODE) joins straight away.
const linked = location.hash.slice(1).toUpperCase();
if (linked) {
  $("#code").value = linked;
  joinRoom(linked);
}
