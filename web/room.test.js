import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  AVATAR_TINTS,
  Brush,
  CANVAS_ASPECT,
  CARD_BORDERS,
  DEFAULT_WIDTH,
  ERASER_COLOR,
  LAYOUT_GAP,
  MAX_POINTS_PER_MSG,
  MAX_RECENTS,
  PALETTE,
  Room,
  TOOLBAR_CONTENT_H,
  TOOLBAR_MAX_W,
  TOOLBAR_MIN_SCALE,
  TOOLBAR_MIN_W,
  WARN_MS,
  closeOutcome,
  countdownText,
  floodFill,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  initial,
  isRoomCode,
  leaveLabel,
  memberColor,
  memberTint,
  normalizePoint,
  pushRecent,
  randomId,
  roomProblem,
  textSize,
  toolbarLayout,
} from "./room.js";

// Mirrors clientIDRe and strokeIDRe in the Go server.
const SERVER_CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SERVER_STROKE_ID = /^[A-Za-z0-9_-]{1,32}$/;

const welcome = (you, others = [], expiresIn = 3600_000) => ({
  type: "welcome",
  you,
  members: [you, ...others],
  expiresIn,
});

function joined(you = { id: "m1", name: "Alice", creator: true }) {
  const room = new Room();
  room.apply(welcome(you), 0);
  return room;
}

test("randomId uses randomUUID in secure contexts", () => {
  const id = randomId({ randomUUID: () => "11111111-2222-3333-4444-555555555555" });
  assert.equal(id, "11111111-2222-3333-4444-555555555555");
  assert.match(id, SERVER_CLIENT_ID);
});

test("randomId falls back to getRandomValues without randomUUID", () => {
  const noUUID = { getRandomValues: (a) => webcrypto.getRandomValues(a) };
  const a = randomId(noUUID);
  const b = randomId(noUUID);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(a, SERVER_CLIENT_ID);
  assert.notEqual(a, b);
});

test("isRoomCode accepts only the server's alphabet", () => {
  assert.ok(isRoomCode("K7QXM"));
  for (const bad of ["", "K7QX", "K7QXMM", "k7qxm", "K7QX0", "K7QXO", "K7QX1", "K7QXI", "K7QXL"]) {
    assert.ok(!isRoomCode(bad), bad);
  }
});

test("roomProblem explains why a room cannot be joined", () => {
  const info = { members: 3, capacity: 10 };
  assert.equal(roomProblem("K7QXM", 200, info), null);
  assert.deepEqual(roomProblem("K7QX0", 200, info), { text: "Невірний код кімнати.", fatal: true });
  assert.deepEqual(roomProblem("K7QXM", 404, null), { text: "Кімнату не знайдено.", fatal: true, screen: "not-found" });
  assert.deepEqual(roomProblem("K7QXM", 200, { members: 10, capacity: 10 }), {
    text: "Кімната заповнена.",
    fatal: true,
    screen: "full",
    members: 10,
    capacity: 10,
  });
  assert.equal(roomProblem("K7QX0", 200, info).screen, undefined, "a mistyped code stays in the lobby");
  // Transient problems let the page keep reconnecting.
  assert.equal(roomProblem("K7QXM", 503, null).fatal, false);
  assert.equal(roomProblem("K7QXM", null, null).fatal, false);
});

test("closeOutcome sends the creator who closed the room to the lobby", () => {
  assert.deepEqual(closeOutcome("creator_left", true), { lobby: true });
});

test("closeOutcome keeps the canvas with a reason for everyone else", () => {
  assert.deepEqual(closeOutcome("creator_left", false), { lobby: false, text: "Творець закрив кімнату." });
  assert.match(closeOutcome("creator_gone", false).text, /5 хвилин/);
  assert.match(closeOutcome("expired", false).text, /година/);
  // The lifetime limit also closes the room on its creator.
  assert.equal(closeOutcome("expired", true).lobby, false);
  assert.equal(closeOutcome("something_new", false).text, "Кімнату закрито.");
});

