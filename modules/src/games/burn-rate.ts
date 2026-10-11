// Burn Rate: a 3D jetpack runner through a downtown tower, for one player and
// party races of 2-8 (game-ideas, idea 22).
//
// Solo runs: the game reports each finished endless run, Daily Flight and
// Course with burn-rate.run_report, which keeps the player's record and writes
// the matching board (distance per pace and lane mode, today's Daily Flight,
// or the course's best time). The boards are server-written so a run's numbers
// are checked together (a distance needs the time to fly it).
//
// Party races (Last One Flying) use bridge rooms: Godot's high-level
// multiplayer over Nakama relayed matches named "burn-rate:<CODE>", the same
// game code as LAN. The host's device runs the race and reports it when a
// pilot has won enough rounds. Bots and couch pilots (extra seats on one
// device) aren't reported; each device's signed-in account is.

/** Paces (Run.PACES in the game). */
const BURN_RATE_PACES = ["calm", "normal", "fast"];

/** Every course (Courses.LIST in the game): id and length in metres. */
const BURN_RATE_COURSES: { [id: string]: number } = {
  lab_1: 700, lab_2: 800, lab_3: 900, lab_4: 1000, lab_5: 1100,
  servers_1: 900, servers_2: 1000, servers_3: 1000, servers_4: 1100, servers_5: 1300,
  bay_1: 900, bay_2: 1000, bay_3: 1000, bay_4: 1100, bay_5: 1300,
  atrium_1: 900, atrium_2: 1000, atrium_3: 1100, atrium_4: 1100, atrium_5: 1300,
  downtown_1: 1000, downtown_2: 1100, downtown_3: 1200, downtown_4: 1300, downtown_5: 1500,
  halberd_1: 1100, halberd_2: 1200, halberd_3: 1300, halberd_4: 1400, halberd_5: 1600,
};

/**
 * Faster than any pilot flies, in metres a second: the fast pace tops out at
 * 23 m/s and the Burn adds at most 14% to that.
 */
const BURN_RATE_MAX_SPEED = 30;

/** Longest distance a board takes, in metres. */
const BURN_RATE_MAX_DISTANCE = 1000000;

/** Best time per course, "course_<id>", in milliseconds (lowest first). */
const BURN_RATE_COURSE_BOARDS = Object.keys(BURN_RATE_COURSES).map(function (id): Registry.LeaderboardDef {
  return { id: "course_" + id, sort: "asc", operator: "best", reset: null, clientSubmit: false, minScore: 10000, maxScore: 3600000, enableRank: true };
});

/** Best distance per pace, "distance_<pace>" (three lanes) and "distance_classic_<pace>" (one lane). */
const BURN_RATE_DISTANCE_BOARDS = ([] as Registry.LeaderboardDef[]).concat(
  BURN_RATE_PACES.map(function (pace): Registry.LeaderboardDef {
    return { id: "distance_" + pace, sort: "desc", operator: "best", reset: null, clientSubmit: false, minScore: 1, maxScore: BURN_RATE_MAX_DISTANCE, enableRank: true };
  }),
  BURN_RATE_PACES.map(function (pace): Registry.LeaderboardDef {
    return { id: "distance_classic_" + pace, sort: "desc", operator: "best", reset: null, clientSubmit: false, minScore: 1, maxScore: BURN_RATE_MAX_DISTANCE, enableRank: true };
  }),
);

