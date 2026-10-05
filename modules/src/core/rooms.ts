// Online rooms: create with a join code, find by code, list public rooms,
// and matchmaker results. Every room is a "relay" match (see relay.ts).

namespace Rooms {
  export const CODE_LENGTH = 6;

  function query(game: Registry.GameDef, extra: string): string {
    return "+label.game:" + game.id + (extra ? " " + extra : "");
  }

  export function findByCode(nk: nkruntime.Nakama, game: Registry.GameDef, code: string): nkruntime.Match | null {
    const found = nk.matchList(1, true, null, null, null, query(game, "+label.code:" + code));
    return found.length > 0 ? found[0] : null;
  }

  /** Create a relay room and return its match id and join code. */
  export function create(
    nk: nkruntime.Nakama,
    game: Registry.GameDef,
    opts: { host: string; allowed: string; listed: boolean; maxPlayers: number; meta: { [key: string]: any } },
  ): { matchId: string; code: string } {
    let code = "";
    for (let attempt = 0; attempt < 5 && !code; attempt++) {
      const candidate = Util.randomCode(nk, CODE_LENGTH);
      if (!findByCode(nk, game, candidate)) {
        code = candidate;
      }
    }
    if (!code) {
      return Util.fail(Code.UNAVAILABLE, "no_code: could not allocate a room code, try again");
    }
    const matchId = nk.matchCreate(Relay.MODULE, {
      game: game.id,
      code: code,
      host: opts.host,
      allowed: opts.allowed,
      listed: opts.listed,
      max_players: opts.maxPlayers,
      meta: opts.meta,
    });
    return { matchId: matchId, code: code };
  }

  export function describe(m: nkruntime.Match): any {
    let label: any = {};
    try {
      label = JSON.parse(m.label);
    } catch (e) {
      label = {};
    }
    return {
      match_id: m.matchId,
      code: label.code,
      players: label.players,
      max_players: label.max,
      open: label.open,
      mode: label.mode,
      meta: label.meta || {},
    };
  }

  /** Keep matchmaker tickets inside the session's game. */
  export function tagTicket(
    game: Registry.GameDef,
    msg: { query: string; stringProperties: { [key: string]: string }; maxCount: number; minCount: number },
  ): void {
    const rooms = game.rooms as Registry.RoomsDef;
    msg.stringProperties = msg.stringProperties || {};
    msg.stringProperties["game"] = game.id;
    const q = (msg.query || "").replace(/^\s+|\s+$/g, "");
    msg.query = "+properties.game:" + game.id + (q && q !== "*" ? " " + q : "");
    if (msg.maxCount > rooms.maxPlayers) {
      msg.maxCount = rooms.maxPlayers;
    }
    if (msg.minCount > msg.maxCount) {
      msg.minCount = msg.maxCount;
    }
  }

  export function requireRooms(game: Registry.GameDef): Registry.RoomsDef {
    if (!game.rooms) {
      return Util.fail(Code.FAILED_PRECONDITION, "rooms_disabled: " + game.id + " has no online rooms");
    }
    return game.rooms;
  }
}

/** core.room_create {max_players?, listed?, meta?} -> {match_id, code} */
function rpcRoomCreate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const rooms = Rooms.requireRooms(game);
  const req = Util.parsePayload(payload);
  const maxPlayers = Util.int(req, "max_players", rooms.minPlayers, rooms.maxPlayers, rooms.maxPlayers);
  const listed = Util.bool(req, "listed", false);
  const meta = Relay.checkMeta(req["meta"]);
  if (typeof meta === "string") {
    return Util.fail(Code.INVALID_ARGUMENT, meta);
  }
  RateLimit.check(nk, userId, "room_create", 10, 60);
  const room = Rooms.create(nk, game, { host: userId, allowed: "", listed: listed, maxPlayers: maxPlayers, meta: meta });
  return JSON.stringify({ match_id: room.matchId, code: room.code });
}

/** core.room_find {code} -> {match_id, code, players, max_players, open, mode, meta} */
function rpcRoomFind(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  Rooms.requireRooms(game);
  const req = Util.parsePayload(payload);
  const code = Util.normaliseCode(Util.str(req, "code", 16, true));
  if (!Util.isCode(code, Rooms.CODE_LENGTH)) {
    return Util.fail(Code.INVALID_ARGUMENT, "bad_code: room codes are " + Rooms.CODE_LENGTH + " letters and digits");
  }
  RateLimit.check(nk, userId, "room_find", 30, 60);
  const match = Rooms.findByCode(nk, game, code);
  if (!match) {
    return Util.fail(Code.NOT_FOUND, "room_not_found: no open room with code " + code);
  }
  return JSON.stringify(Rooms.describe(match));
}

/** core.room_list {limit?} -> {rooms: [...]} (listed rooms with free seats) */
function rpcRoomList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  Rooms.requireRooms(game);
  const req = Util.parsePayload(payload);
  const limit = Util.int(req, "limit", 1, 50, 20);
  const matches = nk.matchList(limit, true, null, null, null, "+label.game:" + game.id + " +label.listed:T +label.open:T");
  const rooms: any[] = [];
  for (let i = 0; i < matches.length; i++) {
    rooms.push(Rooms.describe(matches[i]));
  }
  return JSON.stringify({ rooms: rooms });
}

/** Matchmaker results become a relay room reserved for the matched players. */
function matchmakerMatched(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  matches: nkruntime.MatchmakerResult[],
): string | void {
  if (matches.length === 0) {
    return;
  }
  const game = Registry.find(ctx, matches[0].properties["game"] || "");
  if (!game || !game.rooms || !game.rooms.matchmaking) {
    logger.warn("Matchmaker result without a known game, falling back to a relayed match");
    return;
  }
  const users: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    users.push(matches[i].presence.userId);
  }
  const room = Rooms.create(nk, game, {
    host: "",
    allowed: users.join(","),
    listed: false,
    maxPlayers: users.length,
    meta: {},
  });
  return room.matchId;
}
