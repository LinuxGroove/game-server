// Silver Tongue: a co-op con game where the characters hear what the players
// say out loud (game-ideas, idea 23). The game runs on the player's machine,
// with its own models; this module is the small online side of M3.
//
// One crew of one to four, or two rival crews racing for the same prize (up to
// eight players), play a job in a bridge room named "silver-tongue:<CODE>"
// (no quick match: a con job needs a crew who agreed to it). The host reports
// each finished job with silver-tongue.job_report, which keeps every crew
// member's stats and what the cast remember of them (the "memory" object,
// including whether their face is burned), and writes the server boards.
//
// The Circuit's weekly contract is a client-submitted board whose entries are
// checked against the week's number, which both sides work out from the date.
//
// The Switchboard (silver-tongue.switchboard) lends a host without a GPU a
// model run by the server's operator. It is off unless the server names an
// upstream, and metered per account and for the whole server each UTC day.

/** Every job in the game (Jobs.CAMPAIGN): the venue it is at and its take in dollars. */
const SILVER_TONGUE_JOBS: { [id: string]: { venue: string; take: number } } = {
  meridian_gala: { venue: "meridian", take: 2000 },
  meridian_list: { venue: "meridian", take: 4000 },
  meridian_case: { venue: "meridian", take: 8000 },
  marlin_aboard: { venue: "marlin", take: 3000 },
  marlin_safe: { venue: "marlin", take: 6000 },
  marlin_auction: { venue: "marlin", take: 12000 },
  tideline_count: { venue: "tideline", take: 9000 },
  tideline_favor: { venue: "tideline", take: 5000 },
  tideline_vault: { venue: "tideline", take: 15000 },
  vantage_lift: { venue: "vantage", take: 4000 },
  vantage_board: { venue: "vantage", take: 8000 },
  vantage_research: { venue: "vantage", take: 20000 },
  mae_party: { venue: "mae", take: 25000 },
};

const GAME_SILVER_TONGUE: Registry.GameDef = {
  id: "silver-tongue",
  name: "Silver Tongue",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [
    // This week's contract: the best take on it, sent by the game with the
    // contract's number and the job as metadata. The board resets on Monday
    // 00:00 UTC; the contract's week turns over a day earlier (Sunday), so the
    // previous week's number is accepted too (SilverTongue.contractSeeds).
    {
      id: "contract_weekly", sort: "desc", operator: "best", reset: "0 0 * * 1", clientSubmit: true,
      minScore: 500, maxScore: 60000, enableRank: true,
      validate: function (ctx, nk, userId, score, subscore, metadata) {
        SilverTongue.validateContract(Util.nowSeconds(), score, metadata);
      },
    },
    // Jobs pulled off, all time and this week.
    { id: "jobs", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 1, maxScore: 1, enableRank: true },
    { id: "jobs_weekly", sort: "desc", operator: "incr", reset: "0 0 * * 1", clientSubmit: false, minScore: 1, maxScore: 1, enableRank: true },
    // Jobs with nobody alerted.
    { id: "clean_jobs", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 1, maxScore: 1, enableRank: true },
    // Total take, in dollars.
    { id: "take", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 1, maxScore: 100000, enableRank: true },
  ],
  collections: [
    // Counters from job reports, written by the server.
    { name: "stats", clientWrite: false, maxBytes: 0, read: "public" },
    // The crew member's burned face, take and what the cast remember of them.
    { name: "memory", clientWrite: false, maxBytes: 16384, read: "owner" },
    // The Switchboard's daily token counts.
    { name: "switchboard", clientWrite: false, maxBytes: 0, read: "owner" },
  ],
  blobs: [],
  // A job's report card, shared by code.
  shares: [{ name: "report", maxBytes: 8192, perUserLimit: 30 }],
  // tickRate, mode and hostGraceSec only apply to relay rooms.
  rooms: { transport: "bridge", minPlayers: 1, maxPlayers: 8, tickRate: 20, mode: "host", matchmaking: false, hostGraceSec: 15 },
};

