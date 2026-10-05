import { test } from "node:test";
import assert from "node:assert/strict";
import { load, logger, fakeNk, fakeDispatcher, presence, gameMessage, controlMessage } from "./harness.mjs";

const g = load();
const OP = g.Relay.OP;

// A broadcast-mode game, only for these tests.
g.Registry.GAMES.push({
  ...g.GAME_SANDBOX,
  id: "party",
  enabledByDefault: true,
  rooms: { minPlayers: 2, maxPlayers: 3, tickRate: 10, mode: "broadcast", matchmaking: false, hostGraceSec: 5 },
});

function room(game, params = {}) {
  const nk = fakeNk();
  const d = fakeDispatcher();
  const env = { GAME_SANDBOX_ENABLED: "true" };
  const init = g.relayMatchInit({ env }, logger, nk, { game, code: "ABCDEF", ...params });
  let state = init.state;
  let tick = 0;
  const ctxFor = (p, gameId = game) => ({ env, userId: p.userId, vars: { game: gameId, version: "1.2.0" } });
  const r = {
    nk,
    d,
    get state() {
      return state;
    },
    attempt(p, gameId) {
      const res = g.relayMatchJoinAttempt(ctxFor(p, gameId), logger, nk, d, tick, state, p, {});
      state = res.state;
      return res;
    },
    join(p) {
      const res = r.attempt(p);
      assert.ok(res.accept, `join refused: ${res.rejectMessage}`);
      state = g.relayMatchJoin({ env }, logger, nk, d, tick, state, [p]).state;
    },
    leave(p) {
      state = g.relayMatchLeave({ env }, logger, nk, d, tick, state, [p]).state;
    },
    loop(messages = [], ticks = 1) {
      let res = { state };
      for (let i = 0; i < ticks && res; i++) {
        tick++;
        res = g.relayMatchLoop({ env }, logger, nk, d, tick, state, i === 0 ? messages : []);
        if (res) state = res.state;
      }
      return res;
    },
    signal(body) {
      return JSON.parse(g.relayMatchSignal({ env }, logger, nk, d, tick, state, JSON.stringify(body)).data);
    },
  };
  return r;
}

const ofOp = (sent, op) => sent.filter((m) => m.op === op);

test("the reserved host takes the role when they arrive", () => {
  const r = room("sandbox", { host: "user-1" });
  r.join(presence(2));
  let welcome = JSON.parse(ofOp(r.d.take(), OP.WELCOME)[0].data);
  assert.equal(welcome.host_slot, 0, "nobody is host yet");
  r.join(presence(1));
  const sent = r.d.take();
  welcome = JSON.parse(ofOp(sent, OP.WELCOME)[0].data);
  assert.equal(welcome.host_slot, welcome.slot);
  assert.equal(ofOp(sent, OP.HOST).length, 1);
});

test("join attempts enforce game, size, invitations and kicks", () => {
  const r = room("sandbox", { max_players: 2, allowed: "user-1,user-2,user-3" });
  assert.equal(r.attempt(presence(1), "lantern-out").rejectMessage, "wrong_game");
  assert.equal(r.attempt(presence(9)).rejectMessage, "not_invited");
  r.join(presence(1));
  r.join(presence(2));
  assert.equal(r.attempt(presence(3)).rejectMessage, "room_full");
  // The same player on a new session is still let in.
  assert.ok(r.attempt({ ...presence(2), sessionId: "session-2b" }).accept);
});

test("a reconnecting player keeps their slot and replaces the old session", () => {
  const r = room("sandbox");
  r.join(presence(1));
  r.join(presence(2));
  const slot = r.state.slots["user-2"];
  r.d.take();
  r.join({ ...presence(2), sessionId: "session-2b" });
  assert.deepEqual(r.d.kicked, ["session-2"]);
  assert.equal(r.state.slots["user-2"], slot);
  assert.equal(Object.keys(r.state.players).length, 2);
  const joined = JSON.parse(ofOp(r.d.take(), OP.PEER_JOINED)[0].data);
  assert.equal(joined.rejoined, true);
  // The old session's leave event must not remove the new one.
  r.leave(presence(2));
  assert.equal(Object.keys(r.state.players).length, 2);
});

