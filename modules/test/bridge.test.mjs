import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { load, logger, fakeNk, ctx } from "./harness.mjs";

const g = load();

// Reference UUIDv5 (RFC 4122) built on node:crypto.
function uuidv5dns(name) {
  const ns = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const b = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

test("sha1 matches node:crypto", () => {
  const inputs = ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)];
  for (let i = 0; i < 20; i++) inputs.push(randomBytes(i * 7).toString("base64"));
  for (const s of inputs) {
    const ours = g.Sha256.hex(g.Sha1.digest(g.Sha256.utf8(s)));
    assert.equal(ours, createHash("sha1").update(s, "utf8").digest("hex"), JSON.stringify(s));
  }
});

test("named room ids match Nakama's UUIDv5 of the name", () => {
  // Seen from a real Nakama 3.41 server: match_create {name: "sandbox:ABC123"}.
  assert.equal(g.Uuid.v5dns("sandbox:ABC123"), "2ddf53e4-f790-5755-a7d4-1459a9e89c04");
  for (const name of ["graveyard-hollow:QX7K2M", "a", "ランプ:Ü"]) {
    assert.equal(g.Uuid.v5dns(name), uuidv5dns(name));
  }
});

// A fake relayed-match presence stream, keyed by match uuid.
function bridgeNk() {
  const nk = fakeNk();
  const rooms = new Map();
  nk.streamUserList = (stream) => {
    assert.equal(stream.mode, 5);
    return rooms.get(stream.subject) || [];
  };
  nk.join = (name, userId) => {
    const uuid = uuidv5dns(name);
    const list = rooms.get(uuid) || [];
    list.push({ userId, sessionId: randomUUID(), username: userId, node: "n" });
    rooms.set(uuid, list);
    return uuid + ".";
  };
  return nk;
}

const GRAVEYARD = { game: "graveyard-hollow", version: "0.1.0" };
const SANDBOX_ENV = { GAME_SANDBOX_ENABLED: "true" };

function create(nk, name, userId, vars = GRAVEYARD) {
  const envelope = { matchCreate: name === undefined ? {} : { name } };
  return g.beforeMatchCreate(ctx(vars, { userId, env: SANDBOX_ENV }), logger, nk, envelope);
}

function join(nk, matchJoin, userId, vars = GRAVEYARD) {
  return g.beforeMatchJoin(ctx(vars, { userId, env: SANDBOX_ENV }), logger, nk, { matchJoin });
}

function reason(fn) {
  try {
    fn();
  } catch (err) {
    return String(err.message).split(":")[0];
  }
  return "ok";
}

test("bridge rooms must be named for the session's game", () => {
  const nk = bridgeNk();
  assert.equal(reason(() => create(nk, undefined, "u1")), "bad_room_name");
  assert.equal(reason(() => create(nk, "sandbox:ABCD12", "u1")), "bad_room_name");
  assert.equal(reason(() => create(nk, "graveyard-hollow:abc123", "u1")), "bad_room_name");
  assert.equal(reason(() => create(nk, "graveyard-hollow:AB", "u1")), "bad_room_name");
  assert.equal(reason(() => create(nk, "graveyard-hollow:QX7K2M", "u1")), "ok");
  // Relay-room games use core.room_create instead.
  assert.equal(reason(() => create(nk, "sandbox:ABCD12", "u1", { game: "sandbox", version: "1.2.0" })), "use_room_rpcs");
});

test("the first player in a named room is remembered as its host", () => {
  const nk = bridgeNk();
  create(nk, "graveyard-hollow:QX7K2M", "host");
  const matchId = nk.join("graveyard-hollow:QX7K2M", "host");
  create(nk, "graveyard-hollow:QX7K2M", "guest");
  nk.join("graveyard-hollow:QX7K2M", "guest");

  const game = g.Registry.find(ctx(GRAVEYARD), "graveyard-hollow");
  const roster = g.Rooms.roster(nk, game, matchId);
  assert.equal(roster.host, "host");
  assert.deepEqual(Array.from(roster.members), ["host", "guest"]);
});

test("full bridge rooms refuse newcomers but let players back in", () => {
  const nk = bridgeNk();
  const name = "graveyard-hollow:FULL01";
  for (let i = 0; i < 10; i++) {
    create(nk, name, "p" + i);
    nk.join(name, "p" + i);
  }
  assert.equal(reason(() => create(nk, name, "p10")), "room_full");
  assert.equal(reason(() => create(nk, name, "p3")), "ok");
  const matchId = uuidv5dns(name) + ".";
  assert.equal(reason(() => join(nk, { matchId }, "p10")), "room_full");
  assert.equal(reason(() => join(nk, { matchId }, "p4")), "ok");
});

test("joining by id only reaches the session's own game's rooms", () => {
  const nk = bridgeNk();
  // Unknown relayed match (never opened by name on this server).
  assert.equal(reason(() => join(nk, { matchId: randomUUID() + "." }, "u1")), "room_not_found");
  // Matchmaker tokens and server-run relay rooms are checked elsewhere.
  assert.equal(reason(() => join(nk, { token: "x.y.z" }, "u1")), "ok");
  assert.equal(reason(() => join(nk, { matchId: randomUUID() + ".node1" }, "u1")), "ok");
  // A relay-room game can't wander into a bridge room.
  create(nk, "graveyard-hollow:ROOM42", "u1");
  const matchId = nk.join("graveyard-hollow:ROOM42", "u1");
  assert.equal(reason(() => join(nk, { matchId }, "u2", { game: "sandbox", version: "1.2.0" })), "use_room_rpcs");
});

test("graveyard-hollow round reports in bridge rooms come from the room's host", () => {
  const nk = bridgeNk();
  const written = [];
  nk.leaderboardRecordWrite = (id, owner) => {
    written.push(`${id}/${owner}`);
    return {};
  };
  nk.usersGetId = (ids) => ids.map((userId) => ({ userId, username: userId }));
  nk.storageList = () => ({ objects: [] });
  const name = "graveyard-hollow:ROUND1";
  for (const u of ["host", "a", "b", "c"]) {
    create(nk, name, u);
    nk.join(name, u);
  }
  const matchId = uuidv5dns(name) + ".";
  const report = (userId, players) =>
    g.rpcGraveyardHollowRoundReport(
      ctx(GRAVEYARD, { userId }),
      logger,
      nk,
      JSON.stringify({ match_id: matchId, round: 1, winner: "hollow", players }),
    );
  const players = [
    { user_id: "host", team: "village", survived: true },
    { user_id: "a", team: "hollow", survived: true },
    { user_id: "b", team: "village", survived: false },
  ];
  assert.equal(reason(() => report("a", players)), "not_host");
  assert.equal(reason(() => report("host", [...players, { user_id: "stranger", team: "village" }])), "not_in_room");
  assert.equal(reason(() => report("host", players)), "ok");
  assert.deepEqual(written.sort(), ["graveyard-hollow.wins/a", "graveyard-hollow.wins_weekly/a"]);
  assert.equal(reason(() => report("host", players)), "already_reported");
});
