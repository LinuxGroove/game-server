// Launch pings: one anonymous request each time a game starts, so the server
// can count daily and total players of every game, signed in or not, and the
// systems and versions they play on (docs/game-api.md, "Launch pings").
//
// Games send it without signing in. Nakama only runs an RPC without a session
// when the request carries the runtime HTTP key, which must never ship in a
// game, so Caddy holds it: POST /launch becomes
// /v2/rpc/core.launch?http_key=...&unwrap (snap/local/launch-proxy and
// deploy/compose/Caddyfile). Every other RPC needs a game session, so the key
// opens nothing else.
//
// The body names the game, a random install id the game made on its first
// run (not tied to the hardware or an account), its version, OS and CPU. The
// server keeps the first and last UTC day of each install, as core.activity
// does for signed-in players, and never stores an address.

namespace Launches {
  /** {first, last} as YYYY-MM-DD, key "<game>:<install>", owned by the server. */
  export const INSTALLS = "core.installs";
  /** Running totals owned by the server: key "installs:<game>", value {n}. */
  export const COUNTS = "core.counts";
  /** Pings one address may send per minute; more are refused. */
  export const PER_MINUTE = 30;
  /** New installs one address may add per hour; more aren't counted. */
  export const NEW_PER_HOUR = 20;
  /** Distinct OS versions labelled per game and OS since the server started. */
  export const MAX_OS_VERSIONS = 16;

  /** Linux distributions by the start of their name, as Godot reports it. */
  const DISTROS: string[][] = [
    ["ubuntu core", "ubuntu-core"],
    ["ubuntu", "ubuntu"],
    ["debian", "debian"],
    ["fedora", "fedora"],
    ["arch", "arch"],
    ["steamos", "steamos"],
    ["bazzite", "bazzite"],
    ["linux mint", "mint"],
    ["pop!_os", "pop"],
    ["opensuse", "opensuse"],
    ["manjaro", "manjaro"],
    ["endeavouros", "endeavouros"],
    ["cachyos", "cachyos"],
    ["nixos", "nixos"],
  ];

  /** Other systems by Godot's OS.get_name(). */
  const SYSTEMS: { [name: string]: string } = {
    windows: "windows",
    macos: "macos",
    android: "android",
    ios: "ios",
    web: "web",
    freebsd: "bsd",
    netbsd: "bsd",
    openbsd: "bsd",
    bsd: "bsd",
  };

  /** Engine.get_architecture_name() values reported as themselves. */
  export const ARCHES = ["x86_64", "arm64", "x86_32", "arm32", "rv64", "ppc64", "loongarch64", "wasm32"];

  /**
   * Systems whose launch_systems counters start at 0 (see init): the ones
   * LinuxGroove builds for. Others lose their first launch after a restart,
   * which only matters to the by-system split, not to daily players.
   */
  const COMMON_OS = ["ubuntu", "ubuntu-core", "steamos", "windows", "macos"];
  const COMMON_ARCHES = ["x86_64", "arm64"];

  export interface Ping {
    game: string;
    install: string;
    version: string;
    os: string;
    distro: string;
    osVersion: string;
    arch: string;
  }

  /** Check a ping's body. Throws (Util.fail) when it isn't one. */
  export function parse(ctx: nkruntime.Context, body: { [key: string]: any }): Ping {
    const id = Util.str(body, "game", 32, true);
    const game = Registry.find(ctx, id);
    if (!game) {
      return Util.fail(Code.INVALID_ARGUMENT, "unknown_game: " + id + " is not enabled on this server");
    }
    const install = Util.str(body, "install", 32, true);
    if (!/^[0-9a-f]{32}$/.test(install)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_install: install must be 32 lower-case hex digits");
    }
    const version = Util.str(body, "version", 32, true);
    if (!Util.isVersion(version)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_version: version must look like 1.2.3");
    }
    return {
      game: game.id,
      install: install,
      version: version,
      os: Util.str(body, "os", 64, false),
      distro: Util.str(body, "distro", 128, false),
      osVersion: Util.str(body, "os_version", 64, false),
      arch: Util.str(body, "arch", 32, false),
    };
  }