test("leaveLabel depends on role and whether the room is closed", () => {
  assert.equal(leaveLabel({ closed: false, creator: true }), "Закрити кімнату");
  assert.equal(leaveLabel({ closed: false, creator: false }), "Вийти");
  assert.equal(leaveLabel({ closed: true, creator: true }), "До лобі");
});

test("countdownText appears only in the last five minutes", () => {
  assert.equal(countdownText(WARN_MS + 1), null);
  assert.equal(countdownText(WARN_MS), "Кімната закриється через 5:00");
  assert.equal(countdownText(61_001), "Кімната закриється через 1:02"); // rounds up
  assert.equal(countdownText(9_000), "Кімната закриється через 0:09");
  assert.equal(countdownText(-500), "Кімната закриється через 0:00");
});

test("countdown runs from expiresIn on the local clock", () => {
  const room = new Room();
  assert.equal(room.countdown(0), null); // before the welcome
  room.apply(welcome({ id: "m1", name: "A" }, [], 10 * 60_000), 1_000);
  assert.equal(room.countdown(1_000), null);
  assert.equal(room.countdown(1_000 + 6 * 60_000), "Кімната закриється через 4:00");
});

test("normalizePoint clamps to the canvas and rounds to 4 decimals", () => {
  const rect = { left: 10, top: 20, width: 300, height: 200 };
  assert.deepEqual(normalizePoint(10, 20, rect), [0, 0]);
  assert.deepEqual(normalizePoint(310, 220, rect), [1, 1]);
  assert.deepEqual(normalizePoint(0, 500, rect), [0, 1]);
  assert.deepEqual(normalizePoint(110, 120, rect), [0.3333, 0.5]);
});

test("welcome sets identity and members and drops old state", () => {
  const room = joined();
  room.startStroke([0.1, 0.1], "#000000", 2);
  const fx = room.apply(welcome({ id: "m7", name: "Alice", creator: true }, [{ id: "m3", name: "Bob" }]), 0);
  assert.deepEqual(room.me, { id: "m7", name: "Alice", creator: true });
  assert.deepEqual([...room.members.keys()], ["m7", "m3"]);
  assert.equal(room.strokes.size, 0);
  assert.equal(room.current, null, "a reconnect abandons the stroke in progress");
  assert.ok(fx.redraw && fx.members && fx.resetCursors);
  assert.equal(fx.status, "Синхронізація…");
});

test("history frames rebuild strokes and report what to draw", () => {
  const room = joined();
  const fx = room.apply({
    type: "history",
    msgs: [
      { type: "stroke_start", id: "m2:s1", author: "m2", color: "#ff0000", width: 5 },
      { type: "stroke_points", id: "m2:s1", pts: [[0.1, 0.1], [0.2, 0.2]] },
      { type: "stroke_points", id: "m2:s1", pts: [[0.3, 0.3]] },
      { type: "stroke_end", id: "m2:s1" },
    ],
  }, 0);
  const s = room.strokes.get("m2:s1");
  assert.deepEqual(s, { color: "#ff0000", width: 5, pts: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]] });
  assert.deepEqual(fx.draws.map((d) => d.from), [0, 2]);
  assert.equal(fx.redraw, false, "history draws incrementally");
  assert.equal(room.apply({ type: "synced" }, 0).status, "");
});

test("points for a stroke that is gone are ignored", () => {
  const room = joined();
  const fx = room.apply({ type: "stroke_points", id: "m2:nope", pts: [[0.5, 0.5]] }, 0);
  assert.deepEqual(fx.draws, []);
  assert.equal(room.strokes.size, 0);
});

