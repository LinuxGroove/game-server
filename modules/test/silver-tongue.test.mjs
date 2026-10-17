import { test } from "node:test";
import assert from "node:assert/strict";
import { load, logger, fakeNk, ctx } from "./harness.mjs";

const g = load();
const ST = g.SilverTongue;
const at = (iso) => Date.parse(iso) / 1000;

function rejects(fn, code, reason) {
  assert.throws(fn, (e) => e.code === code && e.message.startsWith(reason + ":"), reason);
}

const sessionCtx = (userId, env = {}) => ctx({ game: "silver-tongue", version: "0.1.0" }, { userId, env });

test("the registry entry has no quick match and the boards the game needs", () => {
  assert.deepEqual(Array.from(g.Registry.validateAll()), []);
  const game = g.GAME_SILVER_TONGUE;
  assert.equal(game.rooms.matchmaking, false);
  assert.equal(game.rooms.maxPlayers, 4);
  const board = (id) => game.leaderboards.find((b) => b.id === id);
  assert.equal(board("contract_weekly").clientSubmit, true);
  assert.equal(board("contract_weekly").reset, "0 0 * * 1");
  for (const id of ["jobs", "clean_jobs", "take", "jobs_weekly"]) {
    assert.equal(board(id).clientSubmit, false, id);
    assert.equal(board(id).operator, "incr", id);
  }
  assert.equal(board("jobs_weekly").reset, "0 0 * * 1");
  assert.equal(game.shares[0].name, "report");
});

test("the contract number follows Sunday-to-Saturday weeks numbered like ISO weeks", () => {
  assert.equal(ST.contractSeed(at("2026-10-18T00:00:00Z")), 202643, "Sunday starts the next ISO week");
  assert.equal(ST.contractSeed(at("2026-10-17T23:59:59Z")), 202642, "Saturday");
  assert.equal(ST.contractSeed(at("2026-10-19T12:00:00Z")), 202643, "Monday");
  assert.equal(ST.contractSeed(at("2026-10-24T23:59:59Z")), 202643, "next Saturday");
  assert.equal(ST.contractSeed(at("2026-10-25T00:00:00Z")), 202644);
  // Year boundaries: Sunday 2026-12-27 starts ISO week 53 of 2026; Sunday 2027-01-03 starts week 1 of 2027? (Mon 2027-01-04)
  assert.equal(ST.contractSeed(at("2026-12-27T10:00:00Z")), 202653);
  assert.equal(ST.contractSeed(at("2027-01-02T10:00:00Z")), 202653);
  assert.equal(ST.contractSeed(at("2027-01-03T00:00:00Z")), 202701);
  assert.equal(ST.contractSeed(at("2024-12-29T00:00:00Z")), 202501, "Monday 2024-12-30 is ISO week 1 of 2025");
});

test("contract submissions need a real job, a round take and this week's or last week's number", () => {
  const now = at("2026-10-18T09:00:00Z");
  const ok = { seed: 202643, job: "marlin_safe" };
  ST.validateContract(now, 6000, ok);
  ST.validateContract(now, 500, { ...ok, seed: 202642 });
  rejects(() => ST.validateContract(now, 6100, ok), 3, "bad_take");
  rejects(() => ST.validateContract(now, 6000, { ...ok, seed: 202641 }), 3, "bad_contract");
  rejects(() => ST.validateContract(now, 6000, { ...ok, seed: "202643" }), 3, "bad_contract");
  rejects(() => ST.validateContract(now, 6000, { seed: 202643 }), 3, "unknown_job");
  rejects(() => ST.validateContract(now, 6000, { ...ok, job: "toString" }), 3, "unknown_job");
  // Through the shared submit path.
  const nk = fakeNk();
  const written = [];
  nk.leaderboardRecordWrite = (...a) => (written.push(a), { score: String(a[3]), rank: "1" });
  nk.usersGetId = () => [];
  const board = g.Registry.leaderboard(g.GAME_SILVER_TONGUE, "contract_weekly");
  assert.ok(board.validate);
  assert.throws(() => board.validate(sessionCtx("u1"), nk, "u1", 6000, 0, { seed: 1, job: "mae_party" }), (e) => /bad_contract/.test(e.message));
});

