import { test } from "node:test";
import assert from "node:assert/strict";
import { load, logger, fakeNk, ctx } from "./harness.mjs";

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
  assert.ok(ids.includes("race-day"), ids.join(", "));
  assert.ok(ids.includes("burn-rate"), ids.join(", "));
  assert.ok(ids.includes("all-city"), ids.join(", "));
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

test("game versions: YYYY.WW.MINOR releases and edge builds sign in", () => {
  const vars = (version) => ({ game: "graveyard-hollow", version });
  const c = ctx(vars("2026.41.0"));
  for (const v of ["2026.41.0", "2026.41.12", "2026.41.0+3.g1a2b3c4d", "2026.1.0+120.g0badcafe"]) {
    g.Auth.checkVars(c, vars(v));
  }
  for (const v of ["v2026.41.0", "2026.41.0-3-g1a2b3c4d x", "2026.41.0+" + "x".repeat(30)]) {
    assert.throws(() => g.Auth.checkVars(c, vars(v)), (e) => /^bad_(version|vars)/.test(e.message), v);
  }
  // Build metadata doesn't count when comparing; weeks compare as numbers.
  assert.equal(g.Util.compareVersions("2026.41.0+3.g1a2b3c4d", "2026.41.0"), 0);
  assert.equal(g.Util.compareVersions("2026.9.0", "2026.41.0"), -1);
  assert.equal(g.Util.compareVersions("2027.1.0", "2026.52.3"), 1);
  assert.equal(g.Util.compareVersions("2026.41.0", "0.1.0"), 1, "new versions pass the old 0.1.0 minimum");
});

test("rate limits refuse calls past the limit", () => {
  const nk = fakeNk();
  for (let i = 0; i < 3; i++) g.RateLimit.check(nk, "u1", "test", 3, 60);
  assert.throws(() => g.RateLimit.check(nk, "u1", "test", 3, 60), (e) => e.code === 8);
  g.RateLimit.check(nk, "u2", "test", 3, 60);
  // allow() counts the same way, answering instead of refusing.
  assert.equal(g.RateLimit.allow(nk, "u3", "test", 1, 60), true);
  assert.equal(g.RateLimit.allow(nk, "u3", "test", 1, 60), false);
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
  const ok = g.FoamFrenzy.parsePlayers([{ user_id: "a", tags: 3, won: true }, { user_id: "b" }], "ffa");
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), [
    { user_id: "a", tags: 3, outs: 0, captures: 0, won: true },
    { user_id: "b", tags: 0, outs: 0, captures: 0, won: false },
  ]);
  assert.throws(() => g.FoamFrenzy.parsePlayers([], "ffa"), (e) => /players must list/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers([{ user_id: "a" }, { user_id: "a" }], "ffa"), (e) => /duplicate/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers([{ user_id: "a", tags: 100000 }], "ffa"), (e) => /tags must be between/.test(e.message));
  assert.throws(() => g.FoamFrenzy.parsePlayers(Array.from({ length: 9 }, (_, i) => ({ user_id: "u" + i })), "ffa"), (e) => /1 to 8/.test(e.message));
  // One winner in free-for-all and Dart Hoarder; a whole team in the others.
  const two = [{ user_id: "a", won: true }, { user_id: "b", won: true }];
  for (const mode of ["ffa", "hoarder"]) {
    assert.throws(() => g.FoamFrenzy.parsePlayers(two, mode), (e) => /too_many_winners/.test(e.message), mode);
  }
  for (const mode of ["teams", "ctf"]) {
    assert.equal(g.FoamFrenzy.parsePlayers(two, mode).length, 2, mode);
  }
  // Flag captures only count in Capture the Flag.
  const capper = [{ user_id: "a", captures: 3 }];
  assert.equal(g.FoamFrenzy.parsePlayers(capper, "ctf")[0].captures, 3);
  assert.equal(g.FoamFrenzy.parsePlayers(capper, "teams")[0].captures, 0);
});

test("race-day has a Time Trial board for every layout", () => {
  const boards = Array.from(g.GAME_RACE_DAY.leaderboards, (b) => ({ ...b }));
  const laps = boards.filter((b) => b.id.startsWith("lap_"));
  assert.equal(laps.length, 33);
  assert.deepEqual(laps.map((b) => b.id.slice(4)), Array.from(g.RACE_DAY_LAYOUTS));
  for (const b of laps) {
    assert.deepEqual(
      { sort: b.sort, operator: b.operator, reset: b.reset, clientSubmit: b.clientSubmit, minScore: b.minScore, maxScore: b.maxScore, enableRank: b.enableRank },
      { sort: "asc", operator: "best", reset: null, clientSubmit: true, minScore: 20000, maxScore: 600000, enableRank: true },
      b.id,
    );
  }
  const counts = boards.filter((b) => !b.id.startsWith("lap_"));
  assert.deepEqual(counts.map((b) => b.id), ["wins", "wins_weekly", "podiums", "poles"]);
  assert.ok(counts.every((b) => !b.clientSubmit && b.operator === "incr"));
  assert.equal(counts.find((b) => b.id === "wins_weekly").reset, "0 0 * * 1");
});

