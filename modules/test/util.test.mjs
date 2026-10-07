import { test } from "node:test";
import assert from "node:assert/strict";
import { load, fakeNk, ctx } from "./harness.mjs";

const g = load();

test("versions compare numerically and ignore pre-release tags", () => {
  assert.equal(g.Util.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(g.Util.compareVersions("1.2", "1.2.0"), 0);
  assert.equal(g.Util.compareVersions("0.1.0-beta.2", "0.1.0"), 0);
  assert.equal(g.Util.compareVersions("0.0.9", "0.1.0"), -1);
  assert.ok(g.Util.isVersion("1.2.3-rc.1"));
  assert.ok(!g.Util.isVersion("latest"));
});

test("room and share codes avoid look-alike characters", () => {
  const nk = fakeNk();
  for (let i = 0; i < 200; i++) {
    const code = g.Util.randomCode(nk, 6);
    assert.match(code, /^[2-9A-HJKMNP-TV-Z]{6}$/);
    assert.ok(g.Util.isCode(code, 6));
  }
  assert.equal(g.Util.normaliseCode(" ab-c 12 "), "ABC12");
  assert.ok(!g.Util.isCode("ABCDE0", 6));
});

test("byte length matches UTF-8", () => {
  for (const s of ["", "abc", "é", "ランプ", "🎮🎮", "mixed é 🎮 text"]) {
    assert.equal(g.Util.byteLength(s), Buffer.byteLength(s, "utf8"), s);
  }
});

test("the shipped game registry is valid", () => {
  assert.deepEqual(Array.from(g.Registry.validateAll()), []);
  const ids = Array.from(g.Registry.GAMES, (x) => x.id);
  assert.ok(ids.includes("graveyard-hollow"), ids.join(", "));
  assert.ok(ids.includes("foam-frenzy"), ids.join(", "));
  assert.ok(ids.includes("sandbox"), ids.join(", "));
});

test("registry validation catches bad game definitions", () => {
  const bad = { ...g.GAME_SANDBOX, id: "core", leaderboards: [{ ...g.GAME_SANDBOX.leaderboards[0], minScore: 10, maxScore: 1 }] };
  g.Registry.GAMES.push(bad);
  try {
    const errors = g.Registry.validateAll();
    assert.ok(errors.some((e) => e.includes("reserved")));
    assert.ok(errors.some((e) => e.includes("minScore")));
  } finally {
    g.Registry.GAMES.pop();
  }
});

test("per-server env overrides enable games and raise the minimum version", () => {
  const off = ctx({ game: "sandbox", version: "1.0.0" });
  assert.equal(g.Registry.find(off, "sandbox"), null, "sandbox is off by default");
  const on = ctx({ game: "sandbox", version: "1.0.0" }, { env: { GAME_SANDBOX_ENABLED: "true", GAME_SANDBOX_MIN_VERSION: "1.1.0" } });
  assert.equal(g.Registry.find(on, "sandbox").id, "sandbox");
  assert.throws(() => g.Auth.checkVars(on, { game: "sandbox", version: "1.0.0" }), (e) => e.code === 9 && /^update_required/.test(e.message));
  g.Auth.checkVars(on, { game: "sandbox", version: "1.1.0" });
  assert.throws(() => g.Auth.checkVars(on, { game: "sandbox", version: "1.1.0", extra: "x" }), (e) => /^bad_vars/.test(e.message));
});

test("rate limits refuse calls past the limit", () => {
  const nk = fakeNk();
  for (let i = 0; i < 3; i++) g.RateLimit.check(nk, "u1", "test", 3, 60);
  assert.throws(() => g.RateLimit.check(nk, "u1", "test", 3, 60), (e) => e.code === 8);
  g.RateLimit.check(nk, "u2", "test", 3, 60);
});

test("matchmaker tickets are pinned to the session's game", () => {
  const msg = { query: "+properties.mode:ranked", stringProperties: { mode: "ranked" }, minCount: 2, maxCount: 99 };
  g.Rooms.tagTicket(g.GAME_GRAVEYARD_HOLLOW, msg);
  assert.equal(msg.query, "+properties.game:graveyard-hollow +properties.mode:ranked");
  assert.equal(msg.stringProperties.game, "graveyard-hollow");
  assert.equal(msg.maxCount, 10);
  const any = { query: "*", stringProperties: null, minCount: 4, maxCount: 4 };
  g.Rooms.tagTicket(g.GAME_GRAVEYARD_HOLLOW, any);
  assert.equal(any.query, "+properties.game:graveyard-hollow");
});

test("optimistic storage updates retry on conflicts", () => {
  const nk = fakeNk();
  const write = nk.storageWrite;
  let failures = 1;
  nk.storageWrite = (objs) => {
    if (failures-- > 0) throw new Error("version conflict");
    return write(objs);
  };
  const v = g.Objects.update(nk, "c", "k", "u", 1, (cur) => ({ n: (cur ? cur.n : 0) + 1 }));
  assert.equal(v.n, 1);
  const v2 = g.Objects.update(nk, "c", "k", "u", 1, (cur) => ({ n: (cur ? cur.n : 0) + 1 }));
  assert.equal(v2.n, 2);
});

test("graveyard-hollow stats accumulate per team", () => {
  let s = g.GraveyardHollow.addRound(null, "village", true, true);
  s = g.GraveyardHollow.addRound(s, "hollow", false, false);
  assert.deepEqual({ ...s }, { rounds: 2, wins: 1, village_rounds: 1, village_wins: 1, hollow_rounds: 1, hollow_wins: 0, survived: 1 });
});

test("foam-frenzy stats accumulate per mode", () => {
  let s = g.FoamFrenzy.addMatch(null, "ffa", { tags: 7, outs: 3, captures: 0, won: true });
  s = g.FoamFrenzy.addMatch(s, "ctf", { tags: 2, outs: 5, captures: 1, won: false });
  assert.deepEqual(
    { ...s },
    { matches: 2, wins: 1, ffa_matches: 1, ffa_wins: 1, ctf_matches: 1, ctf_wins: 0, tags: 9, outs: 8, captures: 1 },
  );
});

test("foam-frenzy match reports reject impossible players", () => {
  const ok = g.FoamFrenzy.parsePlayers([{ user_id: "a", tags: 3, won: true }, { user_id: "b" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), [
    { user_id: "a", tags: 3, outs: 0, captures: 0, won: true },
    { user_id: "b", tags: 0, outs: 0, captures: 0, won: false },
  ]);
  assert.throws(() => g.FoamFrenzy.parsePlayers([]), (e) => /players must list/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers([{ user_id: "a" }, { user_id: "a" }]), (e) => /duplicate/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers([{ user_id: "a", tags: 100000 }]), (e) => /tags must be between/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers(Array.from({ length: 9 }, (_, i) => ({ user_id: "u" + i }))), (e) => /1 to 8/.test(e.message));
});
