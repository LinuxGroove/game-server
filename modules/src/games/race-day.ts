// Race Day: grand prix racing (game-ideas, idea 20), with AI drivers filling
// the grid.
//
// Online play uses bridge rooms: Godot's high-level multiplayer over Nakama
// relayed matches named "race-day:<CODE>", the same game code as LAN. The
// host's device runs the race and reports the result when it ends. AI drivers
// and split-screen guests (extra players on one device) aren't reported; each
// device's signed-in account is. Time Trial laps go straight to the lap boards
// through core.score_submit.

/** Most cars on a grid, so the lowest finishing position. */
const RACE_DAY_MAX_POSITION = 20;

/** Every layout id (Circuits.ids() in the game), each with a Time Trial board. */
const RACE_DAY_LAYOUTS = [
  "greenfield", "greenfield_club",
  "port_lumen", "port_lumen_reverse",
  "monte_pineta", "monte_pineta_junior",
  "ardenwood", "ardenwood_reverse",
  "kingsfield", "kingsfield_international",
  "twin_bridges", "twin_bridges_reverse",
  "sandhaven", "sandhaven_reverse",
  "neon_marina", "neon_marina_short",
  "sierra_alta", "sierra_alta_reverse",
  "lakeside_isle", "lakeside_isle_reverse",
  "hay_valley", "hay_valley_reverse",
  "bellwood", "bellwood_oval",
  "cliffside", "cliffside_reverse",
  "misty_hills", "misty_hills_reverse",
  "redrock_canyon", "redrock_canyon_national",
  "harbour_lights", "harbour_lights_short",
  "proving",
];

/** Best Time Trial lap per layout, "lap_<layout>", in milliseconds (20 s to 10 min). */
const RACE_DAY_LAP_BOARDS = RACE_DAY_LAYOUTS.map(function (layout): Registry.LeaderboardDef {
  return { id: "lap_" + layout, sort: "asc", operator: "best", reset: null, clientSubmit: true, minScore: 20000, maxScore: 600000, enableRank: true };
});

const GAME_RACE_DAY: Registry.GameDef = {
  id: "race-day",
  name: "Race Day",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: ([] as Registry.LeaderboardDef[]).concat([
    // Races won, all time and per week (resets Monday 00:00 UTC).
    { id: "wins", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    { id: "wins_weekly", sort: "desc", operator: "incr", reset: "0 0 * * 1", clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    // Top-three finishes and pole positions, all time.
    { id: "podiums", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    { id: "poles", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
  ], RACE_DAY_LAP_BOARDS),
  collections: [
    // Race statistics, written by the server from host reports.
    { name: "stats", clientWrite: false, maxBytes: 0, read: "public" },
  ],
  blobs: [],
  shares: [],
  // tickRate, mode and hostGraceSec only apply to relay rooms.
  rooms: { transport: "bridge", minPlayers: 2, maxPlayers: 8, tickRate: 20, mode: "host", matchmaking: true, hostGraceSec: 15 },
};

namespace RaceDay {
  export const STATS_KEY = "stats";

  export interface ReportedPlayer {
    user_id: string;
    position: number;
    won: boolean;
    podium: boolean;
    pole: boolean;
    fastest: boolean;
  }

  /** A layout id from a report; the game's ids may use '-' where boards use '_'. */
  export function parseCircuit(raw: string): string {
    const id = raw.replace(/-/g, "_");
    if (RACE_DAY_LAYOUTS.indexOf(id) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "unknown_circuit: " + raw + " is not a Race Day layout");
    }
    return id;
  }

  export function parsePlayers(raw: any): ReportedPlayer[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > GAME_RACE_DAY.rooms!.maxPlayers) {
      return Util.fail(Code.INVALID_ARGUMENT, "players must list 1 to " + GAME_RACE_DAY.rooms!.maxPlayers + " players");
    }
    const out: ReportedPlayer[] = [];
    const seen: { [id: string]: boolean } = {};
    let winners = 0;
    let poles = 0;
    let fastest = 0;
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
        position: Util.int(p, "position", 1, RACE_DAY_MAX_POSITION),
        won: Util.bool(p, "won", false),
        podium: Util.bool(p, "podium", false),
        pole: Util.bool(p, "pole", false),
        fastest: Util.bool(p, "fastest", false),
      };
      // A retired car can be classified in a podium place without the podium,
      // but never the other way round.
      if (player.won && player.position !== 1) {
        return Util.fail(Code.INVALID_ARGUMENT, "bad_result: only the car in first place wins");
      }
      if (player.podium && player.position > 3) {
        return Util.fail(Code.INVALID_ARGUMENT, "bad_result: only the top three finish on the podium");
      }
      winners += player.won ? 1 : 0;
      poles += player.pole ? 1 : 0;
      fastest += player.fastest ? 1 : 0;
      out.push(player);
    }
    if (winners > 1 || poles > 1 || fastest > 1) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_many_winners: a race has one winner, one pole and one fastest lap");
    }
    return out;
  }

  export function addRace(current: { [key: string]: any } | null, p: ReportedPlayer): { [key: string]: any } {
    const s = current || {};
    const inc = function (k: string, by: number) {
      s[k] = (typeof s[k] === "number" ? s[k] : 0) + by;
    };
    inc("races", 1);
    inc("wins", p.won ? 1 : 0);
    inc("podiums", p.podium ? 1 : 0);
    inc("poles", p.pole ? 1 : 0);
    inc("fastest_laps", p.fastest ? 1 : 0);
    if (typeof s["best_finish"] !== "number" || p.position < s["best_finish"]) {
      s["best_finish"] = p.position;
    }
    return s;
  }
}

/**
 * race-day.race_report — the host reports a finished race.
 * {match_id, round, circuit: "<layout id>",
 *  players: [{user_id, position, won, podium, pole, fastest}]} -> {recorded}
 */
function rpcRaceDayRaceReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_RACE_DAY.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Race Day sessions");
  }
  const req = Util.parsePayload(payload);
  const matchId = Util.str(req, "match_id", 128, true);
  const round = Util.int(req, "round", 1, 10000);
  const circuit = RaceDay.parseCircuit(Util.str(req, "circuit", 48, true));
  const players = RaceDay.parsePlayers(req["players"]);
  RateLimit.check(nk, userId, "race-day.race_report", 60, 3600);

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
  const marker = "race-day:race:" + matchId + ":" + round;
  if (nk.localcacheGet(marker)) {
    return Util.fail(Code.ALREADY_EXISTS, "already_reported: race " + round + " was already recorded");
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
    Objects.update(nk, game.id + ".stats", RaceDay.STATS_KEY, p.user_id, 2, function (current) {
      return RaceDay.addRace(current, p);
    });
    if (p.won) {
      Leaderboards.write(nk, game, "wins", p.user_id, name, 1, 0, undefined);
      Leaderboards.write(nk, game, "wins_weekly", p.user_id, name, 1, 0, undefined);
    }
    if (p.podium) {
      Leaderboards.write(nk, game, "podiums", p.user_id, name, 1, 0, undefined);
    }
    if (p.pole) {
      Leaderboards.write(nk, game, "poles", p.user_id, name, 1, 0, undefined);
    }
  }
  logger.info("Race Day race %d at %s in %s: %d players reported", round, circuit, matchId, players.length);
  Telemetry.count(nk, Telemetry.METRIC.ROUNDS, { game: game.id, outcome: circuit });
  Telemetry.count(nk, Telemetry.METRIC.ROUND_PLAYERS, { game: game.id }, players.length);
  return JSON.stringify({ recorded: players.length });
}