  /** The OS as a label: a Linux distribution, another system, or other. */
  export function osLabel(os: string, distro: string): string {
    const name = os.toLowerCase();
    if (name === "linux") {
      const d = distro.toLowerCase();
      for (let i = 0; i < DISTROS.length; i++) {
        if (d.indexOf(DISTROS[i][0]) === 0) {
          return DISTROS[i][1];
        }
      }
      return "linux-other";
    }
    return SYSTEMS[name] || "other";
  }

  export function archLabel(arch: string): string {
    return ARCHES.indexOf(arch) >= 0 ? arch : "other";
  }

  /**
   * The OS version as a label: Ubuntu's 24.04, macOS 15, Windows 10 or 11.
   * The first MAX_OS_VERSIONS distinct values per game and OS since the
   * server started keep their own label.
   */
  export function osVersionLabel(nk: nkruntime.Nakama, game: string, os: string, raw: string): string {
    let v = raw;
    if (os === "windows") {
      // Godot reports 10.0.<build>; Windows 11 is build 22000 and later.
      const build = parseInt(v.split(".")[2] || "0", 10) || 0;
      v = build >= 22000 ? "11" : build > 0 ? "10" : "";
    } else if (os === "macos") {
      v = v.split(".")[0];
    } else {
      v = v.split(".").slice(0, 2).join(".");
    }
    if (!/^[0-9A-Za-z_-]+(\.[0-9A-Za-z_-]+)?$/.test(v) || v.length > 16) {
      return "unknown";
    }
    const key = "telemetry:os_versions:" + game + ":" + os;
    try {
      const cached = nk.localcacheGet(key);
      const list = typeof cached === "string" && cached !== "" ? cached.split(" ") : [];
      if (list.indexOf(v) >= 0) {
        return v;
      }
      if (list.length >= MAX_OS_VERSIONS) {
        return "other";
      }
      list.push(v);
      nk.localcachePut(key, list.join(" "), 0);
    } catch (e) {
      return "other";
    }
    return v;
  }

  /**
   * Count one launch: every launch by version and system, and an install's
   * first launch of the UTC day for daily, new and returning players.
   */
  export function record(nk: nkruntime.Nakama, ping: Ping, address: string, today: string): void {
    const os = osLabel(ping.os, ping.distro);
    const arch = archLabel(ping.arch);
    Telemetry.count(nk, Telemetry.METRIC.LAUNCHES, {
      game: ping.game,
      version: Telemetry.versionLabel(nk, ping.game, ping.version),
      os: os,
      os_version: osVersionLabel(nk, ping.game, os, ping.osVersion),
      arch: arch,
    });
    // Relaunches the same day need no database read.
    const seen = "launch:" + ping.game + ":" + ping.install;
    try {
      if (nk.localcacheGet(seen) === today) {
        return;
      }
      if (day(nk, ping.game, ping.install, os, arch, address, today)) {
        nk.localcachePut(seen, today, 86400);
      }
    } catch (e) {
      // Storage trouble must not fail a ping.
    }
  }

  /**
   * Update an install's first and last day, counting at most once per day.
   * Returns whether the install is now known to have been seen today.
   */
  export function day(nk: nkruntime.Nakama, game: string, install: string, os: string, arch: string, address: string, today: string): boolean {
    const key = game + ":" + install;
    const found = nk.storageRead([{ collection: INSTALLS, key: key, userId: SYSTEM_USER_ID }]);
    const current = found.length > 0 ? found[0] : null;
    if (current && current.value["last"] === today) {
      return true;
    }
    const first: string = current && typeof current.value["first"] === "string" ? current.value["first"] : "";
    if (!first && !newAllowed(nk, address)) {
      return false;
    }
    try {
      nk.storageWrite([
        {
          collection: INSTALLS,
          key: key,
          userId: SYSTEM_USER_ID,
          value: { first: first || today, last: today },
          version: current ? current.version : "*",
          permissionRead: 0,
          permissionWrite: 0,
        },
      ]);
    } catch (e) {
      // Another launch of the same install got there first and counted it.
      return true;
    }
    Telemetry.count(nk, Telemetry.METRIC.LAUNCH_PLAYERS, { game: game });
    Telemetry.count(nk, Telemetry.METRIC.LAUNCH_SYSTEMS, { game: game, os: os, arch: arch });
    if (!first) {
      Telemetry.count(nk, Telemetry.METRIC.NEW_INSTALLS, { game: game });
      addInstall(nk, game);
      return true;
    }
    const n = Telemetry.daysBetween(first, today);
    if (Telemetry.RETURN_DAYS.indexOf(n) >= 0) {
      Telemetry.count(nk, Telemetry.METRIC.RETURNING_INSTALLS, { game: game, day: "d" + n });
    }
    return true;
  }