const GAME_BURN_RATE: Registry.GameDef = {
  id: "burn-rate",
  name: "Burn Rate",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: ([] as Registry.LeaderboardDef[]).concat(
    BURN_RATE_DISTANCE_BOARDS,
    [
      // Today's Daily Flight (the same seed for everyone), best distance;
      // resets at midnight UTC.
      { id: "daily", sort: "desc", operator: "best", reset: "0 0 * * *", clientSubmit: false, minScore: 1, maxScore: BURN_RATE_MAX_DISTANCE, enableRank: true },
      // Party races won, all time.
      { id: "wins", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    ],
    BURN_RATE_COURSE_BOARDS,
  ),
  collections: [
    // Runs and party races, written by the server from reports.
    { name: "stats", clientWrite: false, maxBytes: 0, read: "public" },
  ],
  blobs: [],
  shares: [],
  // tickRate, mode and hostGraceSec only apply to relay rooms.
  rooms: { transport: "bridge", minPlayers: 2, maxPlayers: 8, tickRate: 20, mode: "host", matchmaking: true, hostGraceSec: 15 },
};

namespace BurnRate {
  export const STATS_KEY = "stats";
  export const MODES = ["endless", "daily", "course"];
  export const PACKS = ["k1", "k2", "k3", "k4", "k5", "k6"];
  /** Most rounds one party race can take (first to five, eight pilots). */
  export const MAX_ROUNDS = 40;

  export interface Run {
    mode: string;
    pace: string;
    lanes: boolean;
    seed: number;
    distance: number;
    credits: number;
    best_burn: number;
    time_ms: number;
    pack: string;
    course: string;
    finish_ms: number;
  }

  export interface ReportedPlayer {
    user_id: string;
    rounds: number;
    round_wins: number;
    won: boolean;
  }

  function oneOf(req: { [key: string]: any }, field: string, list: string[], fallback: string): string {
    const v = Util.str(req, field, 32, false) || fallback;
    if (list.indexOf(v) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_" + field + ": " + v + " is not one of " + list.join(", "));
    }
    return v;
  }

  /** A run report, checked: a distance needs the time to fly it, and a course time the course's length. */
  export function parseRun(req: { [key: string]: any }): Run {
    const run: Run = {
      mode: oneOf(req, "mode", MODES, ""),
      pace: oneOf(req, "pace", BURN_RATE_PACES, "normal"),
      lanes: Util.bool(req, "lanes", true),
      seed: Util.int(req, "seed", -9007199254740991, 9007199254740991, 0),
      distance: Util.int(req, "distance", 1, BURN_RATE_MAX_DISTANCE),
      credits: Util.int(req, "credits", 0, 100000000, 0),
      best_burn: Util.int(req, "best_burn", 1, 5, 1),
      time_ms: Util.int(req, "time_ms", 1000, 36000000),
      pack: oneOf(req, "pack", PACKS, "k1"),
      course: "",
      finish_ms: 0,
    };
    if (run.distance > (run.time_ms / 1000) * BURN_RATE_MAX_SPEED + 20) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_fast: " + run.distance + " m in " + run.time_ms + " ms");
    }
    if (run.mode === "course") {
      run.course = Util.str(req, "course", 32, true);
      const length = BURN_RATE_COURSES[run.course];
      if (length === undefined) {
        return Util.fail(Code.INVALID_ARGUMENT, "unknown_course: " + run.course + " is not a Burn Rate course");
      }
      run.finish_ms = Util.int(req, "finish_ms", 0, 3600000, 0);
      if (run.finish_ms > 0) {
        if (run.finish_ms < (length / BURN_RATE_MAX_SPEED) * 1000) {
          return Util.fail(Code.INVALID_ARGUMENT, "too_fast: " + run.course + " in " + run.finish_ms + " ms");
        }
        if (run.finish_ms > run.time_ms + 1000) {
          return Util.fail(Code.INVALID_ARGUMENT, "bad_result: finished after the run ended");
        }
      }
    }
    return run;
  }

  /** The board a run goes on, and its score, or null when it goes on none (an unfinished course). */
  export function boardFor(run: Run): { board: string; score: number } | null {
    if (run.mode === "endless") {
      return { board: (run.lanes ? "distance_" : "distance_classic_") + run.pace, score: run.distance };
    }
    if (run.mode === "daily") {
      return { board: "daily", score: run.distance };
    }
    if (run.mode === "course" && run.finish_ms > 0) {
      return { board: "course_" + run.course, score: run.finish_ms };
    }
    return null;
  }

  function inc(s: { [key: string]: any }, k: string, by: number): void {
    s[k] = (typeof s[k] === "number" ? s[k] : 0) + by;
  }

  function most(s: { [key: string]: any }, k: string, v: number): void {
    if (typeof s[k] !== "number" || v > s[k]) {
      s[k] = v;
    }
  }

  export function addRun(current: { [key: string]: any } | null, run: Run): { [key: string]: any } {
    const s = current || {};
    inc(s, "runs", 1);
    inc(s, "metres", run.distance);
    inc(s, "credits", run.credits);
    inc(s, "seconds", Math.floor(run.time_ms / 1000));
    most(s, "best_distance", run.distance);
    most(s, "best_burn", run.best_burn);
    if (run.mode === "daily") {
      inc(s, "daily_runs", 1);
    }
    if (run.mode === "course" && run.finish_ms > 0) {
      inc(s, "courses_finished", 1);
    }
    return s;
  }

  export function parsePlayers(raw: any, rounds: number): ReportedPlayer[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > GAME_BURN_RATE.rooms!.maxPlayers) {
      return Util.fail(Code.INVALID_ARGUMENT, "players must list 1 to " + GAME_BURN_RATE.rooms!.maxPlayers + " players");
    }
    const out: ReportedPlayer[] = [];
    const seen: { [id: string]: boolean } = {};
    let winners = 0;
    let roundWins = 0;
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
      const player: ReportedPlayer = {
        user_id: userId,
        rounds: Util.int(p, "rounds", 1, rounds, rounds),
        round_wins: Util.int(p, "round_wins", 0, rounds),
        won: Util.bool(p, "won", false),
      };
      if (player.won && player.round_wins < 1) {
        return Util.fail(Code.INVALID_ARGUMENT, "bad_result: the winner won no rounds");
      }
      winners += player.won ? 1 : 0;
      roundWins += player.round_wins;
      out.push(player);
    }
    if (winners > 1) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_many_winners: a race has one winner");
    }
    if (roundWins > rounds) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_result: more round wins than rounds");
    }
    return out;
  }

  export function addRace(current: { [key: string]: any } | null, p: ReportedPlayer): { [key: string]: any } {
    const s = current || {};
    inc(s, "races", 1);
    inc(s, "race_wins", p.won ? 1 : 0);
    inc(s, "rounds", p.rounds);
    inc(s, "round_wins", p.round_wins);
    return s;
  }
}