test("race-day Time Trial laps go through core.score_submit", () => {
  const nk = fakeNk();
  const written = [];
  nk.leaderboardRecordWrite = (id, owner, username, score) => {
    written.push(`${id}/${owner}/${score}`);
    return { leaderboardId: id, ownerId: owner, score, subscore: 0, rank: 1, updateTime: 0 };
  };
  const RACE = ctx({ game: "race-day", version: "2026.41.0" });
  const submit = (board, score) => g.rpcScoreSubmit(RACE, logger, nk, JSON.stringify({ board, score }));
  assert.equal(JSON.parse(submit("lap_port_lumen_reverse", 83456)).record.score, 83456);
  assert.deepEqual(written, ["race-day.lap_port_lumen_reverse/u1/83456"]);
  assert.throws(() => submit("lap_port_lumen_reverse", 19999), (e) => /between 20000 and 600000/.test(e.message));
  assert.throws(() => submit("lap_nowhere", 83456), (e) => /^unknown_board/.test(e.message));
  assert.throws(() => submit("wins", 1), (e) => /^server_only/.test(e.message));
});

test("race-day stats count races, results and the best finish", () => {
  let s = g.RaceDay.addRace(null, { position: 4, won: false, podium: false, pole: true, fastest: false });
  s = g.RaceDay.addRace(s, { position: 1, won: true, podium: true, pole: false, fastest: true });
  s = g.RaceDay.addRace(s, { position: 7, won: false, podium: false, pole: false, fastest: false });
  assert.deepEqual({ ...s }, { races: 3, wins: 1, podiums: 1, poles: 1, fastest_laps: 1, best_finish: 1 });
});

test("race-day race reports reject impossible results", () => {
  const ok = g.RaceDay.parsePlayers([{ user_id: "a", position: 1, won: true, podium: true, pole: true }, { user_id: "b", position: 5 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), [
    { user_id: "a", position: 1, won: true, podium: true, pole: true, fastest: false },
    { user_id: "b", position: 5, won: false, podium: false, pole: false, fastest: false },
  ]);
  assert.throws(() => g.RaceDay.parsePlayers([]), (e) => /players must list/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a", position: 1 }, { user_id: "a", position: 2 }]), (e) => /duplicate/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a" }]), (e) => /position is required/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a", position: 21 }]), (e) => /between 1 and 20/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a", position: 0 }]), (e) => /between 1 and 20/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers(Array.from({ length: 9 }, (_, i) => ({ user_id: "u" + i, position: i + 1 }))), (e) => /1 to 8/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a", position: 2, won: true }]), (e) => /^bad_result/.test(e.message));
  assert.throws(() => g.RaceDay.parsePlayers([{ user_id: "a", position: 4, podium: true }]), (e) => /^bad_result/.test(e.message));
  // A car that retires in a podium place is classified there without the podium.
  assert.equal(g.RaceDay.parsePlayers([{ user_id: "a", position: 3, podium: false }])[0].podium, false);
  for (const flag of ["pole", "fastest"]) {
    const two = [{ user_id: "a", position: 2, [flag]: true }, { user_id: "b", position: 3, [flag]: true }];
    assert.throws(() => g.RaceDay.parsePlayers(two), (e) => /^too_many_winners/.test(e.message), flag);
  }
  assert.equal(g.RaceDay.parseCircuit("kingsfield_international"), "kingsfield_international");
  assert.equal(g.RaceDay.parseCircuit("port-lumen-reverse"), "port_lumen_reverse");
  assert.throws(() => g.RaceDay.parseCircuit("monaco"), (e) => /^unknown_circuit/.test(e.message));
});