test("own strokes produce messages the server accepts", () => {
  const room = joined();
  const started = room.startStroke([0, 0], "#123456", 6);
  assert.deepEqual(started.msgs, [{ type: "stroke_start", id: "s1", color: "#123456", width: 6 }]);
  assert.match(started.msgs[0].id, SERVER_STROKE_ID);
  assert.ok(room.strokes.has("m1:s1"), "the server will call it member:local");

  for (let i = 1; i <= 600; i++) {
    const added = room.addPoint([i / 1000, i / 1000]);
    assert.equal(added.from, i);
  }
  const batches = room.flush();
  assert.deepEqual(batches.map((m) => m.pts.length), [MAX_POINTS_PER_MSG, 101]);
  assert.ok(batches.every((m) => m.type === "stroke_points" && m.id === "s1"));
  assert.deepEqual(room.flush(), [], "nothing is sent twice");

  room.addPoint([0.9, 0.9]);
  assert.deepEqual(room.endStroke(), [
    { type: "stroke_points", id: "s1", pts: [[0.9, 0.9]] },
    { type: "stroke_end", id: "s1" },
  ]);
  assert.equal(room.addPoint([0.5, 0.5]), null);
  assert.deepEqual(room.endStroke(), []);
  assert.equal(room.startStroke([0, 0], "#000000", 1).msgs[0].id, "s2");
});

test("no own stroke before the welcome", () => {
  assert.equal(new Room().startStroke([0, 0], "#000000", 1), null);
});

test("the server ending our stroke stops sending its points", () => {
  const room = joined();
  room.startStroke([0, 0], "#000000", 1);
  room.addPoint([0.1, 0.1]);
  room.apply({ type: "stroke_end", id: "m1:s1", author: "m1" }, 0);
  assert.equal(room.current, null);
  assert.deepEqual(room.flush(), []);
  assert.deepEqual(room.endStroke(), [], "no stroke_end for a stroke the server already ended");
  assert.equal(room.strokes.get("m1:s1").pts.length, 2, "what was drawn stays on the canvas");
});

test("another member's stroke_end does not touch ours", () => {
  const room = joined();
  room.startStroke([0, 0], "#000000", 1);
  room.apply({ type: "stroke_end", id: "m2:s1", author: "m2" }, 0);
  assert.notEqual(room.current, null);
});

test("undo or eviction of our current stroke stops it", () => {
  const room = joined();
  room.startStroke([0, 0], "#000000", 1);
  room.apply({ type: "stroke_start", id: "m2:s1", color: "#000000", width: 1 }, 0);
  const fx = room.apply({ type: "stroke_removed", ids: ["m1:s1"] }, 0);
  assert.ok(fx.redraw);
  assert.equal(room.current, null);
  assert.deepEqual([...room.strokes.keys()], ["m2:s1"]);
});

test("cleared empties the canvas and stops our stroke", () => {
  const room = joined();
  room.startStroke([0, 0], "#000000", 1);
  room.apply({ type: "stroke_start", id: "m2:s1", color: "#000000", width: 1 }, 0);
  assert.ok(room.apply({ type: "cleared", memberId: "m2" }, 0).redraw);
  assert.equal(room.strokes.size, 0);
  assert.equal(room.addPoint([0.5, 0.5]), null);
});

test("members, cursors and errors", () => {
  const room = joined();
  assert.ok(room.apply({ type: "member_joined", members: [{ id: "m2", name: "Bob" }] }, 0).members);
  assert.deepEqual(room.apply({ type: "cursor", memberId: "m2", pos: [0.2, 0.3] }, 0).cursor, {
    id: "m2",
    pos: [0.2, 0.3],
    name: "Bob",
  });

  const left = room.apply({ type: "member_left", memberId: "m2" }, 0);
  assert.ok(left.members);
  assert.equal(left.cursorGone, "m2");
  assert.ok(!room.members.has("m2"));
  assert.equal(room.apply({ type: "cursor", memberId: "m9", pos: [0, 0] }, 0).cursor.name, "?");

  assert.equal(room.apply({ type: "error", code: "forbidden", msg: "nope" }, 0).error, "Помилка: nope");
});

