// Game telemetry: Prometheus counters for logins, daily players, retention,
// rooms, rounds and feature use, per game.
//
// Nakama exposes these on its metrics port (snap setting metrics.port) next
// to its own metrics. Telemetry must never break a game, so every write is
// best effort, and label values come only from the game registry or small
// fixed lists: clients choose their version and platform strings, and a
// label that takes any value would let one client create unlimited series.
//
// Every use of a metric name must pass the same tag keys, or Prometheus
// refuses the later registration. The METRIC table below is the single list.

namespace Telemetry {
  /** Metric names, and the tag keys each one always carries. */
  export const METRIC = {
    // game, version, platform, method (device|custom|email|steam), new (account created)
    LOGINS: "logins",
    // game, reason (missing_game, bad_vars, unknown_game, bad_version, update_required)
    LOGINS_REJECTED: "logins_rejected",
    // game: first login of the UTC day, per player and game (daily actives)
    ACTIVE_PLAYERS: "active_players",
    // game: first ever login to this game
    NEW_PLAYERS: "new_players",
    // game, day (d1|d7|d30): came back exactly N days after their first day
    RETURNING_PLAYERS: "returning_players",
    // game, transport (relay|bridge), source (code|matchmaker)
    ROOMS_OPENED: "rooms_opened",
    // game, reason (empty, host_left, host_missing, expired, closed, server_shutdown)
    ROOMS_CLOSED: "rooms_closed",
    // game: summed over closed relay rooms, for average length and size
    ROOM_SECONDS: "room_seconds",
    ROOM_PLAYERS: "room_players",
    // game
    MATCHMAKER_MATCHES: "matchmaker_matches",
    // game, outcome (game-specific, from a fixed list)
    ROUNDS: "rounds",
    // game
    ROUND_PLAYERS: "round_players",
    // game, board
    SCORES_SUBMITTED: "scores_submitted",
    // game, kind
    BLOB_UPLOADS: "blob_uploads",
    BLOB_DOWNLOADS: "blob_downloads",
    SHARES_CREATED: "shares_created",
    // game
    SHARES_OPENED: "shares_opened",
    SHARE_REPORTS: "share_reports",
    // game
    ACCOUNT_DELETIONS: "account_deletions",
  };

  /** Platforms reported as themselves; anything else is "other". */
  export const PLATFORMS = ["linux", "ubuntu", "ubuntu-core", "steamos", "windows", "macos", "android", "ios", "web"];

  /**
   * Distinct client versions tracked per game before the rest become "other".
   * Games version edge builds by commit (2026.41.0+3.g1a2b3c4d), so this
   * leaves room for a busy week of edge builds between server restarts.
   */
  export const MAX_VERSIONS = 64;

  /** Per-player activity, one object per game: {first, last} as YYYY-MM-DD. */
  export const ACTIVITY = "core.activity";

  /** Days after a player's first day that count as "returning". */
  const RETURN_DAYS = [1, 7, 30];

  /**
   * Register each enabled game's per-game counters at 0 on startup.
   * Prometheus' increase() can't see the first event of a series that didn't
   * exist yet, which would undercount daily players and retention after
   * every restart.
   */
  export function init(ctx: nkruntime.Context, nk: nkruntime.Nakama): void {
    for (let i = 0; i < Registry.GAMES.length; i++) {
      const g = Registry.GAMES[i];
      if (!Registry.isEnabled(ctx, g)) {
        continue;
      }
      const game = { game: g.id };
      count(nk, METRIC.ACTIVE_PLAYERS, game, 0);
      count(nk, METRIC.NEW_PLAYERS, game, 0);
      for (let j = 0; j < RETURN_DAYS.length; j++) {
        count(nk, METRIC.RETURNING_PLAYERS, { game: g.id, day: "d" + RETURN_DAYS[j] }, 0);
      }
      count(nk, METRIC.ACCOUNT_DELETIONS, game, 0);
      if (g.rooms) {
        count(nk, METRIC.MATCHMAKER_MATCHES, game, 0);
        count(nk, METRIC.ROUND_PLAYERS, game, 0);
        count(nk, METRIC.ROOM_SECONDS, game, 0);
        count(nk, METRIC.ROOM_PLAYERS, game, 0);
      }
    }
  }