test("burn-rate has distance boards per pace, the Daily Flight, wins and a board for every course", () => {
  const boards = Array.from(g.GAME_BURN_RATE.leaderboards, (b) => ({ ...b }));
  const ids = boards.map((b) => b.id);
  for (const pace of ["calm", "normal", "fast"]) {
    assert.ok(ids.includes("distance_" + pace), pace);
    assert.ok(ids.includes("distance_classic_" + pace), pace);
  }
  const courses = boards.filter((b) => b.id.startsWith("course_"));
  assert.equal(courses.length, 30);
  assert.ok(courses.every((b) => b.sort === "asc" && b.operator === "best" && !b.clientSubmit));
  assert.ok(ids.includes("course_lab_1") && ids.includes("course_halberd_5"));
  const daily = boards.find((b) => b.id === "daily");
  assert.equal(daily.reset, "0 0 * * *");
  assert.equal(boards.find((b) => b.id === "wins").operator, "incr");
  assert.ok(boards.every((b) => !b.clientSubmit), "every board is written by the server");
});

test("burn-rate run reports are checked and go on the right board", () => {
  const run = (extra) => g.BurnRate.parseRun({ mode: "endless", pace: "normal", lanes: true, seed: 7, distance: 1200, credits: 40, best_burn: 3, time_ms: 95000, pack: "k2", ...extra });
  assert.deepEqual({ ...g.BurnRate.boardFor(run({})) }, { board: "distance_normal", score: 1200 });
  assert.deepEqual({ ...g.BurnRate.boardFor(run({ lanes: false, pace: "fast" })) }, { board: "distance_classic_fast", score: 1200 });
  assert.deepEqual({ ...g.BurnRate.boardFor(run({ mode: "daily" })) }, { board: "daily", score: 1200 });
  assert.deepEqual({ ...g.BurnRate.boardFor(run({ mode: "course", course: "bay_3", finish_ms: 90000 })) }, { board: "course_bay_3", score: 90000 });
  assert.equal(g.BurnRate.boardFor(run({ mode: "course", course: "bay_3" })), null, "an unfinished course goes on no board");
  const why = (extra) => {
    try {
      run(extra);
    } catch (err) {
      return String(err.message).split(":")[0];
    }
    return "ok";
  };
  assert.equal(why({ mode: "party" }), "bad_mode");
  assert.equal(why({ pace: "ludicrous" }), "bad_pace");
  assert.equal(why({ pack: "k9" }), "bad_pack");
  assert.equal(why({ distance: 5000, time_ms: 60000 }), "too_fast");
  assert.equal(why({ mode: "course", course: "moon_1", finish_ms: 90000 }), "unknown_course");
  assert.equal(why({ mode: "course", course: "lab_1", finish_ms: 15000 }), "too_fast");
  assert.equal(why({ mode: "course", course: "lab_1", finish_ms: 120000 }), "bad_result");
  assert.equal(why({ best_burn: 6 }), "best_burn must be between 1 and 5");
  assert.equal(why({ time_ms: 500 }), "time_ms must be between 1000 and 36000000");
});

test("burn-rate stats count runs, metres, credits and the best distance", () => {
  const run = (extra) => g.BurnRate.parseRun({ mode: "endless", distance: 800, credits: 10, best_burn: 2, time_ms: 70000, ...extra });
  let s = g.BurnRate.addRun(null, run({}));
  s = g.BurnRate.addRun(s, run({ mode: "daily", distance: 1500, credits: 30, best_burn: 4, time_ms: 110000 }));
  s = g.BurnRate.addRun(s, run({ mode: "course", course: "lab_2", finish_ms: 60000, distance: 800, time_ms: 61000 }));
  assert.deepEqual({ ...s }, { runs: 3, metres: 3100, credits: 50, seconds: 241, best_distance: 1500, best_burn: 4, daily_runs: 1, courses_finished: 1 });
  s = g.BurnRate.addRace(s, { rounds: 4, round_wins: 3, won: true });
  assert.equal(s.races, 1);
  assert.equal(s.race_wins, 1);
  assert.equal(s.round_wins, 3);
});

test("burn-rate party reports reject impossible results", () => {
  const ok = g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 3, won: true }, { user_id: "b", round_wins: 1 }], 4);
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), [
    { user_id: "a", rounds: 4, round_wins: 3, won: true },
    { user_id: "b", rounds: 4, round_wins: 1, won: false },
  ]);
  assert.throws(() => g.BurnRate.parsePlayers([], 3), (e) => /players must list/.test(e.message));
  assert.throws(() => g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 1 }, { user_id: "a", round_wins: 1 }], 3), (e) => /duplicate/.test(e.message));
  assert.throws(() => g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 4 }], 3), (e) => /between 0 and 3/.test(e.message));
  assert.throws(() => g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 2 }, { user_id: "b", round_wins: 2 }], 3), (e) => /^bad_result/.test(e.message));
  assert.throws(() => g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 0, won: true }], 3), (e) => /^bad_result/.test(e.message));
  assert.throws(() => g.BurnRate.parsePlayers([{ user_id: "a", round_wins: 2, won: true }, { user_id: "b", round_wins: 1, won: true }], 3), (e) => /^too_many_winners/.test(e.message));
});

