// The game registry: every game this server knows, and what each may use.
//
// One Nakama instance and one database serve every game, so everything a game
// owns is namespaced by its id: leaderboards are "<game>.<board>", storage
// collections "<game>.<name>", blob keys "<game>/<kind>/...", and rooms carry
// the game in their label. A player's session names the game it was opened
// for (session var "game"), and every hook and RPC checks against that.

namespace Registry {
  export type ScoreValidator = (
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    userId: string,
    score: number,
    subscore: number,
    metadata: { [key: string]: any },
  ) => void;

  export interface LeaderboardDef {
    /** Short id. The Nakama leaderboard id is "<game>.<id>". */
    id: string;
    sort: "asc" | "desc";
    operator: "best" | "set" | "incr" | "decr";
    /** Cron expression for resets (UTC), or null to keep records forever. */
    reset: string | null;
    /** Whether players may submit through core.score_submit. */
    clientSubmit: boolean;
    minScore: number;
    maxScore: number;
    /** Rank tracking costs memory, so only boards that show ranks enable it. */
    enableRank: boolean;
    /** Extra game-specific checks. Throw (Util.fail) to reject a score. */
    validate?: ScoreValidator;
  }

  export interface CollectionDef {
    /** Short name. The Nakama collection is "<game>.<name>". */
    name: string;
    /** Players may write and delete their own objects directly. */
    clientWrite: boolean;
    maxBytes: number;
    /** The widest read permission players may set: owner only, or public. */
    read: "owner" | "public";
  }

  export interface BlobKindDef {
    /** Short name, used in object keys: "<game>/<kind>/<user>/<id>". */
    name: string;
    maxBytes: number;
    contentTypes: string[];
    uploadsPerHour: number;
  }

  export type ShareValidator = (
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    userId: string,
    data: string,
    meta: { [key: string]: any },
  ) => void;

  export interface ShareKindDef {
    name: string;
    maxBytes: number;
    perUserLimit: number;
    validate?: ShareValidator;
  }

  export interface RoomsDef {
    /**
     * "bridge": Nakama relayed matches named "<game>:<CODE>", for Godot games
     * using nakama-godot's NakamaMultiplayerBridge (Godot's high-level
     * multiplayer API, the same game code as LAN). The server checks names,
     * room size and who created each room; the host election is the bridge's.
     * "relay": server-run "relay" matches with join codes from core.room_*,
     * public listing, locking and kicks (see relay.ts).
     */
    transport: "bridge" | "relay";
    minPlayers: number;
    maxPlayers: number;
    /** Relay ticks per second. Messages are forwarded once per tick. (relay) */
    tickRate: number;
    /**
     * "host": one player is the authority. Others can only send to the host,
     * and the room closes if the host is gone longer than hostGraceSec.
     * "broadcast": anyone may send to anyone, and the host role (room
     * settings only) moves to another player when the host leaves. (relay)
     */
    mode: "host" | "broadcast";
    matchmaking: boolean;
    hostGraceSec: number;
  }

  export interface GameDef {
    /** Lower-case slug used in every namespace. Never change it once live. */
    id: string;
    name: string;
    /** Clients older than this are refused at login. Overridable per server. */
    minVersion: string;
    /** Newest client release, so older clients can suggest an update. */
    latestVersion: string;
    /** Games are on by default; test fixtures are off unless enabled. */
    enabledByDefault: boolean;
    /** Free-text chat channels. Off by default (family-friendly default). */
    chat: boolean;
    leaderboards: LeaderboardDef[];
    collections: CollectionDef[];
    blobs: BlobKindDef[];
    shares: ShareKindDef[];
    rooms: RoomsDef | null;
  }

  /** Filled in by games/index.ts, after every game file has loaded. */
  export const GAMES: GameDef[] = [];

  /** Runtime env key for a per-game override, e.g. GAME_LANTERN_OUT_MIN_VERSION. */
  export function envKey(gameId: string, setting: string): string {
    return "GAME_" + gameId.toUpperCase().replace(/-/g, "_") + "_" + setting;
  }

  export function isEnabled(ctx: nkruntime.Context, game: GameDef): boolean {
    const v = Util.env(ctx, envKey(game.id, "ENABLED"), "");
    if (v === "") {
      return game.enabledByDefault;
    }
    return v === "true" || v === "1" || v === "yes";
  }

  /** A registered, enabled game, or null. */
  export function find(ctx: nkruntime.Context, id: string): GameDef | null {
    for (let i = 0; i < GAMES.length; i++) {
      if (GAMES[i].id === id) {
        return isEnabled(ctx, GAMES[i]) ? GAMES[i] : null;
      }
    }
    return null;
  }