namespace SilverTongue {
  export const STATS_KEY = "stats";
  export const MEMORY_KEY = "crew";
  /** Dollars a new face costs. */
  export const FACE_PRICE = 6000;
  /** Most lines the cast remember of one crew member each. */
  export const MAX_LINES = 4;
  export const MAX_LINE_CHARS = 200;
  export const MEMORY_MAX_BYTES = 16384;
  /** A Circuit night pays at most this many times the job's take. */
  export const CIRCUIT_FACTOR = 2.25;
  export const TAKE_STEP = 500;

  export const DAILY_KEY = "day";
  export const TOTAL_KEY = "total";
  export const DEFAULT_USER_BUDGET = 120000;
  export const DEFAULT_DAILY_CAP = 5000000;
  export const MAX_REPLY_TOKENS = 400;
  /** Longest prompt the Switchboard takes, in characters (a job's prompts are far shorter). */
  export const MAX_PROMPT_CHARS = 24000;
  export const MAX_SCHEMA_BYTES = 8192;
  export const ROLES = ["system", "user", "assistant"];

  export interface Memory {
    burned: boolean;
    faces: number;
    take: number;
    memories: { [venue: string]: { [character: string]: string[] } };
    done: { [job: string]: { clean: boolean; quiet: boolean; silver: boolean; take: number } };
  }

  export interface ReportedPlayer {
    user_id: string;
    held: boolean;
    memories: { [character: string]: string[] };
  }

  export interface Report {
    job: string;
    venue: string;
    circuit: number;
    win: boolean;
    clean: boolean;
    quiet: boolean;
    silver: boolean;
    take: number;
  }

  // The contract -----------------------------------------------------------