test("burn-rate run reports keep the player's record and write their board once", () => {
  const nk = fakeNk();
  const written = [];
  nk.leaderboardRecordWrite = (id, owner, username, score, subscore) => {
    written.push(`${id}/${owner}/${score}/${subscore}`);
    return { leaderboardId: id, ownerId: owner, score, subscore, rank: 2, updateTime: 0 };
  };
  nk.usersGetId = (ids) => ids.map((userId) => ({ userId, username: "Pilot" }));
  const BURN = ctx({ game: "burn-rate", version: "2026.41.0" });
  const report = (extra, c = BURN) => g.rpcBurnRateRunReport(c, logger, nk, JSON.stringify({ mode: "endless", pace: "fast", lanes: true, seed: 11, distance: 2100, credits: 64, best_burn: 4, time_ms: 120000, pack: "k3", ...extra }));
  const res = JSON.parse(report({}));
  assert.equal(res.board, "distance_fast");
  assert.equal(res.record.score, 2100);
  assert.throws(() => report({}), (e) => /^already_reported/.test(e.message));
  assert.equal(JSON.parse(report({ mode: "course", course: "servers_2", finish_ms: 70000, distance: 1000, time_ms: 71000 })).board, "course_servers_2");
  assert.equal(JSON.parse(report({ mode: "course", course: "servers_2", distance: 400, time_ms: 30000 })).board, "");
  assert.deepEqual(written, ["burn-rate.distance_fast/u1/2100/64", "burn-rate.course_servers_2/u1/70000/64"]);
  const stats = { ...nk.storage.get("burn-rate.stats/stats/u1").value };
  assert.equal(stats.runs, 3);
  assert.equal(stats.metres, 3500);
  assert.equal(stats.best_distance, 2100);
  assert.equal(stats.courses_finished, 1);
  assert.throws(() => report({ seed: 12 }, ctx({ game: "race-day", version: "0.1.0" })), (e) => /^wrong_game/.test(e.message));
});

const DAY = 86400;
/** Saturday 17 October 2026, 12:00 UTC. */
const T = Date.UTC(2026, 9, 17, 12) / 1000;
const paintOn = (rank, at, extra = {}) => ({ writer: "a", name: "Ana", rank, kit: {}, grade: 50, eyes: 50, heaven: false, at, capped: false, ...extra });
const utc = (times) => Array.from(times, (t) => new Date(t * 1000).toISOString().slice(0, 16));

/** Runs fn with the server's clock stopped at `clock.now`, which fn can move. */
function withClock(start, fn) {
  const clock = { now: start };
  const real = g.Util.nowSeconds;
  g.Util.nowSeconds = () => clock.now;
  try {
    fn(clock);
  } finally {
    g.Util.nowSeconds = real;
  }
}

test("all-city keeps its writers' progress and the server's walls, with no boards or rooms yet", () => {
  const def = g.GAME_ALL_CITY;
  assert.deepEqual(Array.from(def.collections, (c) => ({ ...c })), [
    { name: "progress", clientWrite: true, maxBytes: 32768, read: "owner" },
    { name: "walls", clientWrite: false, maxBytes: 0, read: "owner" },
  ]);
  assert.equal(def.leaderboards.length, 0);
  assert.equal(def.rooms, null);
  assert.equal(def.chat, false);
  assert.equal(g.Guards.clientCollection(def, "all-city.progress").name, "progress");
  assert.throws(() => g.Guards.clientCollection(def, "all-city.walls"), (e) => /^read_only/.test(e.message));
});

test("all-city paint fades after its life, and is fair game for its own rank past half", () => {
  assert.deepEqual({ ...g.AllCity.LIFE }, { tag: 3 * DAY, throwup: 10 * DAY, piece: 30 * DAY, burner: 60 * DAY });
  const tag = paintOn("tag", T);
  assert.equal(g.AllCity.faded(tag, T + 3 * DAY), false, "a tag stands for exactly three days");
  assert.equal(g.AllCity.faded(tag, T + 3 * DAY + 1), true);
  assert.equal(g.AllCity.pastHalf(tag, T + 1.5 * DAY), false);
  assert.equal(g.AllCity.pastHalf(tag, T + 1.5 * DAY + 1), true);
  assert.equal(g.AllCity.faded(paintOn("burner", T), T + 60 * DAY), false);
  assert.equal(g.AllCity.faded(paintOn("burner", T), T + 60 * DAY + 1), true);
});

