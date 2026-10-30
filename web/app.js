import {
  Room,
  STATUS_ROOM_CLOSED,
  closeOutcome,
  isRoomCode,
  leaveLabel,
  normalizePoint,
  randomId,
  roomProblem,
} from "./room.js";

// Canvas keeps a fixed aspect ratio so normalized coordinates mean the same
// thing on every screen. Line widths are relative to a 1000px-wide canvas.
const ASPECT = 16 / 10;
const REF_WIDTH = 1000;
const FLUSH_MS = 30;
const CURSOR_MS = 50;

const $ = (sel) => document.querySelector(sel);
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

const room = new Room();
const state = {
  code: null,
  ws: null,
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

function showLobby(error = "") {
  state.code = null;
  $("#room").hidden = true;
  $("#lobby").hidden = false;
  $("#lobby-error").textContent = error;
  history.replaceState(null, "", location.pathname);
}

$("#create").addEventListener("click", async () => {
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
    $("#lobby-error").textContent = err.message;
  }
});

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#code").value.trim().toUpperCase();
  const problem = await checkRoom(code);
  if (problem) $("#lobby-error").textContent = problem.text;
  else enterRoom(code);
});

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
  $("#copy").textContent = code;
  $("#lobby").hidden = true;
  $("#room").hidden = false;
  resize();
  connect();
}

$("#leave").addEventListener("click", () => {
  if (room.me?.creator && !state.closed && state.ws?.readyState === WebSocket.OPEN) {
    // The server answers by closing every connection, ours included.
    if (confirm("Закрити кімнату для всіх учасників?")) send({ type: "close_room" });
    return;
  }
  state.leaving = true;
  state.ws?.close(1000);
  showLobby();
});

function roomClosed(reason) {
  const outcome = closeOutcome(reason, room.me?.creator ?? false);
  if (outcome.lobby) {
    showLobby();
    return;
  }
  setClosed(true);
  $("#closed-text").textContent = outcome.text;
}

// setClosed switches between drawing and viewing a closed room's canvas.
function setClosed(closed) {
  state.closed = closed;
  room.current = null;
  $("#closed").hidden = !closed;
  for (const el of document.querySelectorAll(".toolbar .tool")) el.disabled = closed;
  if (closed) {
    for (const id of [...state.cursors.keys()]) removeCursor(id);
    setStatus("");
  }
  updateLeaveButton();
}

function updateLeaveButton() {
  $("#leave").textContent = leaveLabel({ closed: state.closed, creator: room.me?.creator ?? false });
}

$("#save-png").addEventListener("click", () => {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext("2d");
  octx.fillStyle = "#ffffff"; // the canvas itself is transparent
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0);
  out.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `room-${state.code}.png`;
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
      if (problem?.fatal) {
        showLobby(problem.text);
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
  if (fx.error) toast(fx.error);
}

// ---------- drawing ----------

function drawFrom(s, from) {
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

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of room.strokes.values()) drawFrom(s, 0);
}

function resize() {
  const wrap = $("#stage-wrap");
  const style = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availH = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  let w = availW;
  let h = w / ASPECT;
  if (availH > 0 && h > availH) {
    h = availH;
    w = h * ASPECT;
  }
  w = Math.max(200, Math.floor(w));
  h = Math.floor(w / ASPECT);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  redraw();
}

window.addEventListener("resize", () => { if (state.code) resize(); });

const pointOf = (e) => normalizePoint(e.clientX, e.clientY, canvas.getBoundingClientRect());

canvas.addEventListener("pointerdown", (e) => {
  if (state.closed || state.ws?.readyState !== WebSocket.OPEN || e.button !== 0) return;
  const started = room.startStroke(pointOf(e), $("#color").value, Number($("#width").value));
  if (!started) return;
  canvas.setPointerCapture(e.pointerId);
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

const endStroke = () => sendAll(room.endStroke());
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

setInterval(() => sendAll(room.flush()), FLUSH_MS);

$("#undo").addEventListener("click", () => send({ type: "undo" }));
$("#clear").addEventListener("click", () => {
  if (confirm("Очистити полотно для всіх?")) send({ type: "clear" });
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && state.code) {
    e.preventDefault();
    send({ type: "undo" });
  }
});

// ---------- members & cursors ----------

function renderMembers() {
  const list = $("#members");
  list.replaceChildren();
  for (const [id, { name, creator }] of room.members) {
    const li = document.createElement("li");
    li.textContent = name + (creator ? " ★" : "") + (id === room.me?.id ? " (ви)" : "");
    if (creator) li.title = "Творець кімнати";
    if (id === room.me?.id) li.className = "me";
    list.append(li);
  }
}

function moveCursor({ id, pos, name }) {
  let c = state.cursors.get(id);
  if (!c) {
    const el = document.createElement("div");
    el.className = "cursor";
    const label = document.createElement("span");
    el.append(label);
    $("#cursors").append(el);
    c = { el, label, timer: 0 };
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
  checkRoom(linked).then((problem) => (problem ? showLobby(problem.text) : enterRoom(linked)));
}