  /**
   * The Circuit's week number as the game works it out (Circuit.week_of):
   * weeks run Sunday to Saturday (UTC) and are numbered like ISO weeks, so a
   * Sunday starts the ISO week of the Monday after it. Year * 100 + week.
   */
  export function contractSeed(unixSeconds: number): number {
    const t = new Date((unixSeconds + 86400) * 1000);
    const day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    // The Thursday of this ISO week decides its year.
    const thursday = new Date(day + (3 - ((t.getUTCDay() + 6) % 7)) * 86400000);
    const year = thursday.getUTCFullYear();
    const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 604800000) + 1;
    return year * 100 + week;
  }

  /** The contract numbers a submission may carry now: this week's and last week's. */
  export function contractSeeds(unixSeconds: number): number[] {
    return [contractSeed(unixSeconds), contractSeed(unixSeconds - 7 * 86400)];
  }

  /** Throws unless a contract submission is a real take on a real job in a current week. */
  export function validateContract(unixSeconds: number, score: number, metadata: { [key: string]: any }): void {
    if (score % TAKE_STEP !== 0) {
      Util.fail(Code.INVALID_ARGUMENT, "bad_take: a take is a multiple of " + TAKE_STEP + " dollars");
    }
    if (!metadata || typeof metadata["job"] !== "string" || !SILVER_TONGUE_JOBS.hasOwnProperty(metadata["job"])) {
      Util.fail(Code.INVALID_ARGUMENT, "unknown_job: metadata.job is not a Silver Tongue job");
    }
    if (contractSeeds(unixSeconds).indexOf(metadata["seed"]) < 0) {
      Util.fail(Code.INVALID_ARGUMENT, "bad_contract: metadata.seed is not this week's contract");
    }
  }

  // Job reports ------------------------------------------------------------

  /** Most a job may pay: its take, or on a Circuit night up to 2.25 times that, to the nearest 500. */
  export function maxTake(job: string, circuit: number): number {
    const base = SILVER_TONGUE_JOBS[job].take;
    return circuit === 0 ? base : Math.round((base * CIRCUIT_FACTOR) / TAKE_STEP) * TAKE_STEP;
  }

  export function parseReport(req: { [key: string]: any }): Report {
    const job = Util.str(req, "job", 32, true);
    if (!SILVER_TONGUE_JOBS.hasOwnProperty(job)) {
      return Util.fail(Code.INVALID_ARGUMENT, "unknown_job: " + job + " is not a Silver Tongue job");
    }
    const venue = Util.str(req, "venue", 32, true);
    if (venue !== SILVER_TONGUE_JOBS[job].venue) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_venue: " + job + " is at " + SILVER_TONGUE_JOBS[job].venue);
    }
    const report: Report = {
      job: job,
      venue: venue,
      circuit: Util.int(req, "circuit", 0, 2147483647, 0),
      win: Util.bool(req, "win", false),
      clean: Util.bool(req, "clean", false),
      quiet: Util.bool(req, "quiet", false),
      silver: Util.bool(req, "silver", false),
      take: Util.int(req, "take", 0, 100000, 0),
    };
    if (!report.win && (report.take > 0 || report.clean || report.quiet || report.silver)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_result: a job that failed has no take or marks");
    }
    if (report.take > maxTake(job, report.circuit)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_take: " + job + " pays at most " + maxTake(job, report.circuit));
    }
    return report;
  }

  function parseMemories(raw: any): { [character: string]: string[] } {
    const out: { [character: string]: string[] } = {};
    if (raw === undefined || raw === null) {
      return out;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_memory: memories must be an object of character ids");
    }
    let count = 0;
    for (const id in raw) {
      if (!raw.hasOwnProperty(id)) {
        continue;
      }
      if (!Util.isSlug(id, 48) || ++count > 40) {
        return Util.fail(Code.INVALID_ARGUMENT, "bad_memory: bad character id " + id);
      }
      const lines = raw[id];
      if (!Array.isArray(lines) || lines.length > 20) {
        return Util.fail(Code.INVALID_ARGUMENT, "bad_memory: " + id + " needs a list of lines");
      }
      const kept: string[] = [];
      for (let i = Math.max(0, lines.length - MAX_LINES); i < lines.length; i++) {
        if (typeof lines[i] !== "string") {
          return Util.fail(Code.INVALID_ARGUMENT, "bad_memory: lines are strings");
        }
        kept.push(lines[i].substring(0, MAX_LINE_CHARS));
      }
      out[id] = kept;
    }
    return out;
  }

  export function parsePlayers(raw: any): ReportedPlayer[] {
    const max = GAME_SILVER_TONGUE.rooms!.maxPlayers;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) {
      return Util.fail(Code.INVALID_ARGUMENT, "players must list 1 to " + max + " players");
    }
    const out: ReportedPlayer[] = [];
    const seen: { [id: string]: boolean } = {};
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (!p || typeof p !== "object") {
        return Util.fail(Code.INVALID_ARGUMENT, "each player must be an object");
      }
      const userId = Util.str(p, "user_id", 36, true);
      if (seen[userId]) {
        return Util.fail(Code.INVALID_ARGUMENT, "duplicate player " + userId);
      }
      seen[userId] = true;
      out.push({ user_id: userId, held: Util.bool(p, "held", false), memories: parseMemories(p["memories"]) });
    }
    return out;
  }

  function inc(s: { [key: string]: any }, k: string, by: number): void {
    s[k] = (typeof s[k] === "number" ? s[k] : 0) + by;
  }

  /** The player's counters after a job. Marks only count on a win. */
  export function addJob(current: { [key: string]: any } | null, r: Report, p: ReportedPlayer): { [key: string]: any } {
    const s = current || {};
    inc(s, "tries", 1);
    inc(s, "jobs", r.win ? 1 : 0);
    inc(s, "clean", r.win && r.clean ? 1 : 0);
    inc(s, "quiet", r.win && r.quiet ? 1 : 0);
    inc(s, "silver", r.win && r.silver ? 1 : 0);
    inc(s, "take", r.take);
    inc(s, "held", p.held ? 1 : 0);
    inc(s, "circuit_nights", r.circuit !== 0 ? 1 : 0);
    return s;
  }

  // Memory -----------------------------------------------------------------

  /** A stored memory object with every field present and well-formed. */
  export function memoryOf(raw: { [key: string]: any } | null): Memory {
    const m: Memory = { burned: false, faces: 0, take: 0, memories: {}, done: {} };
    if (!raw) {
      return m;
    }
    m.burned = raw["burned"] === true;
    m.faces = typeof raw["faces"] === "number" ? raw["faces"] : 0;
    m.take = typeof raw["take"] === "number" ? raw["take"] : 0;
    if (raw["memories"] && typeof raw["memories"] === "object") {
      m.memories = raw["memories"];
    }
    if (raw["done"] && typeof raw["done"] === "object") {
      m.done = raw["done"];
    }
    return m;
  }

  /** Drop the oldest lines of whoever remembers the most until the object fits its collection. */
  export function trimMemory(m: Memory): void {
    while (Util.byteLength(JSON.stringify(m)) > MEMORY_MAX_BYTES) {
      let from: string[] | null = null;
      for (const venue in m.memories) {
        for (const id in m.memories[venue]) {
          const lines = m.memories[venue][id];
          if (lines.length > 0 && (from === null || lines.length > from.length)) {
            from = lines;
          }
        }
      }
      if (from === null) {
        return;
      }
      from.shift();
    }
  }

  /** The crew member's memory after a job. A held face burns until a new one is bought; nothing clears it here. */
  export function applyJob(current: { [key: string]: any } | null, r: Report, p: ReportedPlayer): Memory {
    const m = memoryOf(current);
    if (p.held) {
      m.burned = true;
    }
    m.take += r.take;
    const here = m.memories[r.venue] || {};
    for (const id in p.memories) {
      const old = Array.isArray(here[id]) ? here[id] : [];
      here[id] = old.concat(p.memories[id]).slice(-MAX_LINES);
    }
    m.memories[r.venue] = here;
    if (r.circuit === 0 && r.win) {
      const d = m.done[r.job] || { clean: false, quiet: false, silver: false, take: 0 };
      m.done[r.job] = {
        clean: d.clean === true || r.clean,
        quiet: d.quiet === true || r.quiet,
        silver: d.silver === true || r.silver,
        take: Math.max(typeof d.take === "number" ? d.take : 0, r.take),
      };
    }
    trimMemory(m);
    return m;
  }

  // The Switchboard --------------------------------------------------------

  export interface Upstream {
    url: string;
    key: string;
    model: string;
    userBudget: number;
    dailyCap: number;
  }

  function positive(v: string, fallback: number): number {
    const n = parseInt(v, 10);
    return n > 0 ? n : fallback;
  }

  /** The upstream model server from the runtime env, or null when the Switchboard is off. */
  export function upstream(ctx: nkruntime.Context): Upstream | null {
    const url = Util.env(ctx, "SWITCHBOARD_URL", "").replace(/\/+$/, "");
    if (url === "") {
      return null;
    }
    return {
      url: url,
      key: Util.env(ctx, "SWITCHBOARD_KEY", ""),
      model: Util.env(ctx, "SWITCHBOARD_MODEL", ""),
      userBudget: positive(Util.env(ctx, "SWITCHBOARD_USER_BUDGET", ""), DEFAULT_USER_BUDGET),
      dailyCap: positive(Util.env(ctx, "SWITCHBOARD_DAILY_CAP", ""), DEFAULT_DAILY_CAP),
    };
  }

  /** The UTC day, "2026-10-17". */
  export function dayOf(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString().substring(0, 10);
  }

  /** Checked messages: their roles and text, at most MAX_PROMPT_CHARS between them. */
  export function parseMessages(raw: any): { role: string; content: string }[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 60) {
      return Util.fail(Code.INVALID_ARGUMENT, "messages must list 1 to 60 messages");
    }
    const out: { role: string; content: string }[] = [];
    let chars = 0;
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i];
      if (!m || typeof m !== "object" || ROLES.indexOf(m["role"]) < 0 || typeof m["content"] !== "string") {
        return Util.fail(Code.INVALID_ARGUMENT, "each message needs a role (system, user or assistant) and a text content");
      }
      chars += m["content"].length;
      out.push({ role: m["role"], content: m["content"] });
    }
    if (chars > MAX_PROMPT_CHARS) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_large: messages are over " + MAX_PROMPT_CHARS + " characters");
    }
    return out;
  }

  /** What a request is charged up front: the prompt at three characters a token, plus the longest reply it may get. */
  export function estimateTokens(messages: { content: string }[], maxTokens: number): number {
    let chars = 0;
    for (let i = 0; i < messages.length; i++) {
      chars += messages[i].content.length;
    }
    return Math.ceil(chars / 3) + maxTokens;
  }

  /** A day's token count, reset when the day has changed. */
  function dayRecord(current: { [key: string]: any } | null, today: string): { date: string; tokens: number } {
    if (current && current["date"] === today && typeof current["tokens"] === "number") {
      return { date: today, tokens: current["tokens"] };
    }
    return { date: today, tokens: 0 };
  }

  /** The record after charging `cost` tokens against `limit`, or null when that goes over it. */
  export function spend(current: { [key: string]: any } | null, today: string, cost: number, limit: number): { date: string; tokens: number } | null {
    const r = dayRecord(current, today);
    if (r.tokens + cost > limit) {
      return null;
    }
    r.tokens += cost;
    return r;
  }

  /** The record after giving `amount` tokens back (an unused estimate, or a failed call). */
  export function refund(current: { [key: string]: any } | null, today: string, amount: number): { date: string; tokens: number } {
    const r = dayRecord(current, today);
    r.tokens = Math.max(0, r.tokens - amount);
    return r;
  }

  /** Tokens left of `limit` today. */
  export function left(current: { [key: string]: any } | null, today: string, limit: number): number {
    return Math.max(0, limit - dayRecord(current, today).tokens);
  }

  /** The request body for an OpenAI-compatible chat completion. */
  export function upstreamBody(up: Upstream, messages: { role: string; content: string }[], maxTokens: number, schema: any): string {
    const body: { [key: string]: any } = { messages: messages, max_tokens: maxTokens, stream: false };
    if (up.model !== "") {
      body["model"] = up.model;
    }
    if (schema) {
      body["response_format"] = { type: "json_schema", json_schema: { name: "reply", strict: true, schema: schema } };
    }
    return JSON.stringify(body);
  }

  /** The reply text and token counts from an upstream response body, or null when it has no reply. */
  export function parseUpstream(body: string, promptEstimate: number): { text: string; prompt_tokens: number; completion_tokens: number } | null {
    let res: any;
    try {
      res = JSON.parse(body);
    } catch (e) {
      return null;
    }
    const choice = res && Array.isArray(res.choices) ? res.choices[0] : null;
    if (!choice || !choice.message || typeof choice.message.content !== "string") {
      return null;
    }
    const text: string = choice.message.content;
    const usage = res.usage || {};
    return {
      text: text,
      prompt_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : promptEstimate,
      completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : Math.ceil(text.length / 3),
    };
  }
}