test("all-city goes over lower ranks, equal ranks past half, and lower ranks only by capping", () => {
  const can = (current, rank, { writer = "b", cap = false, now = T + 60 } = {}) => ({ ...g.AllCity.canPaint(current, writer, rank, cap, now) });
  const OK = { ok: true, capped: false, reason: "" };
  const NO = { ok: false, capped: false, reason: "rank" };
  const piece = paintOn("piece", T);
  assert.deepEqual(can(null, "tag"), OK, "a bare wall takes anything");
  assert.deepEqual(can(piece, "burner"), OK);
  assert.deepEqual(can(piece, "piece"), NO, "a fresh piece holds against another piece");
  assert.deepEqual(can(piece, "piece", { now: T + 15 * DAY }), NO);
  assert.deepEqual(can(piece, "piece", { now: T + 15 * DAY + 1 }), OK, "and doesn't once it's faded past half");
  assert.deepEqual(can(piece, "throwup"), NO);
  assert.deepEqual(can(piece, "tag", { cap: true }), { ok: true, capped: true, reason: "" });
  assert.deepEqual(can(piece, "piece", { cap: true }), NO, "capping is for lower ranks");
  assert.deepEqual(can(piece, "burner", { cap: true }), OK, "going over with a higher rank isn't capping");
  assert.deepEqual(can(piece, "tag", { writer: "a" }), OK, "writers go over their own work");
  assert.deepEqual(can(piece, "tag", { writer: "a", cap: true }), OK, "without capping themselves");
  assert.deepEqual(can(piece, "tag", { now: T + 30 * DAY + 1 }), OK, "faded paint leaves a bare wall");
});

test("all-city dawn is 06:00 in the town's time, whatever its offset, and the Buff catches up on a week at most", () => {
  const from = Date.UTC(2026, 9, 15, 12) / 1000;
  assert.deepEqual(utc(g.AllCity.dawns(from, T, 0)), ["2026-10-16T06:00", "2026-10-17T06:00"]);
  assert.deepEqual(utc(g.AllCity.dawns(from, T, 60)), ["2026-10-16T05:00", "2026-10-17T05:00"]);
  assert.deepEqual(utc(g.AllCity.dawns(from, T, 330)), ["2026-10-16T00:30", "2026-10-17T00:30"]);
  assert.deepEqual(utc(g.AllCity.dawns(from, T, -300)), ["2026-10-16T11:00", "2026-10-17T11:00"]);
  assert.deepEqual(utc(g.AllCity.dawns(from, T, 840)), ["2026-10-15T16:00", "2026-10-16T16:00"], "UTC+14 sees dawn the day before UTC");
  assert.deepEqual(utc(g.AllCity.dawns(from, T, -720)), ["2026-10-15T18:00", "2026-10-16T18:00"]);
  const dawn = Date.UTC(2026, 9, 17, 6) / 1000;
  assert.deepEqual(Array.from(g.AllCity.dawns(dawn - 1, dawn, 0)), [dawn], "a dawn right now counts");
  assert.deepEqual(Array.from(g.AllCity.dawns(dawn, dawn + DAY - 1, 0)), [], "and isn't counted again");
  assert.deepEqual(Array.from(g.AllCity.dawns(T, from, 0)), []);
  const month = g.AllCity.dawns(T - 30 * DAY, T, 0);
  assert.equal(month.length, 7);
  assert.deepEqual(utc([month[0], month[6]]), ["2026-10-11T06:00", "2026-10-17T06:00"]);
  assert.equal(g.AllCity.dawns(0, T, 0).length, 7);
  assert.equal(g.AllCity.lastDawn(dawn, 0), dawn);
  assert.equal(g.AllCity.lastDawn(dawn - 1, 0), dawn - DAY);
  assert.deepEqual(utc([g.AllCity.lastDawn(T, -300), g.AllCity.lastDawn(T, 840)]), ["2026-10-17T11:00", "2026-10-16T16:00"]);
});