test("every job's take is capped, and a Circuit night may pay up to 2.25 times", () => {
  assert.equal(ST.maxTake("meridian_gala", 0), 2000);
  assert.equal(ST.maxTake("meridian_gala", 77), 4500);
  assert.equal(ST.maxTake("mae_party", 77), 56500);
  assert.equal(ST.maxTake("vantage_research", 77), 45000);
  assert.equal(Object.keys(g.SILVER_TONGUE_JOBS).length, 13);
});

function reportBody(extra = {}) {
  return {
    match_id: "room-1",
    round: 1,
    job: "marlin_safe",
    venue: "marlin",
    circuit: 0,
    win: true,
    clean: true,
    quiet: false,
    silver: true,
    take: 6000,
    players: [
      { user_id: "host", held: false, memories: { purser: ["asked about the safe", "was calm"] } },
      { user_id: "guest", held: true, memories: { purser: ["saw a stranger"], captain: ["x".repeat(500)] } },
    ],
    ...extra,
  };
}

function reportWorld() {
  const nk = fakeNk();
  const records = [];
  nk.leaderboardRecordWrite = (board, user, name, score) => (records.push({ board, user, score }), { score: String(score), rank: "1" });
  nk.usersGetId = (ids) => ids.map((id) => ({ userId: id, username: "n-" + id }));
  g.Rooms.roster = () => ({ host: "host", members: ["host", "guest"], present: ["host", "guest"] });
  return { nk, records };
}

const read = (nk, coll, key, user) => nk.storage.get(`${coll}/${key}/${user}`)?.value;
const send = (nk, user, body) => JSON.parse(g.rpcSilverTongueJobReport(sessionCtx(user), logger, nk, JSON.stringify(body)));

test("a host's job report updates stats, memory and the server boards", () => {
  const { nk, records } = reportWorld();
  assert.deepEqual(send(nk, "host", reportBody()), { ok: true, round: 1 });
  const stats = read(nk, "silver-tongue.stats", "stats", "host");
  assert.deepEqual(stats, { tries: 1, jobs: 1, clean: 1, quiet: 0, silver: 1, take: 6000, held: 0, circuit_nights: 0 });
  assert.equal(read(nk, "silver-tongue.stats", "stats", "guest").held, 1);
  const mem = read(nk, "silver-tongue.memory", "crew", "guest");
  assert.equal(mem.burned, true);
  assert.equal(mem.take, 6000);
  assert.deepEqual(mem.memories.marlin.purser, ["saw a stranger"]);
  assert.equal(mem.memories.marlin.captain[0].length, 200);
  assert.deepEqual(mem.done.marlin_safe, { clean: true, quiet: false, silver: true, take: 6000 });
  assert.equal(read(nk, "silver-tongue.memory", "crew", "host").burned, false);
  const board = (b) => records.filter((r) => r.board === "silver-tongue." + b).length;
  assert.equal(board("jobs"), 2);
  assert.equal(board("jobs_weekly"), 2);
  assert.equal(board("clean_jobs"), 2);
  assert.equal(board("take"), 2);
  assert.equal(nk.counter("rounds", { game: "silver-tongue", outcome: "job_won" }), 1);
  assert.equal(nk.counter("round_players", { game: "silver-tongue" }), 2);
  // Not the same round twice, and only the host.
  rejects(() => send(nk, "host", reportBody()), 6, "already_reported");
  rejects(() => send(nk, "guest", reportBody({ round: 2 })), 7, "not_host");
});