test("hex and hsv convert both ways", () => {
  for (const hex of [...PALETTE.map((c) => c.hex), "#000000", "#FFFFFF", "#808080"]) {
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  }
  assert.deepEqual(hexToHsv("#FF0000"), { h: 0, s: 1, v: 1 });
  assert.deepEqual(hexToHsv("#000000"), { h: 0, s: 0, v: 0 });
  assert.deepEqual(hexToHsv("#FFFFFF"), { h: 0, s: 0, v: 1 });
  assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), "#00FF00");
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), "#FF0000");
});

test("pushRecent keeps newest first without duplicates", () => {
  assert.deepEqual(pushRecent(["#111111", "#222222"], "#333333"), ["#333333", "#111111", "#222222"]);
  assert.deepEqual(pushRecent(["#111111", "#222222"], "#222222"), ["#222222", "#111111"]);
  const full = Array.from({ length: MAX_RECENTS }, (_, i) => `#00000${i}`);
  const next = pushRecent(full, "#FFFFFF");
  assert.equal(next.length, MAX_RECENTS);
  assert.equal(next[0], "#FFFFFF");
  assert.ok(!next.includes(full.at(-1)), "the oldest color falls off");
});

test("picking a color syncs the picker", () => {
  const brush = new Brush();
  brush.pick("#E03131");
  assert.equal(brush.color, "#E03131");
  assert.deepEqual(brush.hsv, hexToHsv("#E03131"));
});

test("a color reaches recents only when drawn with", () => {
  const brush = new Brush();
  assert.deepEqual(brush.recents, []);
  brush.pick("#E03131");
  brush.setHsv({ h: 10 });
  assert.deepEqual(brush.recents, [], "choosing is not drawing");
  brush.markUsed();
  assert.deepEqual(brush.recents, [brush.color]);
  const first = brush.color;
  brush.pick("#2F9E44");
  assert.deepEqual(brush.recents, [first]);
  brush.markUsed();
  assert.deepEqual(brush.recents, ["#2F9E44", first]);
});

test("erasing leaves recents alone", () => {
  const brush = new Brush();
  brush.toggleEraser();
  brush.markUsed();
  assert.deepEqual(brush.recents, []);
});

test("a color without hue keeps the picker's hue", () => {
  const brush = new Brush();
  brush.setHsv({ h: 200 });
  brush.pick("#000000");
  assert.equal(brush.hsv.h, 200);
  brush.pick("#FFFFFF");
  assert.equal(brush.hsv.h, 200);
  brush.setHsv({ v: 0 });
  assert.equal(brush.color, "#000000");
  assert.equal(brush.hsv.h, 200, "dragging through black does not reset the hue");
});

test("the eraser paints the canvas color and any color choice ends it", () => {
  const brush = new Brush();
  const color = brush.color;
  brush.toggleEraser();
  assert.equal(brush.strokeColor, ERASER_COLOR);
  assert.equal(brush.color, color, "the pen color survives erasing");
  brush.toggleEraser();
  assert.equal(brush.strokeColor, color);

  brush.toggleEraser();
  brush.pick("#2F9E44");
  assert.equal(brush.strokeColor, "#2F9E44");
  brush.toggleEraser();
  brush.setHsv({ h: 10 });
  assert.equal(brush.eraser, false);
});

test("member colors are stable and come from the palettes", () => {
  assert.equal(memberColor("abc"), memberColor("abc"));
  assert.ok(PALETTE.some((c) => c.hex === memberColor("abc")));
  assert.ok(AVATAR_TINTS.includes(memberTint("abc")));
  assert.ok(new Set(["m1", "m2", "m3", "m4", "m5"].map(memberColor)).size > 1);
});

test("initial takes the first letter of a name", () => {
  assert.equal(initial("олена"), "О");
  assert.equal(initial("  Їжак"), "Ї");
  assert.equal(initial("😀 ok"), "😀");
  assert.equal(initial("   "), "?");
});

