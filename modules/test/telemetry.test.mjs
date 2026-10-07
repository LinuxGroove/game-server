import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, logger, fakeNk, fakeDispatcher, presence, controlMessage } from "./harness.mjs";

const g = load();
const M = g.Telemetry.METRIC;
const env = { GAME_SANDBOX_ENABLED: "true" };

function login(nk, vars, { userId = "u1", method = "device", created = false } = {}) {
  const fn = { device: g.afterAuthenticateDevice, custom: g.afterAuthenticateCustom }[method];
  fn({ env, userId, vars }, logger, nk, { created }, { account: { id: "dev", vars } });
}

test("every metric is always written with the same tag keys", () => {
  // Prometheus refuses a metric name registered with different label sets.
  const bundle = readFileSync(new URL("../build/index.js", import.meta.url), "utf8");
  const calls = bundle.matchAll(/count\(nk, (?:Telemetry\.)?METRIC\.([A-Z_]+), (\{[^}]*\}|game)/g);
  const keysOf = {};
  let n = 0;
  for (const [, name, tags] of calls) {
    const keys = tags === "game" ? "game" : [...tags.matchAll(/(\w+):/g)].map((m) => m[1]).sort().join(",");
    keysOf[name] ??= keys;
    assert.equal(keys, keysOf[name], `${name} is written with {${keys}} and {${keysOf[name]}}`);
    n++;
  }
  assert.ok(n >= 20, `found only ${n} counter calls`);
  for (const name of Object.keys(keysOf)) {
    assert.ok(name in M, name);
  }
});

test("logins are counted per game, version, platform and method", () => {
  const nk = fakeNk();
  login(nk, { game: "sandbox", version: "1.2.0", platform: "ubuntu" }, { created: true });
  login(nk, { game: "sandbox", version: "1.2.0", platform: "commodore64" }, { userId: "u2", method: "custom" });
  login(nk, { game: "sandbox", version: "1.2.0" }, { userId: "u3" });
  assert.equal(nk.counter(M.LOGINS, { game: "sandbox", version: "1.2.0" }), 3);
  assert.equal(nk.counter(M.LOGINS, { platform: "ubuntu", method: "device", new: "true" }), 1);
  assert.equal(nk.counter(M.LOGINS, { platform: "other", method: "custom", new: "false" }), 1);
  assert.equal(nk.counter(M.LOGINS, { platform: "unknown" }), 1);
});

test("client versions can't create unlimited labels", () => {
  const nk = fakeNk();
  const labels = [];
  for (let i = 0; i < 40; i++) {
    labels.push(g.Telemetry.versionLabel(nk, "sandbox", "1.0." + i));
  }
  assert.equal(new Set(labels).size, g.Telemetry.MAX_VERSIONS + 1);
  assert.equal(labels[39], "other");
  assert.equal(g.Telemetry.versionLabel(nk, "sandbox", "1.0.3"), "1.0.3", "already-seen versions keep their label");
  assert.equal(g.Telemetry.versionLabel(nk, "sandbox", "not a version"), "unknown");
  assert.equal(g.Telemetry.versionLabel(nk, "graveyard-hollow", "1.0.39"), "1.0.39", "the limit is per game");
});

test("daily actives, new players and retention count once per player per day", () => {
  const nk = fakeNk();
  const days = ["2026-10-01", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-08", "2026-10-31"];
  for (const day of days) {
    g.Telemetry.activity(nk, "sandbox", "u1", day);
  }
  g.Telemetry.activity(nk, "graveyard-hollow", "u1", "2026-10-02");
  assert.equal(nk.counter(M.ACTIVE_PLAYERS, { game: "sandbox" }), 5, "the second login on 10-01 isn't a new day");
  assert.equal(nk.counter(M.NEW_PLAYERS, { game: "sandbox" }), 1);
  assert.equal(nk.counter(M.NEW_PLAYERS, { game: "graveyard-hollow" }), 1, "new to each game separately");
  assert.equal(nk.counter(M.RETURNING_PLAYERS, { day: "d1" }), 1);
  assert.equal(nk.counter(M.RETURNING_PLAYERS, { day: "d7" }), 1);
  assert.equal(nk.counter(M.RETURNING_PLAYERS, { day: "d30" }), 1);
  assert.equal(nk.counter(M.RETURNING_PLAYERS), 3, "day 4 is not a retention day");
  const obj = nk.storage.get("core.activity/sandbox/u1");
  assert.deepEqual({ ...obj.value }, { first: "2026-10-01", last: "2026-10-31" });
  assert.equal(obj.permissionRead, 0, "activity is private to the server");
});

test("rejected logins are counted by reason and still rejected", () => {
  const nk = fakeNk();
  const tries = [
    [{ game: "sandbox", version: "0.0.1" }, "update_required"],
    [{ game: "no-such-game", version: "1.0.0" }, "unknown_game"],
    [{ version: "1.0.0" }, "missing_game"],
  ];
  for (const [vars, reason] of tries) {
    assert.throws(
      () => g.beforeAuthenticateDevice({ env }, logger, nk, { account: { id: "dev", vars } }),
      (e) => e.message.startsWith(reason),
    );
  }
  assert.equal(nk.counter(M.LOGINS_REJECTED, { game: "sandbox", reason: "update_required" }), 1);
  assert.equal(nk.counter(M.LOGINS_REJECTED, { game: "unknown", reason: "unknown_game" }), 1);
  assert.equal(nk.counter(M.LOGINS_REJECTED, { game: "unknown", reason: "missing_game" }), 1);
  assert.equal(nk.counter(M.LOGINS), 0);
});

test("telemetry never breaks a game when metrics or storage fail", () => {
  const nk = fakeNk();
  nk.metricsCounterAdd = () => {
    throw new Error("metrics down");
  };
  nk.storageRead = () => {
    throw new Error("database down");
  };
  login(nk, { game: "sandbox", version: "1.2.0" });
});

test("a finished relay room is counted with its reason, length and players", () => {
  const nk = fakeNk();
  const d = fakeDispatcher();
  const init = g.relayMatchInit({ env }, logger, nk, { game: "sandbox", code: "ABCDEF", host: "user-1" });
  let state = init.state;
  const rate = init.tickRate;
  const players = [presence(1), presence(2), presence(3)];
  state = g.relayMatchJoin({ env }, logger, nk, d, 0, state, players).state;
  const tick = 90 * rate;
  const res = g.relayMatchLoop({ env }, logger, nk, d, tick, state, [controlMessage(players[0], g.Relay.OP.CLOSE, {})]);
  assert.equal(res, null);
  assert.equal(nk.counter(M.ROOMS_CLOSED, { game: "sandbox", reason: "closed_by_host" }), 1);
  assert.equal(nk.counter(M.ROOM_SECONDS, { game: "sandbox" }), 90);
  assert.equal(nk.counter(M.ROOM_PLAYERS, { game: "sandbox" }), 3);
});

test("per-game counters start at 0 so the first event of the day is counted", () => {
  const nk = fakeNk();
  g.Telemetry.init({ env: {} }, nk);
  const started = nk.metrics.filter((m) => m.tags.game === "graveyard-hollow").map((m) => m.name + (m.tags.day || ""));
  assert.ok(started.includes(M.ACTIVE_PLAYERS) && started.includes(M.NEW_PLAYERS), started.join(", "));
  assert.ok(started.includes(M.RETURNING_PLAYERS + "d30"));
  assert.ok(nk.metrics.every((m) => m.delta === 0));
  assert.ok(!nk.metrics.some((m) => m.tags.game === "sandbox"), "disabled games are left out");
});
