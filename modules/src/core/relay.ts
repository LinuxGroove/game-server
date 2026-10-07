// "relay": the authoritative match handler every game's online rooms use.
//
// It doesn't run gameplay. One player's device is the host and runs the game,
// exactly like LAN mode, and the relay forwards messages between the host and
// the other players. The server enforces who can join (game, room size,
// invitations, kicks), who may talk to whom, and keeps the room's public
// label up to date for listing and join codes.
//
// Wire format, for every game message (opcode >= 100):
//   byte 0       number of target slots N (0 = default destination)
//   bytes 1..N   target slots
//   rest         game payload, forwarded untouched
// Receivers get only the payload, with the sender's presence attached.
// Default destination: in "host" mode the host for everyone else, and
// everyone else for the host; in "broadcast" mode everyone else.
// In "host" mode non-hosts can only reach the host, whatever they target.
//
// Opcodes 1-99 are relay control messages with JSON payloads (see OP).

namespace Relay {
  export const MODULE = "relay";
  export const FIRST_GAME_OPCODE = 100;

  export const OP = {
    // Server to players.
    WELCOME: 1,
    PEER_JOINED: 2,
    PEER_LEFT: 3,
    HOST: 4,
    ROOM: 5,
    CLOSING: 6,
    KICKED: 7,
    ERROR: 8,
    // Host to server.
    SET_ROOM: 20,
    KICK: 21,
    CLOSE: 22,
  };

  export const EMPTY_TIMEOUT_SEC = 60;
  export const MAX_LIFETIME_SEC = 6 * 3600;
  const MAX_META_KEYS = 8;

  export interface Player {
    slot: number;
    userId: string;
    sessionId: string;
    username: string;
    node: string;
  }

  export interface State {
    game: string;
    code: string;
    mode: string;
    maxPlayers: number;
    tickRate: number;
    listed: boolean;
    locked: boolean;
    meta: { [key: string]: any };
    /** The user who must be host (the room creator), or "". */
    reservedHost: string;
    /** Current host user, or "" before anyone has taken the role. */
    hostUserId: string;
    /** Tick the host left at, or -1 while the host is here. */
    hostAwaySince: number;
    hostGraceSec: number;
    /** Comma-separated user ids allowed in (matchmaker rooms), or "". */
    allowed: string;
    /** Present players by session id. */
    players: { [sessionId: string]: Player };
    /** Slot per user, kept after they leave so a rejoin gets the same slot. */
    slots: { [userId: string]: number };
    nextSlot: number;
    /** Everyone who was ever in the room, for result reports. */
    seen: { [userId: string]: boolean };
    kicked: { [userId: string]: boolean };
    emptySince: number;
    closing: string;
  }

  export function playerCount(s: State): number {
    const users: { [u: string]: boolean } = {};
    let n = 0;
    for (const sid in s.players) {
      if (!users[s.players[sid].userId]) {
        users[s.players[sid].userId] = true;
        n++;
      }
    }
    return n;
  }

  export function label(s: State): string {
    const count = playerCount(s);
    return JSON.stringify({
      game: s.game,
      code: s.code,
      mode: s.mode,
      open: !s.locked && !s.closing && count < s.maxPlayers,
      listed: s.listed,
      players: count,
      max: s.maxPlayers,
      meta: s.meta,
    });
  }

  export function presenceOf(p: Player): nkruntime.Presence {
    return { userId: p.userId, sessionId: p.sessionId, username: p.username, node: p.node };
  }

  export function present(s: State, filter: (p: Player) => boolean): nkruntime.Presence[] {
    const out: nkruntime.Presence[] = [];
    for (const sid in s.players) {
      if (filter(s.players[sid])) {
        out.push(presenceOf(s.players[sid]));
      }
    }
    return out;
  }

  export function hostSlot(s: State): number {
    return s.hostUserId ? s.slots[s.hostUserId] || 0 : 0;
  }

  function hostPresent(s: State): boolean {
    return s.hostUserId !== "" && s.hostAwaySince < 0;
  }

  export function send(d: nkruntime.MatchDispatcher, op: number, body: any, to: nkruntime.Presence[] | null): void {
    if (to !== null && to.length === 0) {
      return;
    }
    d.broadcastMessage(op, JSON.stringify(body), to, null, true);
  }

  export function peers(s: State): any[] {
    const out: any[] = [];
    const done: { [u: string]: boolean } = {};
    for (const sid in s.players) {
      const p = s.players[sid];
      if (!done[p.userId]) {
        done[p.userId] = true;
        out.push({ slot: p.slot, user_id: p.userId, username: p.username });
      }
    }
    out.sort(function (a, b) {
      return a.slot - b.slot;
    });
    return out;
  }