test("the Buff cleans the cheapest walls first, then the most seen, within its budget, and never heaven spots", () => {
  const dawn = Date.UTC(2026, 9, 17, 6) / 1000;
  const before = dawn - DAY;
  const cleaned = (walls, from = dawn - 1, to = dawn, offset = 0) => Array.from(g.AllCity.buff(walls, from, to, offset), (b) => b.wall);
  const quarter = {
    w000001: paintOn("tag", before, { eyes: 10 }),
    w000002: paintOn("tag", before, { eyes: 90 }),
    w000003: paintOn("burner", before, { eyes: 100 }),
    w000004: paintOn("piece", before, { eyes: 80 }),
    w000005: paintOn("throwup", before, { eyes: 20 }),
    w000006: paintOn("tag", before, { eyes: 100, heaven: true }),
  };
  // 1 + 1 + 2 + 4 spends the budget of 8, so the burner waits.
  assert.deepEqual(cleaned(quarter), ["w000002", "w000001", "w000005", "w000004"]);
  assert.equal(Object.keys(quarter).length, 6, "working it out changes nothing");
  // It stops at the first wall that costs more than what's left.
  const throwups = { w00000a: paintOn("throwup", before), w00000b: paintOn("throwup", before), w00000c: paintOn("throwup", before), w00000d: paintOn("piece", before) };
  assert.deepEqual(cleaned(throwups), ["w00000a", "w00000b", "w00000c"]);
  const big = { w0000b1: paintOn("burner", before, { eyes: 100 }), w0000b2: paintOn("tag", before, { eyes: 0 }) };
  assert.deepEqual(cleaned(big), ["w0000b2"]);
  assert.deepEqual(Array.from(g.AllCity.buff(big, dawn - 1, dawn + DAY, 0), (b) => ({ ...b })), [
    { wall: "w0000b2", at: dawn },
    { wall: "w0000b1", at: dawn + DAY },
  ]);
  // Equal cost and eyes: oldest first, then by id.
  const ties = { w0000c2: paintOn("tag", before - 60), w0000c1: paintOn("tag", before), w0000c3: paintOn("tag", before - 60) };
  assert.deepEqual(cleaned(ties), ["w0000c2", "w0000c3", "w0000c1"]);
  // Paint from the dawn on, and paint already faded by it, isn't on its round.
  const late = { w0000d1: paintOn("tag", dawn), w0000d2: paintOn("tag", dawn - 3 * DAY - 1), w0000d3: paintOn("tag", dawn - 3 * DAY) };
  assert.deepEqual(cleaned(late), ["w0000d3"]);
  // Ten tags take two mornings.
  const ten = {};
  for (let i = 0; i < 10; i++) ten["w00010" + i] = paintOn("tag", before - i);
  assert.deepEqual(Array.from(g.AllCity.buff(ten, dawn - 1, dawn + DAY, 0), (b) => b.at), [...Array(8).fill(dawn), dawn + DAY, dawn + DAY]);
  // A tag at 05:30 UTC came before dawn in a UTC town, but after it in a UTC+1 one.
  const early = { w0000e1: paintOn("tag", dawn - 1800) };
  assert.deepEqual(cleaned(early, dawn - 7200, dawn, 0), ["w0000e1"]);
  assert.deepEqual(cleaned(early, dawn - 7200, dawn, 60), []);
});

test("settling a quarter brings the Buff up to date, drops faded paint and keeps the last 200 buffs", () => {
  const dawn = Date.UTC(2026, 9, 17, 6) / 1000;
  const stored = {
    utc_offset_min: 0,
    buffed_until: dawn - 1,
    walls: { w0000f1: paintOn("tag", dawn - 60), w0000f2: paintOn("piece", dawn - 31 * DAY), w0000f3: paintOn("burner", dawn - 60, { heaven: true }) },
    buffs: Array.from({ length: 199 }, (_, i) => ({ wall: "w" + String(i).padStart(7, "0"), at: dawn - 2 * DAY })),
  };
  const q = g.AllCity.quarterFrom(stored, 60, dawn + 60);
  assert.equal(q.utc_offset_min, 0, "a quarter keeps the offset it was first painted with");
  assert.equal(g.AllCity.settle(q, dawn + 60), true, "a dawn passed");
  assert.deepEqual(Object.keys(q.walls), ["w0000f3"], "the tag was buffed and the piece had faded");
  assert.equal(q.buffs.length, 200);
  assert.deepEqual({ ...q.buffs[199] }, { wall: "w0000f1", at: dawn });
  assert.equal(q.buffed_until, dawn + 60);
  assert.equal(Object.keys(stored.walls).length, 3, "what was read is left as it was");
  assert.equal(stored.buffs.length, 199);
  assert.equal(g.AllCity.settle(q, dawn + 120), false, "no dawn since");
  q.walls.w0000f4 = paintOn("tag", dawn + 100);
  q.walls.w0000f5 = paintOn("tag", dawn + 100);
  assert.equal(g.AllCity.settle(q, dawn + DAY), true);
  assert.equal(q.buffs.length, 200);
  assert.equal(q.buffs[0].wall, "w0000002", "the oldest buffs go first");
  assert.deepEqual(Array.from(g.AllCity.buffedSince(q, dawn), String), ["w0000f4", "w0000f5"]);
  assert.deepEqual(Array.from(g.AllCity.buffedSince(q, dawn - 1), String), ["w0000f1", "w0000f4", "w0000f5"]);
  q.buffs.push({ wall: "w0000f4", at: dawn + 2 * DAY });
  assert.deepEqual(Array.from(g.AllCity.buffedSince(q, dawn), String), ["w0000f4", "w0000f5"], "each wall once");
  const fresh = g.AllCity.quarterFrom(null, -300, T);
  assert.deepEqual({ ...fresh, walls: { ...fresh.walls }, buffs: [...fresh.buffs] }, { utc_offset_min: -300, buffed_until: T, walls: {}, buffs: [] });
});

