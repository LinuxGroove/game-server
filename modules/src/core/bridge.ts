// Rooms for Godot games that use nakama-godot's NakamaMultiplayerBridge.
//
// The bridge plays over Nakama relayed matches: the server passes messages
// between players and the clients elect the host themselves (the first player
// in a named room, or the lowest session id after matchmaking). The server
// can't see inside relayed matches, so these hooks check what they can at
// the door:
//   - a session can only create or join rooms named "<game>:<CODE>" for its
//     own game, never an unnamed one;
//   - a room stops admitting new players at the game's maxPlayers;
//   - the player who opened a room is remembered as its host, so result
//     reports can be checked.
// Nakama derives a named room's match id from its name (UUIDv5), which is
// how the hooks find the room a name refers to.

const RELAYED_MATCH_STREAM = 5; // Nakama's StreamModeMatchRelayed

namespace Bridge {
  export const CODE_PATTERN = /^[A-Z0-9]{4,16}$/;
  /** Remember rooms for as long as players might still be in them. */
  const ROOM_TTL_SEC = 8 * 3600;

  /** Relayed match ids are "<uuid>." (no node name). */
  export function isRelayedId(matchId: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.$/.test(matchId);
  }

  export function uuidOf(matchId: string): string {
    return matchId.substr(0, 36);
  }

  export function requireBridge(game: Registry.GameDef): Registry.RoomsDef {
    if (!game.rooms) {
      return Util.fail(Code.FAILED_PRECONDITION, "rooms_disabled: " + game.id + " has no online rooms");
    }
    if (game.rooms.transport !== "bridge") {
      return Util.fail(Code.FAILED_PRECONDITION, "use_room_rpcs: " + game.id + " rooms are created with core.room_create");
    }
    return game.rooms;
  }

  /** Distinct users in a relayed match. */
  export function members(nk: nkruntime.Nakama, uuid: string): string[] {
    const presences = nk.streamUserList({ mode: RELAYED_MATCH_STREAM, subject: uuid }, true, true) || [];
    const users: string[] = [];
    for (let i = 0; i < presences.length; i++) {
      if (users.indexOf(presences[i].userId) < 0) {
        users.push(presences[i].userId);
      }
    }
    return users;
  }

  /** The game and host of a named room, from when it was opened. */
  export function remembered(nk: nkruntime.Nakama, uuid: string): { game: string; host: string } | null {
    const v = nk.localcacheGet("bridge:" + uuid);
    if (typeof v !== "string" || v.indexOf(" ") < 0) {
      return null;
    }
    const i = v.indexOf(" ");
    return { game: v.substr(0, i), host: v.substr(i + 1) };
  }

  export function remember(nk: nkruntime.Nakama, uuid: string, game: string, host: string): void {
    // Local cache values must be plain strings or numbers.
    nk.localcachePut("bridge:" + uuid, game + " " + host, ROOM_TTL_SEC);
  }

  /** Refuse a newcomer when the room is full. Players already in may rejoin. */
  export function checkRoomSize(nk: nkruntime.Nakama, rooms: Registry.RoomsDef, uuid: string, userId: string): string[] {
    const users = members(nk, uuid);
    if (users.indexOf(userId) < 0 && users.length >= rooms.maxPlayers) {
      return Util.fail(Code.RESOURCE_EXHAUSTED, "room_full: the room already has " + rooms.maxPlayers + " players");
    }
    return users;
  }
}

/** Creating (or joining) a room by name: socket.create_match_async(name). */
function beforeMatchCreate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.EnvelopeMatchCreateMessage,
): nkruntime.EnvelopeMatchCreateMessage {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const rooms = Bridge.requireBridge(game);
  const msg: { [key: string]: any } = envelope.matchCreate || {};
  const name = typeof msg["name"] === "string" ? msg["name"] : "";
  const prefix = game.id + ":";
  if (name.indexOf(prefix) !== 0 || !Bridge.CODE_PATTERN.test(name.substr(prefix.length))) {
    return Util.fail(
      Code.INVALID_ARGUMENT,
      "bad_room_name: rooms are named " + prefix + "<CODE>, with a code of 4-16 capital letters and digits",
    );
  }
  RateLimit.check(nk, userId, "room_join", 30, 60);
  const uuid = Uuid.v5dns(name);
  const users = Bridge.checkRoomSize(nk, rooms, uuid, userId);
  if (users.length === 0) {
    // The bridge makes the first player in a named room its host.
    Bridge.remember(nk, uuid, game.id, userId);
    Telemetry.count(nk, Telemetry.METRIC.ROOMS_OPENED, { game: game.id, transport: "bridge", source: "code" });
  }
  return envelope;
}

/** Joining by match id. Matchmaker tokens and server-run relay rooms pass. */
function beforeMatchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.EnvelopeMatchJoin,
): nkruntime.EnvelopeMatchJoin {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const msg: { [key: string]: any } = envelope.matchJoin || {};
  const matchId = typeof msg["matchId"] === "string" ? msg["matchId"] : "";
  if (!Bridge.isRelayedId(matchId)) {
    return envelope;
  }
  const rooms = Bridge.requireBridge(game);
  const uuid = Bridge.uuidOf(matchId);
  const room = Bridge.remembered(nk, uuid);
  if (!room || room.game !== game.id) {
    return Util.fail(Code.NOT_FOUND, "room_not_found: join rooms by name, " + game.id + ":<CODE>");
  }
  Bridge.checkRoomSize(nk, rooms, uuid, userId);
  return envelope;
}