// image builds opaque RGBA data from rows of characters, one per pixel.
const INK = { ".": [255, 255, 255], "#": [0, 0, 0], "~": [128, 128, 128] };
function image(rows) {
  const w = rows[0].length;
  const data = new Uint8ClampedArray(w * rows.length * 4).fill(255);
  [...rows.join("")].forEach((ch, i) => data.set(INK[ch], i * 4));
  return { data, w, h: rows.length };
}
const pixel = ({ data, w }, x, y) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
const RED = [255, 0, 0];

test("floodFill stays inside a closed outline", () => {
  const img = image([
    ".......",
    ".#####.",
    ".#...#.",
    ".#...#.",
    ".#####.",
    ".......",
  ]);
  assert.equal(floodFill(img.data, img.w, img.h, 3, 2, RED), true);
  assert.deepEqual(pixel(img, 3, 3), RED);
  assert.deepEqual(pixel(img, 0, 0), [255, 255, 255], "outside stays white");
  assert.deepEqual(pixel(img, 6, 5), [255, 255, 255]);
});

test("floodFill stops at the edge of the canvas", () => {
  const img = image([
    "..#..",
    "..#..",
    "..#..",
  ]);
  floodFill(img.data, img.w, img.h, 0, 0, RED);
  assert.deepEqual(pixel(img, 0, 2), RED);
  assert.deepEqual(pixel(img, 1, 1), RED);
  assert.deepEqual(pixel(img, 4, 0), [255, 255, 255], "columns do not wrap around");
});

test("floodFill covers the antialiased rim of a line but does not cross it", () => {
  const img = image([
    "...~#~...",
    "...~#~...",
  ]);
  floodFill(img.data, img.w, img.h, 0, 0, RED);
  assert.deepEqual(pixel(img, 3, 0), RED, "no pale halo along the line");
  assert.deepEqual(pixel(img, 4, 0), [0, 0, 0]);
  assert.deepEqual(pixel(img, 5, 0), [128, 128, 128], "the far side is untouched");
  assert.deepEqual(pixel(img, 8, 1), [255, 255, 255]);
});

test("floodFill on a line recolors it", () => {
  const img = image([
    "..#..",
    "..#..",
  ]);
  floodFill(img.data, img.w, img.h, 2, 0, RED);
  assert.deepEqual(pixel(img, 2, 1), RED);
});

test("floodFill with the same color changes nothing", () => {
  const img = image(["..", ".."]);
  const before = [...img.data];
  assert.equal(floodFill(img.data, img.w, img.h, 0, 0, [255, 255, 255]), false);
  assert.deepEqual([...img.data], before);
});

test("hexToRgb reads channels", () => {
  assert.deepEqual(hexToRgb("#1971C2"), [25, 113, 194]);
});

test("textSize grows with the width slider", () => {
  assert.equal(textSize(1), 14);
  assert.equal(textSize(DEFAULT_WIDTH), 24);
  assert.equal(textSize(50), 112);
});

test("the tool switches, and the eraser and tools exclude each other", () => {
  const brush = new Brush();
  assert.equal(brush.tool, "brush");
  brush.setTool("fill");
  assert.equal(brush.tool, "fill");
  brush.toggleEraser();
  assert.equal(brush.tool, "brush", "the eraser is a brush");
  assert.ok(brush.eraser);
  brush.setTool("text");
  assert.equal(brush.eraser, false);
  assert.equal(brush.strokeColor, brush.color);
});

test("own fills and texts produce messages the server accepts", () => {
  const room = joined();
  const fill = room.startFill([0.1, 0.2], "#123456");
  assert.deepEqual(fill.msgs, [{ type: "fill", pos: [0.1, 0.2], color: "#123456", id: "s1" }]);
  assert.equal(fill.stroke.kind, "fill");

  const text = room.addText([0.3, 0.4], "Привіт", "#654321", 8);
  assert.deepEqual(text.msgs, [{ type: "text", pos: [0.3, 0.4], color: "#654321", width: 8, text: "Привіт", id: "s2" }]);
  assert.deepEqual(room.strokes.get("m1:s2"), { kind: "text", color: "#654321", width: 8, text: "Привіт", pts: [[0.3, 0.4]] });
  assert.equal(room.startStroke([0, 0], "#000000", 1).msgs[0].id, "s3", "all share one ID sequence");
});