  export function roomInfo(s: State): any {
    return { locked: s.locked, listed: s.listed, meta: s.meta };
  }

  export function announceHost(s: State, d: nkruntime.MatchDispatcher): void {
    send(d, OP.HOST, { host_slot: hostSlot(s), away: s.hostAwaySince >= 0 }, null);
  }

  /** Pick the lowest-slot present player as host (broadcast mode). */
  export function migrateHost(s: State): void {
    let best: Player | null = null;
    for (const sid in s.players) {
      const p = s.players[sid];
      if (best === null || p.slot < best.slot) {
        best = p;
      }
    }
    s.hostUserId = best ? best.userId : "";
    s.hostAwaySince = -1;
  }

  export function close(s: State, d: nkruntime.MatchDispatcher, reason: string): void {
    if (!s.closing) {
      s.closing = reason;
      send(d, OP.CLOSING, { reason: reason }, null);
    }
  }

  /** Small public key/value data the host shows in room lists. */
  export function checkMeta(meta: any): { [key: string]: any } | string {
    if (meta === undefined || meta === null) {
      return {};
    }
    if (typeof meta !== "object" || Array.isArray(meta)) {
      return "meta must be an object";
    }
    const out: { [key: string]: any } = {};
    let n = 0;
    for (const k in meta) {
      if (!Object.prototype.hasOwnProperty.call(meta, k)) {
        continue;
      }
      if (++n > MAX_META_KEYS) {
        return "meta can have at most " + MAX_META_KEYS + " keys";
      }
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) {
        return "meta keys must be short lower-case names";
      }
      const v = meta[k];
      if (typeof v === "string") {
        if (v.length > 48) {
          return "meta values must be 48 characters or less";
        }
      } else if (typeof v !== "number" && typeof v !== "boolean") {
        return "meta values must be strings, numbers or booleans";
      }
      out[k] = v;
    }
    return out;
  }

  export function handleControl(
    s: State,
    d: nkruntime.MatchDispatcher,
    nk: nkruntime.Nakama,
    sender: Player,
    msg: nkruntime.MatchMessage,
  ): void {
    const senderPresence = [presenceOf(sender)];
    if (sender.userId !== s.hostUserId) {
      send(d, OP.ERROR, { op: msg.opCode, message: "only the host can change the room" }, senderPresence);
      return;
    }
    let body: any = {};
    try {
      const text = nk.binaryToString(msg.data);
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      send(d, OP.ERROR, { op: msg.opCode, message: "control payload must be JSON" }, senderPresence);
      return;
    }
    if (body === null || typeof body !== "object") {
      body = {};
    }

    if (msg.opCode === OP.SET_ROOM) {
      if (typeof body.locked === "boolean") {
        s.locked = body.locked;
      }
      if (typeof body.listed === "boolean") {
        s.listed = body.listed;
      }
      if (body.meta !== undefined) {
        const meta = checkMeta(body.meta);
        if (typeof meta === "string") {
          send(d, OP.ERROR, { op: msg.opCode, message: meta }, senderPresence);
          return;
        }
        s.meta = meta;
      }
      d.matchLabelUpdate(label(s));
      send(d, OP.ROOM, roomInfo(s), null);
    } else if (msg.opCode === OP.KICK) {
      const slot = body.slot;
      const targets = present(s, function (p) {
        return p.slot === slot && p.userId !== s.hostUserId;
      });
      if (targets.length === 0) {
        send(d, OP.ERROR, { op: msg.opCode, message: "no player in that slot" }, senderPresence);
        return;
      }
      s.kicked[targets[0].userId] = true;
      send(d, OP.KICKED, { reason: typeof body.reason === "string" ? body.reason.substr(0, 64) : "" }, targets);
      d.matchKick(targets);
    } else if (msg.opCode === OP.CLOSE) {
      close(s, d, "closed_by_host");
    } else {
      send(d, OP.ERROR, { op: msg.opCode, message: "unknown control opcode" }, senderPresence);
    }
  }

  export function handleGameMessage(s: State, d: nkruntime.MatchDispatcher, sender: Player, msg: nkruntime.MatchMessage): void {
    const bytes = new Uint8Array(msg.data);
    if (bytes.length < 1 || bytes.length < 1 + bytes[0]) {
      send(d, OP.ERROR, { op: msg.opCode, message: "missing target header" }, [presenceOf(sender)]);
      return;
    }
    const n = bytes[0];
    const payload = msg.data.slice(1 + n);
    const isHost = sender.userId === s.hostUserId;

    let to: nkruntime.Presence[];
    if (s.mode === "host" && !isHost) {
      if (!hostPresent(s)) {
        return;
      }
      to = present(s, function (p) {
        return p.userId === s.hostUserId;
      });
    } else if (n === 0) {
      to = present(s, function (p) {
        return p.userId !== sender.userId;
      });
    } else {
      const wanted: { [slot: number]: boolean } = {};
      for (let i = 1; i <= n; i++) {
        wanted[bytes[i]] = true;
      }
      to = present(s, function (p) {
        return wanted[p.slot] === true && p.userId !== sender.userId;
      });
    }
    if (to.length > 0) {
      d.broadcastMessage(msg.opCode, payload, to, presenceOf(sender), msg.reliable);
    }
  }
}