test("memories keep the newest four lines, and a later report never un-burns or loses a best", () => {
  const { nk } = reportWorld();
  send(nk, "host", reportBody());
  send(nk, "host", reportBody({
    round: 2, clean: false, silver: false, take: 3000,
    players: [{ user_id: "guest", held: false, memories: { purser: ["a", "b", "c", "d", "e"] } }],
  }));
  const mem = read(nk, "silver-tongue.memory", "crew", "guest");
  assert.deepEqual(mem.memories.marlin.purser, ["b", "c", "d", "e"]);
  assert.equal(mem.burned, true);
  assert.equal(mem.take, 9000);
  assert.deepEqual(mem.done.marlin_safe, { clean: true, quiet: false, silver: true, take: 6000 });
});

test("a failed job counts a try only, and a Circuit night keeps out of the season's record", () => {
  const { nk, records } = reportWorld();
  send(nk, "host", reportBody({ win: false, clean: false, silver: false, take: 0 }));
  assert.deepEqual(read(nk, "silver-tongue.stats", "stats", "host"), { tries: 1, jobs: 0, clean: 0, quiet: 0, silver: 0, take: 0, held: 0, circuit_nights: 0 });
  assert.equal(records.length, 0);
  assert.equal(nk.counter("rounds", { outcome: "job_failed" }), 1);
  send(nk, "host", reportBody({ round: 2, circuit: 202643, take: 13500 }));
  assert.equal(read(nk, "silver-tongue.stats", "stats", "host").circuit_nights, 1);
  assert.equal(read(nk, "silver-tongue.memory", "crew", "host").done.marlin_safe, undefined);
  assert.equal(read(nk, "silver-tongue.memory", "crew", "host").take, 13500);
});

test("bad job reports are refused", () => {
  const { nk } = reportWorld();
  rejects(() => send(nk, "host", reportBody({ job: "nope" })), 3, "unknown_job");
  rejects(() => send(nk, "host", reportBody({ venue: "mae" })), 3, "bad_venue");
  rejects(() => send(nk, "host", reportBody({ take: 6500 })), 3, "bad_take");
  rejects(() => send(nk, "host", reportBody({ win: false })), 3, "bad_result");
  rejects(() => send(nk, "host", reportBody({ players: [{ user_id: "stranger" }] })), 3, "not_in_room");
  rejects(() => send(nk, "host", reportBody({ players: [{ user_id: "host", memories: { purser: [1] } }] })), 3, "bad_memory");
  assert.throws(() => send(nk, "host", reportBody({ players: [] })), (e) => e.code === 3 && /^players must/.test(e.message));
  assert.throws(() => g.rpcSilverTongueJobReport(ctx({ game: "sandbox", version: "1" }, { userId: "host", env: { GAME_SANDBOX_ENABLED: "true" } }), logger, nk, JSON.stringify(reportBody())), (e) => /wrong_game/.test(e.message));
});

test("memory grows no larger than its collection allows", () => {
  const m = ST.memoryOf(null);
  for (let c = 0; c < 40; c++) {
    m.memories["venue" + (c % 5)] = m.memories["venue" + (c % 5)] || {};
    m.memories["venue" + (c % 5)]["person_" + c] = Array(4).fill("y".repeat(200));
  }
  ST.trimMemory(m);
  assert.ok(g.Util.byteLength(JSON.stringify(m)) <= 16384);
});

test("memory and buy_face", () => {
  const { nk } = reportWorld();
  const call = (fn, user) => JSON.parse(fn(sessionCtx(user), logger, nk, "{}"));
  assert.deepEqual(call(g.rpcSilverTongueMemory, "host"), { burned: false, faces: 0, take: 0, memories: {}, done: {} });
  rejects(() => call(g.rpcSilverTongueBuyFace, "guest"), 9, "cannot_buy");
  send(nk, "host", reportBody({ take: 2000, job: "meridian_gala", venue: "meridian" }));
  rejects(() => call(g.rpcSilverTongueBuyFace, "guest"), 9, "cannot_buy");
  send(nk, "host", reportBody({ round: 2 }));
  const before = call(g.rpcSilverTongueMemory, "guest");
  assert.equal(before.burned, true);
  assert.equal(before.take, 8000);
  const after = call(g.rpcSilverTongueBuyFace, "guest");
  assert.equal(after.burned, false);
  assert.equal(after.faces, 1);
  assert.equal(after.take, 2000);
  rejects(() => call(g.rpcSilverTongueBuyFace, "guest"), 9, "cannot_buy");
  assert.equal(call(g.rpcSilverTongueMemory, "guest").faces, 1);
});

