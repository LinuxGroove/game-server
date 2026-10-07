// Foam Frenzy: foam-dart arena battles for 2-8 players.
//
// Online play uses bridge rooms: Godot's high-level multiplayer over Nakama
// relayed matches named "foam-frenzy:<CODE>", the same game code as LAN. The
// host's device runs the match and reports the result when it ends. Bots and
// couch guests (extra players on one device) aren't reported; each device's
// signed-in account is.

/** Most tags one player can plausibly score in a match. */
const FOAM_FRENZY_MAX_TAGS = 500;

const GAME_FOAM_FRENZY: Registry.GameDef = {
  id: "foam-frenzy",
  name: "Foam Frenzy",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [
    // Matches won, all time and per week (resets Monday 00:00 UTC).
    { id: "wins", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    { id: "wins_weekly", sort: "desc", operator: "incr", reset: "0 0 * * 1", clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    // Campers tagged, all time.
    { id: "tags", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: FOAM_FRENZY_MAX_TAGS, enableRank: true },
  ],
  collections: [
    // What other players see: camper look and colours.
    { name: "profile", clientWrite: true, maxBytes: 4096, read: "public" },
    // Unlocks and preferences, synced between a player's devices.
    { name: "progress", clientWrite: true, maxBytes: 32768, read: "owner" },
    // Match statistics, written by the server from host reports.
    { name: "stats", clientWrite: false, maxBytes: 0, read: "public" },
  ],
  blobs: [],
  shares: [],
  // tickRate, mode and hostGraceSec only apply to relay rooms.
  rooms: { transport: "bridge", minPlayers: 2, maxPlayers: 8, tickRate: 20, mode: "host", matchmaking: true, hostGraceSec: 15 },
};

namespace FoamFrenzy {
  export const STATS_KEY = "stats";
  /** Rules.MODE_KEYS in the game. */
  export const MODES = ["ffa", "teams", "ctf", "hoarder"];

  export interface ReportedPlayer {
    user_id: string;
    tags: number;
    outs: number;
    captures: number;
    won: boolean;
  }

  export function parsePlayers(raw: any): ReportedPlayer[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > GAME_FOAM_FRENZY.rooms!.maxPlayers) {
      return Util.fail(Code.INVALID_ARGUMENT, "players must list 1 to " + GAME_FOAM_FRENZY.rooms!.maxPlayers + " players");
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
      out.push({
        user_id: userId,
        tags: Util.int(p, "tags", 0, FOAM_FRENZY_MAX_TAGS, 0),
        outs: Util.int(p, "outs", 0, FOAM_FRENZY_MAX_TAGS, 0),
        captures: Util.int(p, "captures", 0, 100, 0),
        won: Util.bool(p, "won", false),
      });
    }
    return out;
  }

  export function addMatch(current: { [key: string]: any } | null, mode: string, p: ReportedPlayer): { [key: string]: any } {
    const s = current || {};
    const inc = function (k: string, by: number) {
      s[k] = (typeof s[k] === "number" ? s[k] : 0) + by;
    };
    inc("matches", 1);
    inc("wins", p.won ? 1 : 0);
    inc(mode + "_matches", 1);
    inc(mode + "_wins", p.won ? 1 : 0);
    inc("tags", p.tags);
    inc("outs", p.outs);
    inc("captures", p.captures);
    return s;
  }
}

/**
 * foam-frenzy.match_report — the host reports a finished match.
 * {match_id, round, mode: "ffa"|"teams"|"ctf"|"hoarder",
 *  players: [{user_id, tags, outs, captures, won}]} -> {recorded}
 */
function rpcFoamFrenzyMatchReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_FOAM_FRENZY.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Foam Frenzy sessions");
  }
  const req = Util.parsePayload(payload);
  const matchId = Util.str(req, "match_id", 128, true);
  const round = Util.int(req, "round", 1, 10000);
  const mode = Util.str(req, "mode", 16, true);
  if (FoamFrenzy.MODES.indexOf(mode) < 0) {
    return Util.fail(Code.INVALID_ARGUMENT, "mode must be one of " + FoamFrenzy.MODES.join(", "));
  }
  const players = FoamFrenzy.parsePlayers(req["players"]);
  RateLimit.check(nk, userId, "foam-frenzy.match_report", 60, 3600);

  const roster = Rooms.roster(nk, game, matchId);
  if (roster.host !== "" && roster.host !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only the host reports matches");
  }
  if (roster.host === "" && roster.present.indexOf(userId) < 0) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only players in the room report matches");
  }
  for (let i = 0; i < players.length; i++) {
    if (roster.members.indexOf(players[i].user_id) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "not_in_room: " + players[i].user_id + " is not in this room");
    }
  }

  // Rooms live in memory and end within hours, so an in-memory marker is
  // enough to stop the same match being counted twice.
  const marker = "foam-frenzy:match:" + matchId + ":" + round;
  if (nk.localcacheGet(marker)) {
    return Util.fail(Code.ALREADY_EXISTS, "already_reported: match " + round + " was already recorded");
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
    Objects.update(nk, game.id + ".stats", FoamFrenzy.STATS_KEY, p.user_id, 2, function (current) {
      return FoamFrenzy.addMatch(current, mode, p);
    });
    if (p.won) {
      Leaderboards.write(nk, game, "wins", p.user_id, name, 1, 0, undefined);
      Leaderboards.write(nk, game, "wins_weekly", p.user_id, name, 1, 0, undefined);
    }
    if (p.tags > 0) {
      Leaderboards.write(nk, game, "tags", p.user_id, name, p.tags, 0, undefined);
    }
  }
  logger.info("Foam Frenzy %s match %d in %s: %d players reported", mode, round, matchId, players.length);
  Telemetry.count(nk, Telemetry.METRIC.ROUNDS, { game: game.id, outcome: mode });
  Telemetry.count(nk, Telemetry.METRIC.ROUND_PLAYERS, { game: game.id }, players.length);
  return JSON.stringify({ recorded: players.length });
}