test("all-city paints walls by the rank rule, keeps the town's dawn, and the Buff comes overnight", () => {
  const nk = fakeNk();
  nk.usersGetId = (ids) => ids.map((userId) => ({ userId, username: "user_" + userId, displayName: userId === "u1" ? "Ana" : "" }));
  const CITY = (userId) => ctx({ game: "all-city", version: "2026.42.0" }, { userId });
  const tag = { town: "monaco", quarter: 12, wall: "w1a2b3c", rank: "tag", kit: { style: "handstyle", fill: "#c6f03c" }, grade: 70, eyes: 40, heaven: false, seconds: 3.5, utc_offset_min: 60, cap: false };
  const paint = (extra, userId = "u1") => JSON.parse(g.rpcAllCityPaint(CITY(userId), logger, nk, JSON.stringify({ ...tag, ...extra })));
  const walls = (extra = {}, userId = "u2") => JSON.parse(g.rpcAllCityWalls(CITY(userId), logger, nk, JSON.stringify({ town: "monaco", quarter: 12, ...extra })));
  const stored = (key = "monaco:12") => nk.storage.get(`all-city.walls/${key}/${g.SYSTEM_USER_ID}`);
  // Saturday 22:00 UTC, 23:00 in a UTC+1 town.
  withClock(Date.UTC(2026, 9, 17, 22) / 1000, (clock) => {
    assert.deepEqual(walls(), { walls: {}, last_dawn: 0, buffed: [] }, "nobody has painted here yet");
    assert.equal(stored(), undefined, "and reading leaves nothing behind");
    assert.deepEqual(paint({}), {
      ok: true,
      wall: { writer: "u1", name: "Ana", rank: "tag", kit: { style: "handstyle", fill: "#c6f03c" }, grade: 70, eyes: 40, heaven: false, at: clock.now, capped: false },
    });
    assert.deepEqual(paint({}, "u2"), { ok: false, reason: "rank" }, "a fresh tag holds against a tag");
    clock.now += 60;
    const over = paint({ rank: "throwup", seconds: 20, utc_offset_min: -300 }, "u2");
    assert.equal(over.ok, true);
    assert.equal(over.wall.name, "user_u2", "no display name falls back to the username");
    assert.deepEqual(paint({}), { ok: false, reason: "rank" });
    assert.equal(paint({ cap: true }).wall.capped, true);
    assert.equal(paint({ wall: "w0000a1", rank: "burner", seconds: 300, eyes: 95 }).ok, true);
    assert.equal(paint({ wall: "w0000a2", heaven: true, eyes: 100 }).ok, true);
    assert.equal(stored().value.utc_offset_min, 60, "the first paint sets the town's offset");
    assert.equal(stored().permissionRead, 0, "players read walls only through all-city.walls");
    assert.deepEqual(Object.keys(walls().walls).sort(), ["w0000a1", "w0000a2", "w1a2b3c"]);
    paint({ quarter: 13, utc_offset_min: 2000 });
    assert.equal(stored("monaco:13").value.utc_offset_min, 840, "offsets are clamped");

    // Overnight: dawn in town is 05:00 UTC. The Buff spends 1 on the tag and
    // can't afford the burner; the heaven spot is out of its reach.
    const evening = clock.now;
    clock.now = Date.UTC(2026, 9, 18, 9) / 1000;
    const morning = walls({ since: evening });
    assert.deepEqual(Object.keys(morning.walls).sort(), ["w0000a1", "w0000a2"]);
    assert.equal(morning.last_dawn, Date.UTC(2026, 9, 18, 5) / 1000);
    assert.deepEqual(morning.buffed, ["w1a2b3c"]);
    assert.equal(stored().value.buffed_until, clock.now, "the Buff's morning is saved");
    assert.equal(stored().value.walls.w1a2b3c, undefined);
    assert.deepEqual(walls({ since: morning.last_dawn }).buffed, [], "and reported once");
    assert.deepEqual(walls().buffed, []);
    const version = stored().version;
    walls();
    assert.equal(stored().version, version, "reads with no dawn since write nothing");
    clock.now += DAY;
    assert.deepEqual(Object.keys(walls().walls), ["w0000a2"], "the burner goes the next morning; the heaven spot stays");
    assert.equal(paint({ seconds: 2 }, "u2").ok, true, "a buffed wall is bare");

    const why = (extra) => {
      try {
        paint(extra);
      } catch (err) {
        return String(err.message).split(":")[0];
      }
      return "ok";
    };
    assert.equal(why({ wall: "w0000b1", rank: "piece", seconds: 89 }), "too_quick");
    assert.equal(why({ rank: "burner", seconds: 239 }), "too_quick");
    assert.equal(why({ town: "Monaco" }), "bad_town");
    assert.equal(why({ town: "x".repeat(49) }), "town is too long");
    assert.equal(why({ wall: "123456a" }), "bad_wall");
    assert.equal(why({ wall: "w12345" }), "bad_wall");
    assert.equal(why({ wall: "w1A2B3C" }), "bad_wall");
    assert.equal(why({ rank: "mural" }), "bad_rank");
    assert.equal(why({ kit: [1, 2] }), "bad_kit");
    assert.equal(why({ kit: null }), "bad_kit");
    assert.equal(why({ kit: { s: "x".repeat(2100) } }), "too_large");
    assert.equal(why({ grade: 101 }), "grade must be between 0 and 100");
    assert.equal(why({ eyes: -1 }), "eyes must be between 0 and 100");
    assert.equal(why({ quarter: 10000 }), "quarter must be between 0 and 9999");
    assert.equal(why({ seconds: "3" }), "seconds must be a number from 0 to 86400");
    assert.equal(why({ heaven: "yes" }), "heaven must be true or false");
    assert.equal(why({ utc_offset_min: 1.5 }), "utc_offset_min must be an integer");
    const BURN = ctx({ game: "burn-rate", version: "0.1.0" });
    assert.throws(() => g.rpcAllCityPaint(BURN, logger, nk, "{}"), (e) => /^wrong_game/.test(e.message));
    assert.throws(() => g.rpcAllCityWalls(BURN, logger, nk, "{}"), (e) => /^wrong_game/.test(e.message));
  });
});