function silverTongueGame(ctx: nkruntime.Context): Registry.GameDef {
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_SILVER_TONGUE.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Silver Tongue sessions");
  }
  return game;
}

/**
 * silver-tongue.job_report — the host reports a finished job (won or not).
 * Bots and puppets are left out of `players`; only signed-in crew are credited.
 * {match_id, round, job, circuit, win, clean, quiet, silver, take, venue,
 *  players: [{user_id, held, memories: {character_id: [lines]}}]} -> {ok, round}
 */
function rpcSilverTongueJobReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = silverTongueGame(ctx);
  const req = Util.parsePayload(payload);
  const matchId = Util.str(req, "match_id", 128, true);
  const round = Util.int(req, "round", 1, 1000);
  const report = SilverTongue.parseReport(req);
  const players = SilverTongue.parsePlayers(req["players"]);
  RateLimit.check(nk, userId, "silver-tongue.job_report", 30, 3600);

  const roster = Rooms.roster(nk, game, matchId);
  if (roster.host !== "" && roster.host !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only the host reports jobs");
  }
  if (roster.host === "" && roster.present.indexOf(userId) < 0) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only players in the room report jobs");
  }
  for (let i = 0; i < players.length; i++) {
    if (roster.members.indexOf(players[i].user_id) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "not_in_room: " + players[i].user_id + " is not in this room");
    }
  }

  // Rooms live in memory and end within hours, so an in-memory marker is
  // enough to stop the same job being counted twice.
  const marker = "silver-tongue:job:" + matchId + ":" + round;
  if (nk.localcacheGet(marker)) {
    return Util.fail(Code.ALREADY_EXISTS, "already_reported: round " + round + " was already recorded");
  }
  nk.localcachePut(marker, true, 7 * 3600);

  const ids: string[] = [];
  for (let i = 0; i < players.length; i++) {
    ids.push(players[i].user_id);
  }
  const usernames: { [id: string]: string } = {};
  const users = nk.usersGetId(ids);
  for (let i = 0; i < users.length; i++) {
    usernames[users[i].userId] = users[i].username;
  }

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const name = usernames[p.user_id] || "";
    Objects.update(nk, game.id + ".stats", SilverTongue.STATS_KEY, p.user_id, 2, function (current) {
      return SilverTongue.addJob(current, report, p);
    });
    Objects.update(nk, game.id + ".memory", SilverTongue.MEMORY_KEY, p.user_id, 1, function (current) {
      return SilverTongue.applyJob(current, report, p) as any;
    });
    if (report.win) {
      Leaderboards.write(nk, game, "jobs", p.user_id, name, 1, 0, undefined);
      Leaderboards.write(nk, game, "jobs_weekly", p.user_id, name, 1, 0, undefined);
      if (report.clean) {
        Leaderboards.write(nk, game, "clean_jobs", p.user_id, name, 1, 0, undefined);
      }
      if (report.take > 0) {
        Leaderboards.write(nk, game, "take", p.user_id, name, report.take, 0, undefined);
      }
    }
  }
  logger.info("Silver Tongue job %s round %d in %s: %s, %d players", report.job, round, matchId, report.win ? "won" : "failed", players.length);
  Telemetry.count(nk, Telemetry.METRIC.ROUNDS, { game: game.id, outcome: report.win ? (report.circuit !== 0 ? "circuit_won" : "job_won") : "job_failed" });
  Telemetry.count(nk, Telemetry.METRIC.ROUND_PLAYERS, { game: game.id }, players.length);
  return JSON.stringify({ ok: true, round: round });
}