  export function minVersion(ctx: nkruntime.Context, game: GameDef): string {
    return Util.env(ctx, envKey(game.id, "MIN_VERSION"), game.minVersion);
  }

  export function latestVersion(ctx: nkruntime.Context, game: GameDef): string {
    return Util.env(ctx, envKey(game.id, "LATEST_VERSION"), game.latestVersion);
  }

  /** The game the caller's session was opened for. */
  export function forSession(ctx: nkruntime.Context): GameDef {
    const id = ctx.vars ? ctx.vars["game"] : undefined;
    if (!id) {
      return Util.fail(Code.UNAUTHENTICATED, "no_game: log in again with the session var 'game' set");
    }
    const game = find(ctx, id);
    if (!game) {
      return Util.fail(Code.FAILED_PRECONDITION, "unknown_game: " + id + " is not enabled on this server");
    }
    return game;
  }

  export function leaderboard(game: GameDef, id: string): LeaderboardDef | null {
    for (let i = 0; i < game.leaderboards.length; i++) {
      if (game.leaderboards[i].id === id) {
        return game.leaderboards[i];
      }
    }
    return null;
  }

  export function leaderboardId(game: GameDef, id: string): string {
    return game.id + "." + id;
  }

  export function collection(game: GameDef, name: string): CollectionDef | null {
    for (let i = 0; i < game.collections.length; i++) {
      if (game.collections[i].name === name) {
        return game.collections[i];
      }
    }
    return null;
  }

  export function blobKind(game: GameDef, name: string): BlobKindDef | null {
    for (let i = 0; i < game.blobs.length; i++) {
      if (game.blobs[i].name === name) {
        return game.blobs[i];
      }
    }
    return null;
  }

  export function shareKind(game: GameDef, name: string): ShareKindDef | null {
    for (let i = 0; i < game.shares.length; i++) {
      if (game.shares[i].name === name) {
        return game.shares[i];
      }
    }
    return null;
  }

  /** Catch mistakes in game definitions at startup instead of at runtime. */
  export function validateAll(): string[] {
    const errors: string[] = [];
    const seen: { [id: string]: boolean } = {};
    for (let i = 0; i < GAMES.length; i++) {
      const g = GAMES[i];
      const where = "game " + g.id + ": ";
      if (!Util.isSlug(g.id, 32) || g.id.indexOf("_") >= 0) {
        errors.push(where + "id must be a lower-case slug of letters, digits and '-'");
      }
      if (g.id === "core") {
        errors.push(where + "'core' is reserved for shared server data");
      }
      if (seen[g.id]) {
        errors.push(where + "duplicate id");
      }
      seen[g.id] = true;
      if (!Util.isVersion(g.minVersion) || !Util.isVersion(g.latestVersion)) {
        errors.push(where + "minVersion and latestVersion must be versions like 1.2.3");
      }
      const names: { [n: string]: boolean } = {};
      const check = (kind: string, name: string) => {
        if (!Util.isSlug(name, 48)) {
          errors.push(where + kind + " '" + name + "' must be a lower-case slug");
        }
        if (names[kind + ":" + name]) {
          errors.push(where + "duplicate " + kind + " '" + name + "'");
        }
        names[kind + ":" + name] = true;
      };
      for (let j = 0; j < g.leaderboards.length; j++) {
        const b = g.leaderboards[j];
        check("leaderboard", b.id);
        if (b.minScore > b.maxScore) {
          errors.push(where + "leaderboard " + b.id + " has minScore above maxScore");
        }
      }
      for (let j = 0; j < g.collections.length; j++) {
        check("collection", g.collections[j].name);
        if (g.collections[j].name === "shares") {
          errors.push(where + "collection 'shares' is reserved for share codes");
        }
      }
      for (let j = 0; j < g.blobs.length; j++) {
        check("blob kind", g.blobs[j].name);
      }
      for (let j = 0; j < g.shares.length; j++) {
        check("share kind", g.shares[j].name);
      }
      if (g.rooms) {
        const r = g.rooms;
        if (r.minPlayers < 1 || r.maxPlayers < r.minPlayers || r.maxPlayers > 64) {
          errors.push(where + "rooms need 1 <= minPlayers <= maxPlayers <= 64");
        }
        if (r.tickRate < 1 || r.tickRate > 60) {
          errors.push(where + "rooms tickRate must be 1 to 60");
        }
        if (r.transport !== "bridge" && r.transport !== "relay") {
          errors.push(where + "rooms transport must be bridge or relay");
        }
      }
    }
    return errors;
  }
}