// The Switchboard -------------------------------------------------------

test("the Switchboard's budget helpers", () => {
  const today = "2026-10-17";
  assert.equal(ST.dayOf(at("2026-10-17T23:59:59Z")), today);
  assert.equal(ST.estimateTokens([{ content: "abcd" }, { content: "ef" }], 100), 102);
  assert.deepEqual({ ...ST.spend(null, today, 100, 1000) }, { date: today, tokens: 100 });
  assert.equal(ST.spend({ date: today, tokens: 950 }, today, 100, 1000), null);
  assert.deepEqual({ ...ST.spend({ date: today, tokens: 900 }, today, 100, 1000) }, { date: today, tokens: 1000 });
  assert.equal(ST.spend({ date: "2026-10-16", tokens: 999999 }, today, 100, 1000).tokens, 100, "a new day starts again");
  assert.equal(ST.refund({ date: today, tokens: 150 }, today, 100).tokens, 50);
  assert.equal(ST.refund({ date: today, tokens: 50 }, today, 100).tokens, 0);
  assert.equal(ST.refund({ date: "2026-10-16", tokens: 50 }, today, 100).tokens, 0);
  assert.equal(ST.left({ date: today, tokens: 300 }, today, 1000), 700);
  assert.equal(ST.left(null, today, 1000), 1000);
  const up = ST.upstream(sessionCtx("u", { SWITCHBOARD_URL: "http://llm.local/v1/", SWITCHBOARD_KEY: "k", SWITCHBOARD_MODEL: "m", SWITCHBOARD_USER_BUDGET: "50", SWITCHBOARD_DAILY_CAP: "junk" }));
  assert.deepEqual({ ...up }, { url: "http://llm.local/v1", key: "k", model: "m", userBudget: 50, dailyCap: 5000000 });
  assert.equal(ST.upstream(sessionCtx("u")), null);
});

function switchboardWorld(env, answer) {
  const nk = fakeNk();
  const calls = [];
  nk.httpRequest = (url, method, headers, body, timeout) => {
    calls.push({ url, method, headers, body: JSON.parse(body), timeout });
    if (answer instanceof Error) throw answer;
    return answer(calls.length);
  };
  const go = (user, body) => JSON.parse(g.rpcSilverTongueSwitchboard(sessionCtx(user, env), logger, nk, JSON.stringify(body)));
  return { nk, calls, go };
}

const ENV = { SWITCHBOARD_URL: "http://llm.local/v1", SWITCHBOARD_KEY: "sekrit", SWITCHBOARD_MODEL: "small" };
const good = () => ({ code: 200, body: JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 30, completion_tokens: 10 } }) });
const ask = { messages: [{ role: "system", content: "x".repeat(300) }, { role: "user", content: "hi" }], max_tokens: 100 };

test("the Switchboard is off without an upstream", () => {
  const { go, calls } = switchboardWorld({}, good);
  rejects(() => go("u1", ask), 14, "switchboard_off");
  assert.equal(calls.length, 0);
});

