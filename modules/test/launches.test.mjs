import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load, logger, fakeNk } from "./harness.mjs";

const g = load();
const M = g.Telemetry.METRIC;
const L = g.Launches;
const env = { GAME_SANDBOX_ENABLED: "true" };
const INSTALL = "9f2c41d07b6e4a1c8d3e5f60a1b2c3d4";

// A call through Caddy's /launch route: the runtime HTTP key, no session.
function launchCtx(address = "203.0.113.5") {
  return { env, executionMode: "rpc", node: "test", version: "test", clientIp: address, queryParams: { unwrap: [""] } };
}

function body(extra = {}) {
  return {
    game: "foam-frenzy",
    install: INSTALL,
    version: "2026.41.1+3.g1a2b3c4d",
    os: "Linux",
    distro: "Ubuntu 24.04.5 LTS",
    os_version: "24.04",
    arch: "arm64",
    ...extra,
  };
}

function ping(nk, extra = {}, address) {
  return g.rpcLaunch(launchCtx(address), logger, nk, JSON.stringify(body(extra)));
}

test("a launch is counted by game, version and system", () => {
  const nk = fakeNk();
  assert.equal(ping(nk), "{}");
  assert.equal(
    nk.counter(M.LAUNCHES, { game: "foam-frenzy", version: "2026.41.1+3.g1a2b3c4d", os: "ubuntu", os_version: "24.04", arch: "arm64" }),
    1,
  );
  assert.equal(nk.counter(M.LAUNCH_PLAYERS, { game: "foam-frenzy" }), 1);
  assert.equal(nk.counter(M.LAUNCH_SYSTEMS, { game: "foam-frenzy", os: "ubuntu", arch: "arm64" }), 1);
  assert.equal(nk.counter(M.NEW_INSTALLS, { game: "foam-frenzy" }), 1);
  assert.equal(nk.gauge(M.INSTALLS, { game: "foam-frenzy" }), 1);
});

test("relaunching the same day counts the launch but not another player", () => {
  const nk = fakeNk();
  ping(nk);
  ping(nk);
  ping(nk, { install: "00000000000000000000000000000001" });
  assert.equal(nk.counter(M.LAUNCHES, { game: "foam-frenzy" }), 3);
  assert.equal(nk.counter(M.LAUNCH_PLAYERS, { game: "foam-frenzy" }), 2);
  assert.equal(nk.counter(M.NEW_INSTALLS, { game: "foam-frenzy" }), 2);
  assert.equal(nk.gauge(M.INSTALLS, { game: "foam-frenzy" }), 2);
});

