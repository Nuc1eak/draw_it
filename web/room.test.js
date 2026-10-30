import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  MAX_POINTS_PER_MSG,
  Room,
  WARN_MS,
  closeOutcome,
  countdownText,
  isRoomCode,
  leaveLabel,
  normalizePoint,
  randomId,
  roomProblem,
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
  assert.deepEqual(roomProblem("K7QXM", 404, null), { text: "Кімнату не знайдено.", fatal: true });
  assert.deepEqual(roomProblem("K7QXM", 200, { members: 10, capacity: 10 }), { text: "Кімната заповнена.", fatal: true });
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