test("no own fill or text before the welcome", () => {
  const room = new Room();
  assert.equal(room.startFill([0, 0], "#000000"), null);
  assert.equal(room.addText([0, 0], "a", "#000000", 6), null);
});

test("fills and texts from others are drawn live and from history", () => {
  const room = joined();
  const live = room.apply({ type: "fill", id: "m2:s1", author: "m2", color: "#ff0000", pos: [0.5, 0.5] }, 0);
  assert.equal(live.draws[0].stroke.kind, "fill");
  assert.equal(live.draws[0].from, 0);

  const fx = room.apply({
    type: "history",
    msgs: [
      { type: "stroke_start", id: "m2:s2", color: "#000000", width: 2 },
      { type: "stroke_points", id: "m2:s2", pts: [[0, 0]] },
      { type: "text", id: "m2:s3", color: "#00ff00", width: 6, text: "ок", pos: [0.1, 0.1] },
    ],
  }, 0);
  assert.equal(fx.draws.at(-1).stroke.text, "ок");
  assert.deepEqual([...room.strokes.keys()], ["m2:s1", "m2:s2", "m2:s3"], "drawing order is kept");
  assert.ok(room.apply({ type: "stroke_removed", ids: ["m2:s3"] }, 0).redraw);
  assert.ok(!room.strokes.has("m2:s3"));
});

test("toolbarLayout gives the canvas its 16:10 and the toolbar the rest", () => {
  for (const [w, h] of [[1248, 819], [1888, 918], [1888, 1048], [2528, 1236], [1018, 608], [1018, 500]]) {
    const { canvasW, canvasH, toolbarW, scale } = toolbarLayout(w, h);
    assert.ok(Math.abs(canvasW / canvasH - CANVAS_ASPECT) < 0.01, `${w}x${h} keeps its shape`);
    assert.ok(canvasH + CARD_BORDERS <= h, `${w}x${h} fits the height`);
    assert.ok(scale >= TOOLBAR_MIN_SCALE, `${w}x${h} stays readable`);
    const used = canvasW + CARD_BORDERS + LAYOUT_GAP + toolbarW * scale;
    assert.ok(Math.abs(used - w) < 0.01, `${w}x${h} leaves no empty strip`);
    assert.ok(TOOLBAR_CONTENT_H * scale <= h + 1, `${w}x${h} toolbar fits when scaled`);
  }
});

test("toolbarLayout scales the toolbar down in a short window", () => {
  const { scale } = toolbarLayout(1018, 608);
  assert.ok(scale < 1 && scale >= TOOLBAR_MIN_SCALE);
  assert.equal(toolbarLayout(1018, 300).scale, TOOLBAR_MIN_SCALE, "and not without limit");
});

test("toolbarLayout caps the toolbar on an ultrawide window", () => {
  const { toolbarW, canvasH } = toolbarLayout(3408, 1268);
  assert.equal(toolbarW, TOOLBAR_MAX_W);
  assert.ok(canvasH >= 1264, "the canvas still takes the full height");
});

test("toolbarLayout keeps the toolbar at its base size on a laptop", () => {
  const { scale, toolbarW } = toolbarLayout(1248, 819);
  assert.equal(scale, 1);
  assert.equal(toolbarW, TOOLBAR_MIN_W);
});

test("toolbarLayout grows the toolbar on a wide monitor", () => {
  const { scale, canvasH } = toolbarLayout(2528, 1236);
  assert.ok(scale > 1.5);
  assert.ok(canvasH >= 1232, "the canvas takes the full height");
});