/**
 * burn-rate.run_report — a finished solo run.
 * {mode: "endless"|"daily"|"course", pace, lanes, seed, distance, credits,
 *  best_burn, time_ms, pack, course?, finish_ms?} -> {board, record}
 */
function rpcBurnRateRunReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_BURN_RATE.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Burn Rate sessions");
  }
  const run = BurnRate.parseRun(Util.parsePayload(payload));
  RateLimit.check(nk, userId, "burn-rate.run_report", 240, 3600);

  // The game sends each run once; a retry of the same run isn't counted again.
  const marker = "burn-rate:run:" + userId + ":" + run.mode + ":" + run.seed + ":" + run.distance + ":" + run.time_ms;
  if (nk.localcacheGet(marker)) {
    return Util.fail(Code.ALREADY_EXISTS, "already_reported: this run was already recorded");
  }
  nk.localcachePut(marker, true, 3600);

  Objects.update(nk, game.id + ".stats", BurnRate.STATS_KEY, userId, 2, function (current) {
    return BurnRate.addRun(current, run);
  });
  const target = BurnRate.boardFor(run);
  let record: { [key: string]: any } | null = null;
  if (target) {
    const users = nk.usersGetId([userId]);
    const name = users.length > 0 ? users[0].username : "";
    const written = Leaderboards.write(nk, game, target.board, userId, name, target.score, run.credits, { pack: run.pack, burn: run.best_burn });
    record = { score: Number(written.score), rank: Number(written.rank || 0) };
    Telemetry.count(nk, Telemetry.METRIC.SCORES_SUBMITTED, { game: game.id, board: target.board.indexOf("course_") === 0 ? "course" : target.board });
  }
  logger.debug("Burn Rate %s run by %s: %d m", run.mode, userId, run.distance);
  return JSON.stringify({ board: target ? target.board : "", record: record });
}

/**
 * burn-rate.party_report — the host reports a finished party race.
 * {match_id, race, rounds, players: [{user_id, rounds, round_wins, won}]} -> {recorded}
 */
function rpcBurnRatePartyReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_BURN_RATE.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Burn Rate sessions");
  }
  const req = Util.parsePayload(payload);
  const matchId = Util.str(req, "match_id", 128, true);
  const race = Util.int(req, "race", 1, 10000);
  const rounds = Util.int(req, "rounds", 1, BurnRate.MAX_ROUNDS);
  const players = BurnRate.parsePlayers(req["players"], rounds);
  RateLimit.check(nk, userId, "burn-rate.party_report", 60, 3600);

  const roster = Rooms.roster(nk, game, matchId);
  if (roster.host !== "" && roster.host !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only the host reports races");
  }
  if (roster.host === "" && roster.present.indexOf(userId) < 0) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only players in the room report races");
  }
  for (let i = 0; i < players.length; i++) {
    if (roster.members.indexOf(players[i].user_id) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "not_in_room: " + players[i].user_id + " is not in this room");
    }
  }

  // Rooms live in memory and end within hours, so an in-memory marker is
  // enough to stop the same race being counted twice.
  const marker = "burn-rate:race:" + matchId + ":" + race;
  if (nk.localcacheGet(marker)) {
    return Util.fail(Code.ALREADY_EXISTS, "already_reported: race " + race + " was already recorded");
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
    Objects.update(nk, game.id + ".stats", BurnRate.STATS_KEY, p.user_id, 2, function (current) {
      return BurnRate.addRace(current, p);
    });
    if (p.won) {
      Leaderboards.write(nk, game, "wins", p.user_id, usernames[p.user_id] || "", 1, 0, undefined);
    }
  }
  logger.info("Burn Rate race %d in %s: %d rounds, %d players reported", race, matchId, rounds, players.length);
  Telemetry.count(nk, Telemetry.METRIC.ROUNDS, { game: game.id, outcome: "party" });
  Telemetry.count(nk, Telemetry.METRIC.ROUND_PLAYERS, { game: game.id }, players.length);
  return JSON.stringify({ recorded: players.length });
}