test("the Switchboard calls the upstream and charges what the call used", () => {
  const { nk, go, calls } = switchboardWorld(ENV, good);
  const res = go("u1", { ...ask, json_schema: { type: "object", properties: { say: { type: "string" } } } });
  assert.equal(res.text, "hello");
  assert.deepEqual(res.usage, { prompt_tokens: 30, completion_tokens: 10 });
  assert.equal(res.left, 120000 - 40);
  assert.equal(calls[0].url, "http://llm.local/v1/chat/completions");
  assert.equal(calls[0].method, "post");
  assert.equal(calls[0].timeout, 20000);
  assert.equal(calls[0].headers.Authorization, "Bearer sekrit");
  assert.equal(calls[0].body.model, "small");
  assert.equal(calls[0].body.max_tokens, 100);
  assert.equal(calls[0].body.response_format.type, "json_schema");
  assert.equal(calls[0].body.response_format.json_schema.schema.type, "object");
  assert.equal(read(nk, "silver-tongue.switchboard", "day", "u1").tokens, 40);
  assert.equal(read(nk, "silver-tongue.switchboard", "total", "00000000-0000-0000-0000-000000000000").tokens, 40);
  assert.equal(nk.counter("switchboard_calls", { game: "silver-tongue", outcome: "ok" }), 1);
  assert.equal(go("u1", ask).left, 120000 - 80);
});

test("the Switchboard stops an account at its daily budget, and the server at its cap", () => {
  // Each call is charged its estimate until it answers: 101 + 100 = 201 tokens, and the answer uses 40.
  const small = switchboardWorld({ ...ENV, SWITCHBOARD_USER_BUDGET: "100" }, good);
  rejects(() => small.go("u1", ask), 8, "switchboard_budget");
  assert.equal(small.calls.length, 0);
  assert.equal(read(small.nk, "silver-tongue.switchboard", "day", "u1")?.tokens ?? 0, 0);

  const capped = switchboardWorld({ ...ENV, SWITCHBOARD_USER_BUDGET: "1000", SWITCHBOARD_DAILY_CAP: "250" }, good);
  capped.go("u1", ask);
  capped.go("u2", ask);
  // 80 used; the next estimate (201) would take the server past 250.
  rejects(() => capped.go("u3", ask), 8, "switchboard_budget");
  assert.equal(capped.calls.length, 2);
  assert.equal(read(capped.nk, "silver-tongue.switchboard", "day", "u3").tokens, 0, "the account's charge was given back");
  assert.equal(capped.nk.counter("switchboard_calls", { outcome: "budget" }), 1);
});

test("a failing upstream costs nothing and leaks no key", () => {
  for (const answer of [() => ({ code: 500, body: "boom sekrit" }), () => ({ code: 200, body: "not json" }), () => ({ code: 200, body: "{\"choices\":[]}" }), new Error("dial http://llm.local sekrit")]) {
    const { nk, go } = switchboardWorld(ENV, answer);
    assert.throws(
      () => go("u1", ask),
      (e) => e.code === 14 && e.message.startsWith("switchboard_error:") && !/sekrit|llm\.local/.test(e.message),
    );
    assert.equal(read(nk, "silver-tongue.switchboard", "day", "u1").tokens, 0);
    assert.equal(nk.counter("switchboard_calls", { outcome: "error" }), 1);
  }
});

test("the Switchboard refuses bad requests and rates calls", () => {
  const { go, calls } = switchboardWorld(ENV, good);
  assert.throws(() => go("u1", { messages: [] }), (e) => e.code === 3 && /^messages must/.test(e.message));
  assert.throws(() => go("u1", { messages: [{ role: "tool", content: "x" }] }), (e) => e.code === 3);
  assert.throws(() => go("u1", { messages: [{ role: "user", content: "x" }], max_tokens: 401 }), (e) => e.code === 3);
  assert.throws(() => go("u1", { messages: [{ role: "user", content: "x".repeat(24001) }] }), (e) => e.code === 3);
  assert.throws(() => go("u1", { messages: [{ role: "user", content: "x" }], json_schema: [] }), (e) => e.code === 3);
  assert.equal(calls.length, 0);
  for (let i = 0; i < 30; i++) go("u9", { messages: [{ role: "user", content: "x" }], max_tokens: 1 });
  rejects(() => go("u9", { messages: [{ role: "user", content: "x" }], max_tokens: 1 }), 8, "rate_limited");
});