/** silver-tongue.memory — the caller's own memory object. {} -> {burned, faces, take, memories, done} */
function rpcSilverTongueMemory(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = silverTongueGame(ctx);
  const found = nk.storageRead([{ collection: game.id + ".memory", key: SilverTongue.MEMORY_KEY, userId: userId }]);
  return JSON.stringify(SilverTongue.memoryOf(found.length > 0 ? found[0].value : null));
}

/** silver-tongue.buy_face — a burned crew member pays for a new face. {} -> the new memory object */
function rpcSilverTongueBuyFace(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = silverTongueGame(ctx);
  RateLimit.check(nk, userId, "silver-tongue.buy_face", 20, 3600);
  const next = Objects.update(nk, game.id + ".memory", SilverTongue.MEMORY_KEY, userId, 1, function (current) {
    const m = SilverTongue.memoryOf(current);
    if (!m.burned || m.take < SilverTongue.FACE_PRICE) {
      return Util.fail(Code.FAILED_PRECONDITION, "cannot_buy: a new face needs a burned face and $" + SilverTongue.FACE_PRICE);
    }
    m.take -= SilverTongue.FACE_PRICE;
    m.burned = false;
    m.faces += 1;
    return m as any;
  });
  return JSON.stringify(SilverTongue.memoryOf(next));
}