test("installs keep their first and last day, privately, and count retention", () => {
  const nk = fakeNk();
  const days = ["2026-10-01", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-08", "2026-10-31"];
  for (const day of days) {
    L.day(nk, "tiptoe", INSTALL, "ubuntu", "x86_64", "a", day);
  }
  L.day(nk, "joyride-junction", INSTALL, "ubuntu", "x86_64", "a", "2026-10-02");
  assert.equal(nk.counter(M.LAUNCH_PLAYERS, { game: "tiptoe" }), 5, "the second launch on 10-01 isn't a new day");
  assert.equal(nk.counter(M.NEW_INSTALLS, { game: "tiptoe" }), 1);
  assert.equal(nk.counter(M.NEW_INSTALLS, { game: "joyride-junction" }), 1, "new to each game separately");
  assert.equal(nk.counter(M.RETURNING_INSTALLS, { game: "tiptoe", day: "d1" }), 1);
  assert.equal(nk.counter(M.RETURNING_INSTALLS, { game: "tiptoe", day: "d7" }), 1);
  assert.equal(nk.counter(M.RETURNING_INSTALLS, { game: "tiptoe", day: "d30" }), 1);
  assert.equal(nk.counter(M.RETURNING_INSTALLS), 3, "day 4 is not a retention day");
  const obj = nk.storage.get(`core.installs/tiptoe:${INSTALL}/00000000-0000-0000-0000-000000000000`);
  assert.deepEqual({ ...obj.value }, { first: "2026-10-01", last: "2026-10-31" });
  assert.equal(obj.permissionRead, 0, "installs are private to the server");
  assert.equal(obj.permissionWrite, 0);
  const stored = JSON.stringify([...nk.storage.values()]);
  assert.ok(!stored.includes("203.0.113"), "no address is stored");
});

test("systems are labelled from a fixed list", () => {
  const os = (name, distro = "") => L.osLabel(name, distro);
  assert.equal(os("Linux", "Ubuntu 24.04.5 LTS"), "ubuntu");
  assert.equal(os("Linux", "Ubuntu Core 24"), "ubuntu-core", "every snap reports its base");
  assert.equal(os("Linux", "Fedora Linux 41 (Workstation Edition)"), "fedora");
  assert.equal(os("Linux", "SteamOS"), "steamos");
  assert.equal(os("Linux", "Linux Mint 22"), "mint");
  assert.equal(os("Linux", "Gentoo Linux"), "linux-other");
  assert.equal(os("Linux", ""), "linux-other");
  assert.equal(os("Windows", "Windows"), "windows");
  assert.equal(os("macOS", "macOS"), "macos");
  assert.equal(os("FreeBSD", "FreeBSD"), "bsd");
  assert.equal(os("TempleOS", "x"), "other");
  assert.equal(os(""), "other");
  assert.equal(L.archLabel("arm64"), "arm64");
  assert.equal(L.archLabel("x86_64"), "x86_64");
  assert.equal(L.archLabel("amd64; DROP TABLE"), "other");
});

test("OS versions are short labels that can't grow without limit", () => {
  const nk = fakeNk();
  const v = (os, raw) => L.osVersionLabel(nk, "foam-frenzy", os, raw);
  assert.equal(v("ubuntu", "24.04"), "24.04");
  assert.equal(v("fedora", "41"), "41");
  assert.equal(v("windows", "10.0.22631"), "11");
  assert.equal(v("windows", "10.0.19045"), "10");
  assert.equal(v("macos", "15.1.0"), "15");
  assert.equal(v("ubuntu", ""), "unknown");
  assert.equal(v("ubuntu", "../../etc"), "unknown");
  const labels = [];
  for (let i = 0; i < L.MAX_OS_VERSIONS + 5; i++) {
    labels.push(v("arch", String(100 + i)));
  }
  assert.equal(new Set(labels).size, L.MAX_OS_VERSIONS + 1);
  assert.equal(labels.at(-1), "other");
  assert.equal(v("ubuntu", "24.04"), "24.04", "the limit is per OS");
});

test("bad pings are refused and count nothing", () => {
  const nk = fakeNk();
  const bad = [
    [{ game: "no-such-game" }, "unknown_game"],
    [{ install: "not-hex" }, "bad_install"],
    [{ install: INSTALL.toUpperCase() }, "bad_install"],
    [{ version: "v2026.41.1" }, "bad_version"],
    [{ version: undefined }, "version is required"],
  ];
  for (const [extra, reason] of bad) {
    assert.throws(() => ping(nk, extra), (e) => e.message.startsWith(reason), reason);
  }
  assert.throws(() => g.rpcLaunch(launchCtx(), logger, nk, "[1]"), (e) => e.code === 3);
  assert.throws(() => g.rpcLaunch({ ...launchCtx(), env: {} }, logger, nk, JSON.stringify(body({ game: "sandbox" }))), (e) =>
    e.message.startsWith("unknown_game"),
  );
  assert.equal(nk.metrics.length, 0);
});

test("one address can't flood pings or invent installs", () => {
  const nk = fakeNk();
  for (let i = 0; i < L.PER_MINUTE; i++) {
    ping(nk, { install: i.toString(16).padStart(32, "0") });
  }
  assert.throws(() => ping(nk), (e) => e.message.startsWith("rate_limited"));
  assert.equal(nk.counter(M.NEW_INSTALLS), L.NEW_PER_HOUR, "new installs past the hourly cap aren't counted");
  assert.equal(nk.counter(M.LAUNCHES), L.PER_MINUTE, "but their launches are");
  ping(nk, {}, "198.51.100.7");
  assert.equal(nk.counter(M.NEW_INSTALLS), L.NEW_PER_HOUR + 1, "other addresses are unaffected");
});

test("pings never fail when storage is down", () => {
  const nk = fakeNk();
  nk.storageRead = () => {
    throw new Error("database down");
  };
  assert.equal(ping(nk), "{}");
  assert.equal(nk.counter(M.LAUNCHES), 1);
});

test("no other RPC works without a game session", () => {
  // Caddy adds the runtime HTTP key to /launch only, but anyone who learns the
  // key could call any RPC with it, so every other RPC must refuse.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const rpcs = [...main.matchAll(/registerRpc\("([^"]+)", (\w+)\)/g)];
  assert.ok(rpcs.length >= 17, `found only ${rpcs.length} RPCs`);
  for (const [, id, fn] of rpcs) {
    if (id === "core.launch") {
      continue;
    }
    assert.throws(
      () => g[fn]({ env, executionMode: "rpc", node: "test", version: "test", clientIp: "203.0.113.5" }, logger, fakeNk(), "{}"),
      (e) => e.code === 16,
      `${id} must refuse calls without a session`,
    );
  }
});

test("launch counters start at 0 and the installs total comes from the database", () => {
  const nk = fakeNk();
  nk.storage.set("core.counts/installs:tiptoe/00000000-0000-0000-0000-000000000000", { value: { n: 42 }, version: "v" });
  g.Launches.init({ env: {} }, nk);
  assert.equal(nk.gauge(M.INSTALLS, { game: "tiptoe" }), 42);
  assert.equal(nk.gauge(M.INSTALLS, { game: "joyride-junction" }), 0);
  assert.equal(nk.gauge(M.INSTALLS, { game: "sandbox" }), undefined, "disabled games are left out");
  const started = nk.metrics.filter((m) => m.tags.game === "graveyard-hollow").map((m) => m.name + (m.tags.day || m.tags.os || ""));
  for (const name of [M.LAUNCH_PLAYERS, M.NEW_INSTALLS, M.RETURNING_INSTALLS + "d1", M.LAUNCH_SYSTEMS + "ubuntu-core"]) {
    assert.ok(started.includes(name), `${name} in ${started.join(", ")}`);
  }
  assert.ok(nk.metrics.every((m) => m.delta === 0));
});