  /**
   * Whether this address may add another new install this hour, so nobody
   * can inflate the numbers with made-up ids. The address only ever lives
   * in this in-memory cache.
   */
  function newAllowed(nk: nkruntime.Nakama, address: string): boolean {
    const key = "launch-new:" + address + ":" + Math.floor(Util.nowSeconds() / 3600);
    const cached = nk.localcacheGet(key);
    const n = typeof cached === "number" ? cached : 0;
    if (n >= NEW_PER_HOUR) {
      return false;
    }
    nk.localcachePut(key, n + 1, 3601);
    return true;
  }

  /** Every install a game has had, from the database (0 when unknown). */
  export function installs(nk: nkruntime.Nakama, game: string): number {
    const found = nk.storageRead([{ collection: COUNTS, key: "installs:" + game, userId: SYSTEM_USER_ID }]);
    const n = found.length > 0 ? found[0].value["n"] : 0;
    return typeof n === "number" ? n : 0;
  }

  function addInstall(nk: nkruntime.Nakama, game: string): void {
    try {
      const value = Objects.update(nk, COUNTS, "installs:" + game, SYSTEM_USER_ID, 0, function (current) {
        const n = current && typeof current["n"] === "number" ? current["n"] : 0;
        return { n: n + 1 };
      });
      Telemetry.gauge(nk, Telemetry.METRIC.INSTALLS, { game: game }, value["n"]);
    } catch (e) {
      // The total is best effort; the install itself is recorded.
    }
  }

  /**
   * Start each enabled game's launch counters at 0 (see Telemetry.init), and
   * set the installs gauge from the database, since counters restart at 0 and
   * Prometheus may not keep a game's whole history.
   */
  export function init(ctx: nkruntime.Context, nk: nkruntime.Nakama): void {
    for (let i = 0; i < Registry.GAMES.length; i++) {
      const g = Registry.GAMES[i];
      if (!Registry.isEnabled(ctx, g)) {
        continue;
      }
      Telemetry.count(nk, Telemetry.METRIC.LAUNCH_PLAYERS, { game: g.id }, 0);
      Telemetry.count(nk, Telemetry.METRIC.NEW_INSTALLS, { game: g.id }, 0);
      for (let j = 0; j < Telemetry.RETURN_DAYS.length; j++) {
        Telemetry.count(nk, Telemetry.METRIC.RETURNING_INSTALLS, { game: g.id, day: "d" + Telemetry.RETURN_DAYS[j] }, 0);
      }
      for (let j = 0; j < COMMON_OS.length; j++) {
        for (let k = 0; k < COMMON_ARCHES.length; k++) {
          Telemetry.count(nk, Telemetry.METRIC.LAUNCH_SYSTEMS, { game: g.id, os: COMMON_OS[j], arch: COMMON_ARCHES[k] }, 0);
        }
      }
      let total = 0;
      try {
        total = installs(nk, g.id);
      } catch (e) {
        // Leave the gauge at 0 until the next new install sets it.
      }
      Telemetry.gauge(nk, Telemetry.METRIC.INSTALLS, { game: g.id }, total);
    }
  }
}

/** core.launch: see Launches. Reached through Caddy's /launch route. */
function rpcLaunch(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const address = ctx.clientIp || "unknown";
  RateLimit.check(nk, address, "launch", Launches.PER_MINUTE, 60);
  const ping = Launches.parse(ctx, Util.parsePayload(payload));
  Launches.record(nk, ping, address, Telemetry.day(new Date()));
  return "{}";
}
