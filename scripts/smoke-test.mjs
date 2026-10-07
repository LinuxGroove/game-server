#!/usr/bin/env node
// End-to-end check of a running game server, through the same REST and
// WebSocket APIs the games use. Needs Node 22+ (global fetch and WebSocket)
// and a server with the sandbox game enabled (GAME_SANDBOX_ENABLED=true).
//
//   SERVER_URL=http://127.0.0.1:7350 SERVER_KEY=defaultkey node scripts/smoke-test.mjs
//
// Set BLOB_TEST=1 when the server has object storage configured to also
// upload and download a blob through pre-signed URLs.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE = (process.env.SERVER_URL || "http://127.0.0.1:7350").replace(/\/$/, "");
const SERVER_KEY = process.env.SERVER_KEY || "defaultkey";
const BLOB_TEST = process.env.BLOB_TEST === "1";
const WS_BASE = BASE.replace(/^http/, "ws");

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body.message || body.error || JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
    this.reason = String(body.message || body.error || "").split(":")[0];
  }
}

async function http(method, path, { token, body, basic } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (basic) headers.Authorization = "Basic " + Buffer.from(SERVER_KEY + ":").toString("base64");
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

async function expectError(promise, status, reason) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an API error, got ${err}`);
    assert.equal(err.status, status, `status for ${err.message}`);
    if (reason) assert.equal(err.reason, reason, `reason for ${err.message}`);
    return err;
  }
  assert.fail(`expected HTTP ${status} ${reason || ""}`);
}

async function login(game, version, { deviceId = randomUUID(), create = true } = {}) {
  const vars = game === null ? undefined : { game, version, platform: "smoke-test" };
  const s = await http("POST", `/v2/account/authenticate/device?create=${create}`, {
    basic: true,
    body: { id: deviceId, vars },
  });
  const claims = JSON.parse(Buffer.from(s.token.split(".")[1], "base64url").toString());
  return { token: s.token, userId: claims.uid, username: claims.usn, deviceId };
}

// Room labels are indexed in batches (match.label_update_interval_ms, 1s by
// default), so a brand-new room can take a moment to be findable.
async function eventually(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function rpc(player, id, payload = {}) {
  const res = await fetch(`${BASE}/v2/rpc/${id}?unwrap`, {
    method: "POST",
    headers: { Authorization: "Bearer " + player.token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    throw new ApiError(res.status, body);
  }
  return text ? JSON.parse(text) : {};
}

// A minimal realtime client: JSON envelopes over WebSocket.
class Socket {
  constructor(player) {
    this.player = player;
    this.cid = 0;
    this.pending = new Map();
    this.inbox = [];
    this.waiters = [];
  }
  async connect() {
    this.ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(this.player.token)}&status=false`);
    this.ws.addEventListener("message", (ev) => this.onMessage(JSON.parse(ev.data)));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    return this;
  }
  onMessage(msg) {
    if (msg.cid && this.pending.has(msg.cid)) {
      const { resolve, reject } = this.pending.get(msg.cid);
      this.pending.delete(msg.cid);
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { rt: msg.error }));
      else resolve(msg);
      return;
    }
    this.inbox.push(msg);
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex(w.pred);
      if (i >= 0) {
        const [m] = this.inbox.splice(i, 1);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }
  request(body) {
    const cid = String(++this.cid);
    return new Promise((resolve, reject) => {
      this.pending.set(cid, { resolve, reject });
      this.ws.send(JSON.stringify({ cid, ...body }));
    });
  }
  send(body) {
    this.ws.send(JSON.stringify(body));
  }
  next(pred, timeoutMs = 5000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error("timed out waiting for a message"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  async nothing(pred, ms = 600) {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(this.inbox.findIndex(pred), -1, "received a message that should not arrive");
  }
  join(matchId) {
    return this.request({ match_join: { match_id: matchId } });
  }
  // Relay wire format: [target count][targets...][payload]
  sendGame(matchId, op, targets, payload) {
    const bytes = Buffer.concat([Buffer.from([targets.length, ...targets]), Buffer.from(payload)]);
    this.send({ match_data_send: { match_id: matchId, op_code: String(op), data: bytes.toString("base64"), reliable: true } });
  }
  sendControl(matchId, op, body) {
    this.send({ match_data_send: { match_id: matchId, op_code: String(op), data: Buffer.from(JSON.stringify(body)).toString("base64") } });
  }
  control(op, timeoutMs) {
    return this.next((m) => m.match_data && Number(m.match_data.op_code) === op, timeoutMs).then((m) =>
      JSON.parse(Buffer.from(m.match_data.data || "", "base64").toString() || "{}"),
    );
  }
  game(op, timeoutMs) {
    return this.next((m) => m.match_data && Number(m.match_data.op_code) === op, timeoutMs).then((m) => ({
      from: m.match_data.presence,
      payload: Buffer.from(m.match_data.data || "", "base64").toString(),
    }));
  }
  close() {
    this.ws.close();
  }
}

const OP = { WELCOME: 1, PEER_JOINED: 2, PEER_LEFT: 3, HOST: 4, ROOM: 5, CLOSING: 6, KICKED: 7, ERROR: 8, SET_ROOM: 20, KICK: 21, CLOSE: 22 };

async function main() {
  console.log(`Smoke testing ${BASE}`);
  const health = await fetch(BASE + "/healthcheck");
  assert.equal(health.status, 200, "healthcheck");

  // Login rules.
  await step("login without a game is refused", () => expectError(login(null), 400, "missing_game"));
  await step("login for an unknown game is refused", () => expectError(login("no-such-game", "1.0.0"), 400, "unknown_game"));
  await step("login with an old client asks for an update", () => expectError(login("sandbox", "0.9.0"), 400, "update_required"));

  const a = await login("sandbox", "1.1.0");
  const b = await login("sandbox", "1.2.0");
  const c = await login("sandbox", "1.2.0");

  await step("core.config describes the game", async () => {
    const cfg = await rpc(a, "core.config");
    assert.equal(cfg.game, "sandbox");
    assert.equal(cfg.version.update_available, true);
    assert.ok(cfg.features.leaderboards.some((l) => l.id === "sandbox.score"));
    assert.equal(cfg.features.rooms.first_game_opcode, 100);
  });

  // Leaderboards.
  await step("score submission writes a namespaced leaderboard", async () => {
    const res = await rpc(a, "core.score_submit", { board: "score", score: 4200, metadata: { level: 3 } });
    assert.equal(res.record.leaderboard_id, "sandbox.score");
    assert.equal(res.record.score, 4200);
    const list = await http("GET", "/v2/leaderboard/sandbox.score?limit=10", { token: b.token });
    assert.ok(list.records.some((r) => r.owner_id === a.userId && Number(r.score) === 4200));
  });
  await step("out of range scores are refused", () => expectError(rpc(a, "core.score_submit", { board: "score", score: 2000000 }), 400));
  await step("server-only boards refuse clients", () =>
    expectError(rpc(a, "core.score_submit", { board: "server_only", score: 1 }), 403, "server_only"),
  );
  await step("clients cannot write leaderboards directly", () =>
    expectError(http("POST", "/v2/leaderboard/sandbox.score", { token: a.token, body: { score: "999999" } }), 403),
  );

  // Storage namespacing.
  const obj = (collection, value, permission_read = 1) => ({
    objects: [{ collection, key: "k", value: JSON.stringify(value), permission_read, permission_write: 1 }],
  });
  await step("own collections are writable", () => http("PUT", "/v2/storage", { token: a.token, body: obj("sandbox.notes", { hi: 1 }, 2) }));
  await step("other games' collections are refused", () =>
    expectError(http("PUT", "/v2/storage", { token: a.token, body: obj("graveyard-hollow.profile", { hi: 1 }) }), 403, "wrong_namespace"),
  );
  await step("undeclared collections are refused", () =>
    expectError(http("PUT", "/v2/storage", { token: a.token, body: obj("sandbox.anything", { hi: 1 }) }), 403, "read_only"),
  );
  await step("private collections cannot be made public", () =>
    expectError(http("PUT", "/v2/storage", { token: a.token, body: obj("sandbox.private", { hi: 1 }, 2) }), 403, "private_collection"),
  );
  await step("oversized objects are refused", () =>
    expectError(http("PUT", "/v2/storage", { token: a.token, body: obj("sandbox.notes", { s: "x".repeat(2000) }) }), 400, "too_large"),
  );

  // Share codes.
  await step("share codes round-trip and enforce limits", async () => {
    const { code } = await rpc(a, "core.share_create", { kind: "level", title: "First level", data: "[1,2,3]", meta: { theme: "ice" } });
    assert.match(code, /^[0-9A-Z]{8}$/);
    const got = await rpc(b, "core.share_get", { code: code.toLowerCase() });
    assert.equal(got.data, "[1,2,3]");
    assert.equal(got.owner_id, a.userId);
    await rpc(a, "core.share_create", { kind: "level", title: "Two", data: "{}" });
    await rpc(a, "core.share_create", { kind: "level", title: "Three", data: "{}" });
    await expectError(rpc(a, "core.share_create", { kind: "level", title: "Four", data: "{}" }), 429, "share_limit");
    const mine = await rpc(a, "core.share_list_mine");
    assert.equal(mine.shares.length, 3);
    await expectError(rpc(b, "core.share_delete", { code }), 403, "not_owner");
    await rpc(b, "core.share_report", { code, reason: "spam" });
    await rpc(a, "core.share_delete", { code });
    await expectError(rpc(b, "core.share_get", { code }), 404, "share_not_found");
    await rpc(a, "core.share_create", { kind: "level", title: "Four", data: "{}" });
  });

  // Blobs.
  if (BLOB_TEST) {
    await step("blobs upload and download through pre-signed URLs", async () => {
      const body = Buffer.from("ghost-frames-" + randomUUID());
      const up = await rpc(a, "core.blob_upload_url", { kind: "ghost", size: body.length, content_type: "application/octet-stream" });
      assert.match(up.key, new RegExp(`^sandbox/ghost/${a.userId}/`));
      // fetch sets Content-Length itself from the body.
      const headers = { "Content-Type": up.headers["Content-Type"] };
      const wrongSize = await fetch(up.url, { method: "PUT", headers, body: Buffer.concat([body, body]) });
      assert.equal(wrongSize.status, 403, "a different size must not match the signature");
      const put = await fetch(up.url, { method: "PUT", headers, body });
      assert.equal(put.status, 200, `upload: ${await put.text()}`);
      const down = await rpc(b, "core.blob_download_url", { key: up.key });
      const got = await fetch(down.url);
      assert.equal(Buffer.from(await got.arrayBuffer()).toString(), body.toString());
      await expectError(rpc(b, "core.blob_delete", { key: up.key }), 403, "not_owner");
      await rpc(a, "core.blob_delete", { key: up.key });
    });
  } else {
    await step("blobs report when object storage is off", () =>
      expectError(rpc(a, "core.blob_upload_url", { kind: "ghost", size: 10 }), 503, "blobs_disabled"),
    );
  }

  // Rooms over the relay.
  const sa = await new Socket(a).connect();
  const sb = await new Socket(b).connect();
  const sc = await new Socket(c).connect();
  let room;
  await step("rooms are created and found by code", async () => {
    room = await rpc(a, "core.room_create", { max_players: 3, listed: true, meta: { map: "test" } });
    assert.match(room.code, /^[0-9A-Z]{6}$/);
    const found = await eventually(() => rpc(b, "core.room_find", { code: room.code.toLowerCase() }));
    assert.equal(found.match_id, room.match_id);
    await eventually(async () => {
      const listed = await rpc(c, "core.room_list", {});
      assert.ok(listed.rooms.some((r) => r.code === room.code && r.meta.map === "test"));
    });
  });

  let slotA, slotB, slotC;
  await step("the creator joins as host", async () => {
    await sa.join(room.match_id);
    const w = await sa.control(OP.WELCOME);
    slotA = w.slot;
    assert.equal(w.host_slot, slotA);
  });
  await step("players join and get a slot", async () => {
    await sb.join(room.match_id);
    const w = await sb.control(OP.WELCOME);
    slotB = w.slot;
    assert.equal(w.host_slot, slotA);
    assert.equal(w.peers.length, 2);
    const joined = await sa.control(OP.PEER_JOINED);
    assert.equal(joined.slot, slotB);
    await sc.join(room.match_id);
    slotC = (await sc.control(OP.WELCOME)).slot;
    await sa.control(OP.PEER_JOINED);
    await sb.control(OP.PEER_JOINED);
  });
  await step("non-host messages only reach the host", async () => {
    sb.sendGame(room.match_id, 100, [slotC], "to-host");
    const got = await sa.game(100);
    assert.equal(got.payload, "to-host");
    assert.equal(got.from.user_id, b.userId);
    await sc.nothing((m) => m.match_data && m.match_data.op_code === "100");
  });
  await step("the host can target one player", async () => {
    sa.sendGame(room.match_id, 101, [slotC], "secret-role");
    const got = await sc.game(101);
    assert.equal(got.payload, "secret-role");
    await sb.nothing((m) => m.match_data && m.match_data.op_code === "101");
  });
  await step("the host can broadcast", async () => {
    sa.sendGame(room.match_id, 102, [], "everyone");
    assert.equal((await sb.game(102)).payload, "everyone");
    assert.equal((await sc.game(102)).payload, "everyone");
  });
  await step("only the host changes the room", async () => {
    sb.sendControl(room.match_id, OP.SET_ROOM, { locked: true });
    const err = await sb.control(OP.ERROR);
    assert.match(err.message, /only the host/);
    sa.sendControl(room.match_id, OP.SET_ROOM, { locked: true, meta: { map: "test", status: "playing" } });
    const info = await sb.control(OP.ROOM);
    assert.equal(info.locked, true);
    assert.equal(info.meta.status, "playing");
  });
  await step("locked rooms refuse newcomers", async () => {
    const d = await login("sandbox", "1.2.0");
    const sd = await new Socket(d).connect();
    await assert.rejects(sd.join(room.match_id), /room_locked/);
    sd.close();
  });
  await step("other games cannot join", async () => {
    const l = await login("graveyard-hollow", "0.1.0");
    const sl = await new Socket(l).connect();
    await assert.rejects(sl.join(room.match_id), /wrong_game/);
    sl.close();
  });
  await step("the host can kick a player", async () => {
    sa.sendControl(room.match_id, OP.KICK, { slot: slotC, reason: "test" });
    const kicked = await sc.control(OP.KICKED);
    assert.equal(kicked.reason, "test");
    const left = await sb.control(OP.PEER_LEFT);
    assert.equal(left.slot, slotC);
    await assert.rejects(sc.join(room.match_id), /kicked/);
  });
  await step("players can't hop into another game's matchmaker pool", async () => {
    const l = await login("graveyard-hollow", "0.1.0");
    const sl = await new Socket(l).connect();
    const t1 = await sb.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    const t2 = await sl.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    assert.ok(t1.matchmaker_ticket.ticket && t2.matchmaker_ticket.ticket);
    await sl.nothing((m) => m.matchmaker_matched, 1500);
    await sb.request({ matchmaker_remove: { ticket: t1.matchmaker_ticket.ticket } });
    sl.close();
  });
  await step("the matchmaker puts matched sandbox players in a relay room", async () => {
    const p1 = await new Socket(await login("sandbox", "1.2.0")).connect();
    const p2 = await new Socket(await login("sandbox", "1.2.0")).connect();
    await p1.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    await p2.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    const m1 = await p1.next((m) => m.matchmaker_matched, 20000);
    const m2 = await p2.next((m) => m.matchmaker_matched, 20000);
    assert.ok(m1.matchmaker_matched.match_id, "matched into an authoritative room");
    assert.equal(m1.matchmaker_matched.match_id, m2.matchmaker_matched.match_id);
    await p1.join(m1.matchmaker_matched.match_id);
    const w = await p1.control(OP.WELCOME);
    assert.equal(w.host_slot, w.slot, "first player in becomes host");
    await p2.join(m2.matchmaker_matched.match_id);
    await p2.control(OP.WELCOME);
    p1.close();
    p2.close();
  });
  await step("chat is off by default", async () => {
    await assert.rejects(sb.request({ channel_join: { target: "lobby", type: 1 } }), /chat_disabled/);
  });
  await step("the room closes when the host leaves for good", async () => {
    sa.close();
    const host = await sb.control(OP.HOST);
    assert.equal(host.away, true);
    const closing = await sb.control(OP.CLOSING, 15000);
    assert.equal(closing.reason, "host_left");
  });
  sb.close();
  sc.close();

  // Graveyard Hollow: bridge rooms (Nakama relayed matches named "graveyard-hollow:<CODE>",
  // as nakama-godot's NakamaMultiplayerBridge uses them).
  const code = () => Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTVWXYZ23456789"[Math.floor(Math.random() * 30)]).join("");
  const createNamed = (s, name) => s.request({ match_create: name === undefined ? {} : { name } }).then((m) => m.match);
  await step("graveyard-hollow rooms are named matches for its own game only", async () => {
    const l = await login("graveyard-hollow", "0.1.0");
    const s = await new Socket(l).connect();
    await assert.rejects(createNamed(s), /bad_room_name/);
    await assert.rejects(createNamed(s, "sandbox:" + code()), /bad_room_name/);
    await assert.rejects(createNamed(s, "graveyard-hollow:abc"), /bad_room_name/);
    await expectError(rpc(l, "core.room_create", {}), 400, "use_named_rooms");
    const sbx = await new Socket(await login("sandbox", "1.2.0")).connect();
    await assert.rejects(sbx.request({ match_create: { name: "sandbox:" + code() } }), /use_room_rpcs/);
    s.close();
    sbx.close();
  });
  await step("the first player in a graveyard-hollow room hosts, others join by name", async () => {
    const name = "graveyard-hollow:" + code();
    const players = [];
    for (let i = 0; i < 3; i++) players.push(await new Socket(await login("graveyard-hollow", "0.1.0")).connect());
    // Guests look a code up first; asking about an empty one opens nothing.
    await expectError(rpc(players[1].player, "core.room_find", { code: name.split(":")[1] }), 404, "room_not_found");
    const first = await createNamed(players[0], name);
    assert.equal(first.size, 1);
    const found = await eventually(() => rpc(players[1].player, "core.room_find", { code: name.split(":")[1].toLowerCase() }));
    assert.equal(found.match_id, first.match_id);
    assert.equal(found.players, 1);
    assert.ok(!first.presences || first.presences.length === 0, "the first player sees an empty room and hosts");
    const second = await createNamed(players[1], name);
    assert.equal(second.match_id, first.match_id);
    assert.equal(second.presences.length, 1);
    const third = await createNamed(players[2], name);
    // The bridge sends straight to chosen presences; only they receive it.
    players[0].send({
      match_data_send: { match_id: first.match_id, op_code: "9002", data: Buffer.from("secret").toString("base64"), presences: [third.self] },
    });
    const got = await players[2].next((m) => m.match_data && m.match_data.op_code === "9002");
    assert.equal(Buffer.from(got.match_data.data, "base64").toString(), "secret");
    await players[1].nothing((m) => m.match_data);
    for (const s of players) s.close();
  });
  await step("full graveyard-hollow rooms refuse an 11th player", async () => {
    const name = "graveyard-hollow:" + code();
    const sockets = [];
    for (let i = 0; i < 10; i++) {
      const s = await new Socket(await login("graveyard-hollow", "0.1.0")).connect();
      await createNamed(s, name);
      sockets.push(s);
    }
    const late = await new Socket(await login("graveyard-hollow", "0.1.0")).connect();
    await assert.rejects(createNamed(late, name), /room_full/);
    for (const s of [...sockets, late]) s.close();
  });
  await step("the matchmaker gives graveyard-hollow players a bridge room", async () => {
    const p1 = await new Socket(await login("graveyard-hollow", "0.1.0")).connect();
    const p2 = await new Socket(await login("graveyard-hollow", "0.1.0")).connect();
    await p1.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    await p2.request({ matchmaker_add: { min_count: 2, max_count: 2, query: "*" } });
    const m1 = await p1.next((m) => m.matchmaker_matched, 20000);
    const m2 = await p2.next((m) => m.matchmaker_matched, 20000);
    assert.ok(m1.matchmaker_matched.token && !m1.matchmaker_matched.match_id, "a relayed match token");
    const j1 = await p1.request({ match_join: { token: m1.matchmaker_matched.token } });
    const j2 = await p2.request({ match_join: { token: m2.matchmaker_matched.token } });
    assert.equal(j1.match.match_id, j2.match.match_id);
    assert.ok(j1.match.match_id.endsWith("."), "relayed match");
    p1.close();
    p2.close();
  });
  await step("graveyard-hollow hosts report rounds into stats and leaderboards", async () => {
    const name = "graveyard-hollow:" + code();
    const players = [];
    const sockets = [];
    let matchId = "";
    for (let i = 0; i < 4; i++) {
      const p = await login("graveyard-hollow", "0.1.0");
      const s = await new Socket(p).connect();
      matchId = (await createNamed(s, name)).match_id;
      players.push(p);
      sockets.push(s);
    }
    const host = players[0];
    const report = {
      match_id: matchId,
      round: 1,
      winner: "hollow",
      players: players.map((p, i) => ({ user_id: p.userId, team: i === 3 ? "hollow" : "village", survived: i !== 1 })),
    };
    await expectError(rpc(players[1], "graveyard-hollow.round_report", report), 403, "not_host");
    const res = await rpc(host, "graveyard-hollow.round_report", report);
    assert.equal(res.recorded, 4);
    await expectError(rpc(host, "graveyard-hollow.round_report", report), 409, "already_reported");
    const outsider = await login("graveyard-hollow", "0.1.0");
    await expectError(
      rpc(host, "graveyard-hollow.round_report", { ...report, round: 2, players: [{ user_id: outsider.userId, team: "village" }] }),
      400,
      "not_in_room",
    );
    const stats = await http("POST", "/v2/storage", {
      token: players[1].token,
      body: { object_ids: [{ collection: "graveyard-hollow.stats", key: "stats", user_id: players[3].userId }] },
    });
    const v = JSON.parse(stats.objects[0].value);
    assert.equal(v.rounds, 1);
    assert.equal(v.hollow_wins, 1);
    const board = await http("GET", `/v2/leaderboard/graveyard-hollow.wins?owner_ids=${players[3].userId}`, { token: host.token });
    assert.equal(Number(board.owner_records[0].score), 1);
    for (const s of sockets) s.close();
  });
  await step("foam-frenzy hosts report matches into stats and leaderboards", async () => {
    const name = "foam-frenzy:" + code();
    const players = [];
    const sockets = [];
    let matchId = "";
    for (let i = 0; i < 2; i++) {
      const p = await login("foam-frenzy", "0.1.0");
      const s = await new Socket(p).connect();
      matchId = (await createNamed(s, name)).match_id;
      players.push(p);
      sockets.push(s);
    }
    const host = players[0];
    const report = {
      match_id: matchId,
      round: 1,
      mode: "ffa",
      players: [
        { user_id: players[0].userId, tags: 6, outs: 2, captures: 0, won: true },
        { user_id: players[1].userId, tags: 2, outs: 6, captures: 0, won: false },
      ],
    };
    await expectError(rpc(players[1], "foam-frenzy.match_report", report), 403, "not_host");
    await expectError(rpc(host, "foam-frenzy.match_report", { ...report, mode: "golf" }), 400);
    const twoWinners = { ...report, players: report.players.map((p) => ({ ...p, won: true })) };
    await expectError(rpc(host, "foam-frenzy.match_report", twoWinners), 400, "too_many_winners");
    assert.equal((await rpc(host, "foam-frenzy.match_report", report)).recorded, 2);
    await expectError(rpc(host, "foam-frenzy.match_report", report), 409, "already_reported");
    const gh = await login("graveyard-hollow", "0.1.0");
    await expectError(rpc(gh, "foam-frenzy.match_report", report), 403, "wrong_game");
    const stats = await http("POST", "/v2/storage", {
      token: players[1].token,
      body: { object_ids: [{ collection: "foam-frenzy.stats", key: "stats", user_id: host.userId }] },
    });
    const v = JSON.parse(stats.objects[0].value);
    assert.equal(v.ffa_wins, 1);
    assert.equal(v.tags, 6);
    const board = await http("GET", `/v2/leaderboard/foam-frenzy.tags?owner_ids=${host.userId}`, { token: host.token });
    assert.equal(Number(board.owner_records[0].score), 6);
    for (const s of sockets) s.close();
  });

  // Account lifecycle.
  await step("players can export and delete their account", async () => {
    const exported = await rpc(c, "core.account_export");
    assert.equal(exported.account.user.id, c.userId);
    await expectError(rpc(c, "core.account_delete", {}), 400, "confirm_required");
    await rpc(c, "core.account_delete", { confirm: "DELETE" });
    await expectError(login("sandbox", "1.2.0", { deviceId: c.deviceId, create: false }), 404);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