/**
 * silver-tongue.switchboard — one chat completion from the server's model, for
 * hosts without a GPU. Only the host's prompts go through it.
 * {messages: [{role, content}], max_tokens?, json_schema?}
 * -> {text, usage: {prompt_tokens, completion_tokens}, left}
 */
function rpcSilverTongueSwitchboard(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = silverTongueGame(ctx);
  const up = SilverTongue.upstream(ctx);
  if (!up) {
    return Util.fail(Code.UNAVAILABLE, "switchboard_off: this server has no model to lend");
  }
  const req = Util.parsePayload(payload);
  const messages = SilverTongue.parseMessages(req["messages"]);
  const maxTokens = Util.int(req, "max_tokens", 1, SilverTongue.MAX_REPLY_TOKENS, 256);
  let schema: any = null;
  if (req["json_schema"] !== undefined && req["json_schema"] !== null) {
    if (typeof req["json_schema"] !== "object" || Array.isArray(req["json_schema"]) || Util.byteLength(JSON.stringify(req["json_schema"])) > SilverTongue.MAX_SCHEMA_BYTES) {
      return Util.fail(Code.INVALID_ARGUMENT, "json_schema must be a JSON object of 8 KB or less");
    }
    schema = req["json_schema"];
  }
  RateLimit.check(nk, userId, "silver-tongue.switchboard", 30, 60);

  // Charge the estimate up front, the account first and then the server.
  const today = SilverTongue.dayOf(Util.nowSeconds());
  const cost = SilverTongue.estimateTokens(messages, maxTokens);
  const collection = game.id + ".switchboard";
  const own = function (change: (current: { [key: string]: any } | null) => { [key: string]: any }) {
    return Objects.update(nk, collection, SilverTongue.DAILY_KEY, userId, 1, change);
  };
  const total = function (change: (current: { [key: string]: any } | null) => { [key: string]: any }) {
    return Objects.update(nk, collection, SilverTongue.TOTAL_KEY, SYSTEM_USER_ID, 0, change);
  };
  const giveBack = function (amount: number) {
    return {
      mine: own(function (current) { return SilverTongue.refund(current, today, amount); }),
      all: total(function (current) { return SilverTongue.refund(current, today, amount); }),
    };
  };
  let mine = own(function (current) {
    const r = SilverTongue.spend(current, today, cost, up.userBudget);
    return r || Util.fail(Code.RESOURCE_EXHAUSTED, "switchboard_budget: this account's tokens for today are used up");
  });
  try {
    total(function (current) {
      const r = SilverTongue.spend(current, today, cost, up.dailyCap);
      return r || Util.fail(Code.RESOURCE_EXHAUSTED, "switchboard_budget: the server's tokens for today are used up");
    });
  } catch (e) {
    own(function (current) { return SilverTongue.refund(current, today, cost); });
    Telemetry.count(nk, Telemetry.METRIC.SWITCHBOARD_CALLS, { game: game.id, outcome: "budget" });
    throw e;
  }

  const headers: { [key: string]: string } = { "Content-Type": "application/json", Accept: "application/json" };
  if (up.key !== "") {
    headers["Authorization"] = "Bearer " + up.key;
  }
  let reply: { text: string; prompt_tokens: number; completion_tokens: number } | null = null;
  try {
    const res = nk.httpRequest(up.url + "/chat/completions", "post", headers, SilverTongue.upstreamBody(up, messages, maxTokens, schema), 20000);
    if (res.code >= 200 && res.code < 300) {
      reply = SilverTongue.parseUpstream(res.body, cost - maxTokens);
    } else {
      logger.warn("Switchboard upstream answered %d", res.code);
    }
  } catch (e) {
    // The message of a transport error can carry the URL; log only that it failed.
    logger.warn("Switchboard upstream did not answer");
  }
  if (!reply) {
    giveBack(cost);
    Telemetry.count(nk, Telemetry.METRIC.SWITCHBOARD_CALLS, { game: game.id, outcome: "error" });
    return Util.fail(Code.UNAVAILABLE, "switchboard_error: the server's model did not answer, try again");
  }

  // Keep the charge to what the call used when that is less than the estimate.
  const used = reply.prompt_tokens + reply.completion_tokens;
  if (used < cost) {
    mine = giveBack(cost - used).mine;
  }
  Telemetry.count(nk, Telemetry.METRIC.SWITCHBOARD_CALLS, { game: game.id, outcome: "ok" });
  return JSON.stringify({
    text: reply.text,
    usage: { prompt_tokens: reply.prompt_tokens, completion_tokens: reply.completion_tokens },
    left: SilverTongue.left(mine, today, up.userBudget),
  });
}