function relayMatchInit(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: { [key: string]: any },
): { state: Relay.State; tickRate: number; label: string } {
  const game = Registry.find(ctx, String(params["game"] || ""));
  if (!game || !game.rooms || game.rooms.transport !== "relay") {
    throw new Error("relay match created for a game without relay rooms: " + params["game"]);
  }
  const rooms = game.rooms;
  const maxPlayers = Math.min(Number(params["max_players"]) || rooms.maxPlayers, rooms.maxPlayers);
  const meta = Relay.checkMeta(params["meta"]);
  const state: Relay.State = {
    game: game.id,
    code: String(params["code"] || ""),
    mode: rooms.mode,
    maxPlayers: maxPlayers,
    tickRate: rooms.tickRate,
    listed: params["listed"] === true,
    locked: false,
    meta: typeof meta === "string" ? {} : meta,
    reservedHost: String(params["host"] || ""),
    hostUserId: "",
    hostAwaySince: -1,
    hostGraceSec: rooms.hostGraceSec,
    allowed: String(params["allowed"] || ""),
    players: {},
    slots: {},
    nextSlot: 1,
    seen: {},
    kicked: {},
    emptySince: 0,
    closing: "",
  };
  return { state: state, tickRate: rooms.tickRate, label: Relay.label(state) };
}

function relayMatchJoinAttempt(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  presence: nkruntime.Presence,
  metadata: { [key: string]: any },
): { state: Relay.State; accept: boolean; rejectMessage?: string } | null {
  const reject = function (reason: string) {
    return { state: state, accept: false, rejectMessage: reason };
  };
  if (state.closing) {
    return reject("room_closing");
  }
  if (!ctx.vars || ctx.vars["game"] !== state.game) {
    return reject("wrong_game");
  }
  if (state.kicked[presence.userId]) {
    return reject("kicked");
  }
  if (state.allowed && ("," + state.allowed + ",").indexOf("," + presence.userId + ",") < 0) {
    return reject("not_invited");
  }
  let alreadyIn = false;
  for (const sid in state.players) {
    if (state.players[sid].userId === presence.userId) {
      alreadyIn = true;
    }
  }
  if (!alreadyIn) {
    if (state.locked && !state.seen[presence.userId]) {
      return reject("room_locked");
    }
    if (Relay.playerCount(state) >= state.maxPlayers) {
      return reject("room_full");
    }
    if (state.nextSlot > 255 && !state.slots[presence.userId]) {
      return reject("room_full");
    }
  }
  return { state: state, accept: true };
}

function relayMatchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  presences: nkruntime.Presence[],
): { state: Relay.State } | null {
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    // A player reconnecting from a new session replaces the old one.
    const stale: nkruntime.Presence[] = [];
    for (const sid in state.players) {
      const old = state.players[sid];
      if (old.userId === p.userId && sid !== p.sessionId) {
        stale.push({ userId: old.userId, sessionId: old.sessionId, username: old.username, node: old.node });
        delete state.players[sid];
      }
    }
    if (stale.length > 0) {
      dispatcher.matchKick(stale);
    }

    let slot = state.slots[p.userId];
    if (!slot) {
      slot = state.nextSlot++;
      state.slots[p.userId] = slot;
    }
    state.players[p.sessionId] = { slot: slot, userId: p.userId, sessionId: p.sessionId, username: p.username, node: p.node };
    state.seen[p.userId] = true;
    state.emptySince = -1;

    let hostChanged = false;
    if (state.hostUserId === "" && (state.reservedHost === "" || state.reservedHost === p.userId)) {
      state.hostUserId = p.userId;
      state.hostAwaySince = -1;
      hostChanged = true;
    } else if (state.hostUserId === p.userId && state.hostAwaySince >= 0) {
      state.hostAwaySince = -1;
      hostChanged = true;
    }

    const me = [Relay.presenceOf(state.players[p.sessionId])];
    Relay.send(
      dispatcher,
      Relay.OP.WELCOME,
      {
        slot: slot,
        host_slot: Relay.hostSlot(state),
        host_away: state.hostAwaySince >= 0,
        peers: Relay.peers(state),
        code: state.code,
        mode: state.mode,
        max_players: state.maxPlayers,
        room: Relay.roomInfo(state),
        first_game_opcode: Relay.FIRST_GAME_OPCODE,
      },
      me,
    );
    const others = Relay.present(state, function (q) {
      return q.userId !== p.userId;
    });
    Relay.send(dispatcher, Relay.OP.PEER_JOINED, { slot: slot, user_id: p.userId, username: p.username, rejoined: stale.length > 0 }, others);
    if (hostChanged) {
      Relay.announceHost(state, dispatcher);
    }
  }
  dispatcher.matchLabelUpdate(Relay.label(state));
  return { state: state };
}