test("all-city paints retry a busy quarter, fill up, and stop at 40 an hour", () => {
  const nk = fakeNk();
  nk.usersGetId = (ids) => ids.map((userId) => ({ userId, username: "ana", displayName: "Ana" }));
  const tag = { town: "leeds", quarter: 2, wall: "w300000", rank: "tag", kit: {}, grade: 50, eyes: 50, heaven: false, seconds: 2, utc_offset_min: 0 };
  const paint = (extra) => JSON.parse(g.rpcAllCityPaint(ctx({ game: "all-city", version: "0.1.0" }), logger, nk, JSON.stringify({ ...tag, ...extra })));
  withClock(T, () => {
    const full = {};
    for (let i = 0; i < 1000; i++) full["w" + (0x200000 + i).toString(16)] = { ...paintOn("tag", T - 60), writer: "u9" };
    nk.storage.set(`all-city.walls/leeds:2/${g.SYSTEM_USER_ID}`, {
      collection: "all-city.walls", key: "leeds:2", userId: g.SYSTEM_USER_ID, version: "v1",
      value: { utc_offset_min: 0, buffed_until: T - 60, walls: full, buffs: [] },
    });
    assert.deepEqual(paint({}), { ok: false, reason: "full" });
    assert.equal(paint({ wall: "w200000", rank: "throwup", seconds: 15 }).ok, true, "walls in a full quarter can still be gone over");

    const write = nk.storageWrite;
    let clashes = 1;
    nk.storageWrite = (objs) => {
      if (clashes-- > 0) throw new Error("version conflict");
      return write(objs);
    };
    assert.equal(paint({ quarter: 3 }).ok, true, "a clash is retried");
    clashes = 99;
    assert.deepEqual(paint({ quarter: 3, wall: "w300001" }), { ok: false, reason: "busy" });
    nk.storageWrite = write;
    // Every paint the server takes counts, refused or not: four so far.
    for (let i = 4; i < 40; i++) assert.equal(paint({ quarter: 4, wall: "w4" + String(i).padStart(5, "0") }).ok, true, String(i));
    assert.deepEqual(paint({ quarter: 4, wall: "w400040" }), { ok: false, reason: "rate" });
  });
});
