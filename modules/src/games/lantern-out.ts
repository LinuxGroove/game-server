// Lantern Out: social deduction for 4-10 players (game-ideas, idea 14).
//
// Online play uses relay rooms in "host" mode: the host's device runs the
// round, holds every secret role, and sends each player only what that
// player may see (targeted relay messages). The server never sees roles
// until the host reports the result at the end of a round.

const GAME_LANTERN_OUT: Registry.GameDef = {
  id: "lantern-out",
  name: "Lantern Out",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [
    // Rounds won, all time and per week (resets Monday 00:00 UTC).
    { id: "wins", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
    { id: "wins_weekly", sort: "desc", operator: "incr", reset: "0 0 * * 1", clientSubmit: false, minScore: 0, maxScore: 1, enableRank: true },
  ],
  collections: [
    // What other players see: chosen colour, hat, lantern style.
    { name: "profile", clientWrite: true, maxBytes: 4096, read: "public" },
    // Unlocked roles, maps and cosmetics, synced between a player's devices.
    { name: "progress", clientWrite: true, maxBytes: 32768, read: "owner" },
    // Round statistics, written by the server from host reports.
    { name: "stats", clientWrite: false, maxBytes: 0, read: "public" },
  ],
  blobs: [],
  shares: [],
  rooms: { minPlayers: 4, maxPlayers: 10, tickRate: 20, mode: "host", matchmaking: true, hostGraceSec: 20 },
};

namespace LanternOut {
  export const STATS_KEY = "stats";
  export const TEAMS = ["village", "hollow"];

  export interface ReportedPlayer {
    user_id: string;
    team: string;
    survived: boolean;
  }

  export function parsePlayers(raw: any): ReportedPlayer[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > GAME_LANTERN_OUT.rooms!.maxPlayers) {
      return Util.fail(Code.INVALID_ARGUMENT, "players must list 1 to " + GAME_LANTERN_OUT.rooms!.maxPlayers + " players");
    }
    const out: ReportedPlayer[] = [];
    const seen: { [id: string]: boolean } = {};
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (!p || typeof p !== "object") {
        return Util.fail(Code.INVALID_ARGUMENT, "each player must be an object");
      }
      const userId = Util.str(p, "user_id", 36, true);
      const team = Util.str(p, "team", 16, true);
      if (TEAMS.indexOf(team) < 0) {
        return Util.fail(Code.INVALID_ARGUMENT, "team must be village or hollow");
      }
      if (seen[userId]) {
        return Util.fail(Code.INVALID_ARGUMENT, "duplicate player " + userId);
      }
      seen[userId] = true;
      out.push({ user_id: userId, team: team, survived: Util.bool(p, "survived", false) });
    }
    return out;
  }

  export function addRound(current: { [key: string]: any } | null, team: string, won: boolean, survived: boolean): { [key: string]: any } {
    const s = current || {};
    const inc = function (k: string, by: number) {
      s[k] = (typeof s[k] === "number" ? s[k] : 0) + by;
    };
    inc("rounds", 1);
    inc("wins", won ? 1 : 0);
    inc(team + "_rounds", 1);
    inc(team + "_wins", won ? 1 : 0);
    inc("survived", survived ? 1 : 0);
    return s;
  }
}

/**
 * lantern-out.round_report — the host reports a finished round.
 * {match_id, round, winner: "village"|"hollow", players: [{user_id, team, survived}]}
 * -> {recorded}
 */
function rpcLanternOutRoundReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_LANTERN_OUT.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for Lantern Out sessions");
  }
  const req = Util.parsePayload(payload);
  const matchId = Util.str(req, "match_id", 128, true);
  const round = Util.int(req, "round", 1, 1000);
  const winner = Util.str(req, "winner", 16, true);
  if (LanternOut.TEAMS.indexOf(winner) < 0) {
    return Util.fail(Code.INVALID_ARGUMENT, "winner must be village or hollow");
  }
  const players = LanternOut.parsePlayers(req["players"]);
  RateLimit.check(nk, userId, "lantern-out.round_report", 30, 3600);

  let roster: any;
  try {
    roster = JSON.parse(nk.matchSignal(matchId, JSON.stringify({ op: "roster" })));
  } catch (e) {
    return Util.fail(Code.NOT_FOUND, "room_not_found: the room has closed");
  }
  if (!roster || roster.game !== game.id) {
    return Util.fail(Code.NOT_FOUND, "room_not_found: not a Lantern Out room");
  }
  if (roster.host_user_id !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_host: only the host reports rounds");
  }
  const seen: string[] = roster.seen || [];
  for (let i = 0; i < players.length; i++) {
    if (seen.indexOf(players[i].user_id) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "not_in_room: " + players[i].user_id + " never joined this room");
    }
  }

  // Rooms live in memory and end within hours, so an in-memory marker is
  // enough to stop the same round being counted twice.
  const marker = "lantern-out:round:" + matchId + ":" + round;
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
    const won = p.team === winner;
    Objects.update(nk, game.id + ".stats", LanternOut.STATS_KEY, p.user_id, 2, function (current) {
      return LanternOut.addRound(current, p.team, won, p.survived);
    });
    if (won) {
      Leaderboards.write(nk, game, "wins", p.user_id, usernames[p.user_id] || "", 1, 0, undefined);
      Leaderboards.write(nk, game, "wins_weekly", p.user_id, usernames[p.user_id] || "", 1, 0, undefined);
    }
  }
  logger.info("Lantern Out round %d in %s: %s won, %d players", round, matchId, winner, players.length);
  return JSON.stringify({ recorded: players.length });
}