  /** Add to a counter. Never throws. */
  export function count(nk: nkruntime.Nakama, name: string, tags: { [key: string]: string }, delta?: number): void {
    try {
      nk.metricsCounterAdd(name, tags, delta === undefined ? 1 : delta);
    } catch (e) {
      // Metrics are best effort.
    }
  }

  export function platformLabel(platform: string | undefined): string {
    if (!platform) {
      return "unknown";
    }
    return PLATFORMS.indexOf(platform) >= 0 ? platform : "other";
  }

  /**
   * The version as a label. The first MAX_VERSIONS distinct versions seen
   * per game since the server started keep their own label.
   */
  export function versionLabel(nk: nkruntime.Nakama, game: string, version: string | undefined): string {
    if (!version || !Util.isVersion(version)) {
      return "unknown";
    }
    const key = "telemetry:versions:" + game;
    let seen = "";
    try {
      const v = nk.localcacheGet(key);
      seen = typeof v === "string" ? v : "";
      const list = seen === "" ? [] : seen.split(" ");
      if (list.indexOf(version) >= 0) {
        return version;
      }
      if (list.length >= MAX_VERSIONS) {
        return "other";
      }
      list.push(version);
      // Local cache values must be plain strings or numbers.
      nk.localcachePut(key, list.join(" "), 0);
    } catch (e) {
      return "other";
    }
    return version;
  }

  /** The error slug of a Util.fail message ("update_required: ..." -> "update_required"). */
  export function reasonOf(err: any): string {
    const message = err && typeof err.message === "string" ? err.message : "";
    const m = /^([a-z_]+):/.exec(message);
    return m ? m[1] : "other";
  }

  /** YYYY-MM-DD in UTC. */
  export function day(d: Date): string {
    return d.toISOString().substr(0, 10);
  }

  /** Whole days from one YYYY-MM-DD to another. */
  export function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
  }

  /**
   * Record a successful login: the login itself, and the first login of the
   * day per player and game for daily actives, new players and retention.
   */
  export function login(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    vars: { [key: string]: string } | null | undefined,
    method: string,
    created: boolean,
  ): void {
    const game = vars ? Registry.find(ctx, vars["game"] || "") : null;
    if (!game || !vars) {
      return;
    }
    count(nk, METRIC.LOGINS, {
      game: game.id,
      version: versionLabel(nk, game.id, vars["version"]),
      platform: platformLabel(vars["platform"]),
      method: method,
      new: created ? "true" : "false",
    });
    if (ctx.userId) {
      try {
        activity(nk, game.id, ctx.userId, day(new Date()));
      } catch (e) {
        // Storage trouble must not fail a login.
      }
    }
  }

  /** Update a player's activity for today; counts at most once per day. */
  export function activity(nk: nkruntime.Nakama, game: string, userId: string, today: string): void {
    const found = nk.storageRead([{ collection: ACTIVITY, key: game, userId: userId }]);
    const current = found.length > 0 ? found[0] : null;
    const first: string = current && typeof current.value["first"] === "string" ? current.value["first"] : "";
    if (current && current.value["last"] === today) {
      return;
    }
    try {
      nk.storageWrite([
        {
          collection: ACTIVITY,
          key: game,
          userId: userId,
          value: { first: first || today, last: today },
          version: current ? current.version : "*",
          permissionRead: 0,
          permissionWrite: 0,
        },
      ]);
    } catch (e) {
      // Another login of the same player got there first and counted it.
      return;
    }
    count(nk, METRIC.ACTIVE_PLAYERS, { game: game });
    if (!first) {
      count(nk, METRIC.NEW_PLAYERS, { game: game });
      return;
    }
    const n = daysBetween(first, today);
    if (RETURN_DAYS.indexOf(n) >= 0) {
      count(nk, METRIC.RETURNING_PLAYERS, { game: game, day: "d" + n });
    }
  }

  /** Run a login check, counting a rejection by its reason before rethrowing. */
  export function checkLogin(ctx: nkruntime.Context, nk: nkruntime.Nakama, vars: { [key: string]: string } | null | undefined, check: () => void): void {
    try {
      check();
    } catch (e) {
      const id = vars && typeof vars["game"] === "string" ? vars["game"] : "";
      const game = Registry.find(ctx, id);
      count(nk, METRIC.LOGINS_REJECTED, { game: game ? game.id : "unknown", reason: reasonOf(e) });
      throw e;
    }
  }
}