function relayMatchLeave(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  presences: nkruntime.Presence[],
): { state: Relay.State } | null {
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    if (!state.players[p.sessionId]) {
      // Already replaced by a newer session of the same player.
      continue;
    }
    delete state.players[p.sessionId];
    let stillHere = false;
    for (const sid in state.players) {
      if (state.players[sid].userId === p.userId) {
        stillHere = true;
      }
    }
    if (stillHere) {
      continue;
    }
    Relay.send(dispatcher, Relay.OP.PEER_LEFT, { slot: state.slots[p.userId], user_id: p.userId }, null);
    if (p.userId === state.hostUserId) {
      if (state.mode === "host") {
        // The host's device runs the game; give it a moment to reconnect.
        state.hostAwaySince = tick;
        Relay.announceHost(state, dispatcher);
      } else {
        Relay.migrateHost(state);
        if (state.hostUserId) {
          Relay.announceHost(state, dispatcher);
        }
      }
    }
  }
  if (Relay.playerCount(state) === 0) {
    state.emptySince = tick;
  }
  dispatcher.matchLabelUpdate(Relay.label(state));
  return { state: state };
}

function relayMatchLoop(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  messages: nkruntime.MatchMessage[],
): { state: Relay.State } | null {
  if (state.closing) {
    return null;
  }
  const rate = state.tickRate;
  if (state.emptySince >= 0 && Relay.playerCount(state) === 0 && tick - state.emptySince >= Relay.EMPTY_TIMEOUT_SEC * rate) {
    return null;
  }
  if (state.hostUserId === "" && state.reservedHost !== "" && tick >= state.hostGraceSec * rate) {
    Relay.close(state, dispatcher, "host_missing");
    return null;
  }
  if (state.mode === "host" && state.hostAwaySince >= 0 && tick - state.hostAwaySince >= state.hostGraceSec * rate) {
    Relay.close(state, dispatcher, "host_left");
    return null;
  }
  if (tick >= Relay.MAX_LIFETIME_SEC * rate) {
    Relay.close(state, dispatcher, "expired");
    return null;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const sender = state.players[msg.sender.sessionId];
    if (!sender) {
      continue;
    }
    if (msg.opCode >= Relay.FIRST_GAME_OPCODE) {
      Relay.handleGameMessage(state, dispatcher, sender, msg);
    } else {
      Relay.handleControl(state, dispatcher, nk, sender, msg);
    }
    if (state.closing) {
      return null;
    }
  }
  return { state: state };
}

function relayMatchTerminate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  graceSeconds: number,
): { state: Relay.State } | null {
  Relay.close(state, dispatcher, "server_shutdown");
  return { state: state };
}

/**
 * Signals from server code: {"op": "roster"} returns who is and was in the
 * room (used to check result reports), {"op": "close"} closes it.
 */
function relayMatchSignal(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: Relay.State,
  data: string,
): { state: Relay.State; data?: string } | null {
  let req: any = {};
  try {
    req = JSON.parse(data);
  } catch (e) {
    return { state: state, data: JSON.stringify({ error: "bad signal" }) };
  }
  if (req && req.op === "close") {
    Relay.close(state, dispatcher, typeof req.reason === "string" ? req.reason : "closed");
    return { state: state, data: "{}" };
  }
  const presentUsers: string[] = [];
  const done: { [u: string]: boolean } = {};
  for (const sid in state.players) {
    if (!done[state.players[sid].userId]) {
      done[state.players[sid].userId] = true;
      presentUsers.push(state.players[sid].userId);
    }
  }
  return {
    state: state,
    data: JSON.stringify({
      game: state.game,
      code: state.code,
      host_user_id: state.hostUserId,
      present: presentUsers,
      seen: Object.keys(state.seen),
      slots: state.slots,
    }),
  };
}