test("host mode: the room waits for the host, then closes", () => {
  const r = room("sandbox");
  const [p1, p2] = [presence(1), presence(2)];
  r.join(p1);
  r.join(p2);
  r.d.take();
  r.leave(p1);
  const host = JSON.parse(ofOp(r.d.take(), OP.HOST)[0].data);
  assert.equal(host.away, true);
  // Messages to an absent host are dropped.
  r.loop([gameMessage(p2, 100, [], "hello")]);
  assert.equal(ofOp(r.d.take(), 100).length, 0);
  // The host comes back within the grace period and keeps the role.
  r.join(p1);
  assert.equal(r.state.hostUserId, "user-1");
  assert.equal(r.state.hostAwaySince, -1);
  r.leave(p1);
  assert.equal(r.loop([], 5 * 10 + 1), null, "the room ends after hostGraceSec");
  assert.equal(JSON.parse(ofOp(r.d.take(), OP.CLOSING)[0].data).reason, "host_left");
});

test("broadcast mode: anyone can message anyone and the host role moves", () => {
  const r = room("party");
  const [p1, p2, p3] = [presence(1), presence(2), presence(3)];
  r.join(p1);
  r.join(p2);
  r.join(p3);
  r.d.take();
  r.loop([gameMessage(p2, 100, [r.state.slots["user-3"]], "psst")]);
  const sent = r.d.take();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.map((m) => [m.op, m.to, m.data, m.from]))), [[100, ["session-3"], "psst", "session-2"]]);
  r.loop([gameMessage(p3, 101, [], "all")]);
  assert.deepEqual(Array.from(r.d.take()[0].to).sort(), ["session-1", "session-2"]);
  r.leave(p1);
  assert.equal(r.state.hostUserId, "user-2");
  assert.equal(JSON.parse(ofOp(r.d.take(), OP.HOST)[0].data).host_slot, r.state.slots["user-2"]);
});

test("game messages need the target header", () => {
  const r = room("party");
  const p1 = presence(1);
  r.join(p1);
  r.d.take();
  const empty = { ...gameMessage(p1, 100, [], ""), data: new ArrayBuffer(0) };
  const short = { ...empty, data: Uint8Array.from([3, 1]).buffer };
  r.loop([empty, short]);
  assert.equal(ofOp(r.d.take(), OP.ERROR).length, 2);
});

test("host controls: room settings, kicks and closing", () => {
  const r = room("sandbox");
  const [p1, p2] = [presence(1), presence(2)];
  r.join(p1);
  r.join(p2);
  r.d.take();
  r.loop([controlMessage(p1, OP.SET_ROOM, { locked: true, listed: true, meta: { map: "village", round: 2 } })]);
  assert.equal(JSON.parse(r.d.labels.at(-1)).open, false);
  assert.equal(JSON.parse(ofOp(r.d.take(), OP.ROOM)[0].data).meta.map, "village");
  r.loop([controlMessage(p1, OP.SET_ROOM, { meta: { "Bad Key": 1 } })]);
  assert.equal(ofOp(r.d.take(), OP.ERROR).length, 1);
  assert.equal(r.attempt(presence(3)).rejectMessage, "room_locked");
  r.loop([controlMessage(p1, OP.KICK, { slot: r.state.slots["user-2"] })]);
  assert.deepEqual(r.d.kicked, ["session-2"]);
  assert.equal(r.attempt(p2).rejectMessage, "kicked");
  assert.equal(r.loop([controlMessage(p1, OP.CLOSE, {})]), null);
});

test("the roster signal reports everyone who joined", () => {
  const r = room("sandbox");
  r.join(presence(1));
  r.join(presence(2));
  r.leave(presence(2));
  const roster = r.signal({ op: "roster" });
  assert.equal(roster.host_user_id, "user-1");
  assert.deepEqual(Array.from(roster.present), ["user-1"]);
  assert.deepEqual(roster.seen.sort(), ["user-1", "user-2"]);
});

test("empty rooms end after a minute", () => {
  const r = room("party");
  assert.ok(r.loop([], 10 * 59));
  assert.equal(r.loop([], 10 * 2), null);
});
