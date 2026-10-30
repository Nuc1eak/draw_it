"use strict";

// Canvas keeps a fixed aspect ratio so normalized coordinates mean the same
// thing on every screen. Line widths are relative to a 1000px-wide canvas.
const ASPECT = 16 / 10;
const REF_WIDTH = 1000;
const FLUSH_MS = 30;
const CURSOR_MS = 50;
const MAX_POINTS_PER_MSG = 500;

const $ = (sel) => document.querySelector(sel);
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");

const state = {
  code: null,
  ws: null,
  me: null,
  leaving: false,
  welcomed: false,
  closed: false,      // the room was closed; the canvas stays for viewing
  deadline: 0,        // performance.now() at which the room's hour runs out
  backoff: 500,
  members: new Map(), // id -> {name, creator}
  strokes: new Map(), // id -> {color, width, pts}, in drawing order
  current: null,      // {id, localId, pending}
  seq: 0,
  cursors: new Map(), // member id -> {el, timer}
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

function randomId() {
  // randomUUID exists only in secure contexts (HTTPS or localhost), so plain
  // HTTP on a LAN address needs the fallback.
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

// checkRoom returns null if the room can be joined, otherwise a user-facing
// reason; fatal reasons mean retrying will not help.
async function checkRoom(code) {
  if (!/^[A-Z0-9]{5}$/.test(code)) return { text: "Код складається з 5 символів.", fatal: true };
  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (res.status === 404) return { text: "Кімнату не знайдено.", fatal: true };
    if (!res.ok) return { text: `Помилка ${res.status}`, fatal: false };
    const info = await res.json();
    if (info.members >= info.capacity) return { text: "Кімната заповнена.", fatal: true };
    return null;
  } catch {
    return { text: "Немає з'єднання з сервером.", fatal: false };
  }
}

function enterRoom(code) {
  save("name", $("#name").value.trim());
  state.code = code;
  state.leaving = false;
  state.backoff = 500;
  setClosed(false);
  history.replaceState(null, "", `#${code}`);
  $("#copy").textContent = code;
  $("#lobby").hidden = true;
  $("#room").hidden = false;
  resize();
  connect();
}

$("#leave").addEventListener("click", () => {
  if (state.me?.creator && !state.closed && state.ws?.readyState === WebSocket.OPEN) {
    // The server answers by closing every connection, ours included.
    if (confirm("Закрити кімнату для всіх учасників?")) send({ type: "close_room" });
    return;
  }
  state.leaving = true;
  state.ws?.close(1000);
  showLobby();
});

const CLOSE_REASONS = {
  creator_left: "Творець закрив кімнату.",
  creator_gone: "Творець не повертався 5 хвилин, тому кімнату закрито.",
  expired: "Минула година з моменту створення, тому кімнату закрито.",
};

function roomClosed(reason) {
  if (reason === "creator_left" && state.me?.creator) {
    showLobby();
    return;
  }
  setClosed(true);
  $("#closed-text").textContent = CLOSE_REASONS[reason] ?? "Кімнату закрито.";
}

// setClosed switches between drawing and viewing a closed room's canvas.
function setClosed(closed) {
  state.closed = closed;
  state.current = null;
  $("#closed").hidden = !closed;
  for (const el of document.querySelectorAll(".toolbar .tool")) el.disabled = closed;
  if (closed) {
    for (const id of [...state.cursors.keys()]) removeCursor(id);
    setStatus("");
  }
  updateLeaveButton();
}

function updateLeaveButton() {
  $("#leave").textContent = state.closed ? "До лобі" : state.me?.creator ? "Закрити кімнату" : "Вийти";
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
    state.current = null;
    if (e.code === 4000) {
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

function handle(msg) {
  switch (msg.type) {
    case "welcome":
      state.welcomed = true;
      state.backoff = 500;
      state.me = msg.you;
      state.current = null;
      state.deadline = performance.now() + msg.expiresIn;
      state.members = new Map(msg.members.map((m) => [m.id, m]));
      updateLeaveButton();
      state.strokes.clear();
      for (const id of [...state.cursors.keys()]) removeCursor(id);
      renderMembers();
      redraw();
      setStatus("Синхронізація…");
      break;
    case "history":
      for (const m of msg.msgs) applyStroke(m);
      break;
    case "synced":
      setStatus("");
      break;
    case "stroke_start":
    case "stroke_points":
    case "stroke_end":
      applyStroke(msg);
      break;
    case "stroke_removed":
      for (const id of msg.ids) state.strokes.delete(id);
      if (state.current && msg.ids.includes(state.current.id)) state.current = null;
      redraw();
      break;
    case "cleared":
      state.strokes.clear();
      state.current = null;
      redraw();
      break;
    case "member_joined":
      for (const m of msg.members) state.members.set(m.id, m);
      renderMembers();
      break;
    case "member_left":
      state.members.delete(msg.memberId);
      removeCursor(msg.memberId);
      renderMembers();
      break;
    case "cursor":
      moveCursor(msg.memberId, msg.pos);
      break;
    case "error":
      toast(`Помилка: ${msg.msg}`);
      break;
  }
}

function applyStroke(msg) {
  if (msg.type === "stroke_start") {
    state.strokes.set(msg.id, { color: msg.color, width: msg.width, pts: [] });
  } else if (msg.type === "stroke_points") {
    const s = state.strokes.get(msg.id);
    if (!s) return;
    for (const p of msg.pts) addPoint(s, p);
  } else if (msg.type === "stroke_end" && state.current?.id === msg.id) {
    // The server ended our stroke (length limit): stop sending to it.
    flush();
    state.current = null;
  }
}

// ---------- drawing ----------

function addPoint(s, p) {
  const prev = s.pts[s.pts.length - 1];
  s.pts.push(p);
  drawSegment(s, prev ?? p, p);
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
  for (const s of state.strokes.values()) {
    for (let i = 0; i < s.pts.length; i++) drawSegment(s, s.pts[i - 1] ?? s.pts[i], s.pts[i]);
  }
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

function normalize(e) {
  const r = canvas.getBoundingClientRect();
  const clamp = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
  return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
}

canvas.addEventListener("pointerdown", (e) => {
  if (!state.me || state.closed || state.ws?.readyState !== WebSocket.OPEN || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const localId = `s${++state.seq}`;
  const id = `${state.me.id}:${localId}`;
  const s = { color: $("#color").value, width: Number($("#width").value), pts: [] };
  state.strokes.set(id, s);
  send({ type: "stroke_start", id: localId, color: s.color, width: s.width });
  state.current = { id, localId, pending: [] };
  const p = normalize(e);
  addPoint(s, p);
  state.current.pending.push(p);
});

canvas.addEventListener("pointermove", (e) => {
  const p = normalize(e);
  const now = performance.now();
  if (now - state.lastCursor > CURSOR_MS) {
    state.lastCursor = now;
    send({ type: "cursor", pos: p });
  }
  const cur = state.current;
  if (!cur) return;
  const s = state.strokes.get(cur.id);
  if (!s) return;
  addPoint(s, p);
  cur.pending.push(p);
});

function endStroke() {
  if (!state.current) return;
  flush();
  send({ type: "stroke_end", id: state.current.localId });
  state.current = null;
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

function flush() {
  const cur = state.current;
  if (!cur) return;
  while (cur.pending.length) {
    send({ type: "stroke_points", id: cur.localId, pts: cur.pending.splice(0, MAX_POINTS_PER_MSG) });
  }
}

setInterval(flush, FLUSH_MS);

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
  for (const [id, { name, creator }] of state.members) {
    const li = document.createElement("li");
    li.textContent = name + (creator ? " ★" : "") + (id === state.me?.id ? " (ви)" : "");
    if (creator) li.title = "Творець кімнати";
    if (id === state.me?.id) li.className = "me";
    list.append(li);
  }
}

function moveCursor(id, pos) {
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
  c.label.textContent = state.members.get(id)?.name ?? "?";
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

const WARN_MS = 5 * 60 * 1000;

setInterval(() => {
  const el = $("#countdown");
  const left = state.deadline - performance.now();
  if (!state.code || state.closed || !state.welcomed || left > WARN_MS) {
    el.hidden = true;
    return;
  }
  const secs = Math.max(0, Math.ceil(left / 1000));
  el.textContent = `Кімната закриється через ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  el.hidden = false;
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
