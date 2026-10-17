// All City: a skate and graffiti territory war on copies of real towns, built
// from OpenStreetMap by the game's Cartographer (game-ideas, idea 24).
//
// M0 has no rooms, crews or boards yet, only the walls. A painted wall is a
// record keyed by the Cartographer's own wall id (never an OpenStreetMap id),
// and one server-owned object in all-city.walls holds every painted wall of a
// quarter (key "<town>:<quarter>"), so arriving in a quarter is one read.
// Paint stays up for everyone until a rival goes over it, it fades, or the
// city's cleaners, the Buff, clean it at dawn. The Buff runs lazily: every
// read and write of a quarter first catches it up on the dawns since it last
// came, so walls change overnight with nobody online and no scheduled job.
//
// all-city.paint checks the rank rule, the time spent painting and a rate
// limit, so a hacked client can't carpet a quarter. The rules are the pure
// functions in AllCity below (faded, canPaint, dawns, buff), which the game's
// GDScript copy must match.

const GAME_ALL_CITY: Registry.GameDef = {
  id: "all-city",
  name: "All City",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [],
  collections: [
    // The writer's own rep, synced between devices.
    { name: "progress", clientWrite: true, maxBytes: 32768, read: "owner" },
    // One object per quarter, owned and written by the server; players read
    // it through all-city.walls, which brings the Buff up to date first.
    { name: "walls", clientWrite: false, maxBytes: 0, read: "owner" },
  ],
  blobs: [],
  shares: [],
  rooms: null,
};

namespace AllCity {
  const DAY = 86400;

  /** Ranks, lowest first: each goes over the ones before it. */
  export const RANKS = ["tag", "throwup", "piece", "burner"];
  /** How long each rank stands before it fades away, in seconds. */
  export const LIFE: { [rank: string]: number } = { tag: 3 * DAY, throwup: 10 * DAY, piece: 30 * DAY, burner: 60 * DAY };
  /** The least time each rank takes to paint, in seconds. */
  export const MIN_SECONDS: { [rank: string]: number } = { tag: 2, throwup: 15, piece: 90, burner: 240 };
  /** What cleaning each rank costs the Buff, out of BUFF_BUDGET a dawn. */
  export const BUFF_COST: { [rank: string]: number } = { tag: 1, throwup: 2, piece: 4, burner: 8 };
  export const BUFF_BUDGET = 8;
  /** The most dawns the Buff catches up on, so a quarter left alone for months costs a week's work. */
  export const BUFF_DAWNS = 7;
  /** Dawn, in hours after the town's midnight. */
  export const DAWN_HOUR = 6;
  /** Recent buffs kept on a quarter, for all-city.walls' since. */
  export const BUFF_LOG = 200;
  /** The most painted walls one quarter holds, which bounds its object's size. */
  export const MAX_WALLS = 1000;
  export const MAX_KIT_BYTES = 2048;
  export const MAX_QUARTER = 9999;
  /** The longest anyone paints one wall, in seconds. */
  export const MAX_SECONDS = 86400;
  export const PAINTS_PER_HOUR = 40;
  /** Tries at writing a quarter others are painting too, as Objects.update makes. */
  export const TRIES = 5;

  /** One painted wall, as stored and as sent to the game. */
  export interface Wall {
    writer: string;
    name: string;
    rank: string;
    kit: { [key: string]: any };
    grade: number;
    eyes: number;
    heaven: boolean;
    at: number;
    capped: boolean;
  }

  /** A wall the Buff cleaned, and the dawn it cleaned it at. */
  export interface Buffed {
    wall: string;
    at: number;
  }

  /** One quarter's object in all-city.walls. */
  export interface Quarter {
    utc_offset_min: number;
    buffed_until: number;
    walls: { [id: string]: Wall };
    buffs: Buffed[];
  }

  export interface Paint {
    town: string;
    quarter: number;
    wall: string;
    rank: string;
    kit: { [key: string]: any };
    grade: number;
    eyes: number;
    heaven: boolean;
    seconds: number;
    utc_offset_min: number;
    cap: boolean;
  }

  export interface Verdict {
    ok: boolean;
    capped: boolean;
    reason: string;
  }

  /*
   * The rules. The game's GDScript copy must match these exactly.
   *
   * Lives (faded). Paint stands for LIFE[rank] seconds: a tag 3 days, a
   * throw-up 10, a piece 30, a burner 60. Once its age (now - at) is more
   * than that it has faded: it's gone, and the wall counts as empty.
   *
   * Going over (canPaint), against what's on the wall now:
   * - an empty wall (nothing there, or faded paint) takes anything;
   * - a writer can always go over their own work;
   * - a higher rank goes over a lower one;
   * - an equal rank goes over paint only once it has faded past half
   *   (age > LIFE / 2);
   * - a lower rank is refused ("rank") unless the writer caps it: with cap,
   *   it goes on and is marked capped. Cap changes nothing else.
   *
   * Dawn (dawns). Dawn is 06:00 in the town's time, which is UTC plus the
   * quarter's utc_offset_min all year (no daylight saving). In UTC, the dawn of
   * the town's day d (days since 1970-01-01 there) is
   * d * 86400 + 6 * 3600 - utc_offset_min * 60.
   *
   * The Buff (buff). For each dawn after the quarter's buffed_until and up to
   * now (both in UTC seconds, a dawn exactly at now included), at most the last
   * BUFF_DAWNS (7), oldest first, the Buff has BUFF_BUDGET (8) to spend on the
   * walls standing at that dawn: painted before it (at < dawn), not faded at
   * it, and not heaven spots. It takes them in order of cost (tag 1, throw-up
   * 2, piece 4, burner 8, so lowest rank first), then eyes (highest first),
   * then age (oldest first), then wall id (in string order), and cleans each
   * in turn until the next costs more than what's left; what's left is lost.
   * A wall it cleans is empty at every later dawn. Then faded paint is
   * dropped and buffed_until is now. The server does this before every paint
   * and every read of the quarter.
   */

  /** Whether paint has faded away by `now`. */
  export function faded(wall: Wall, now: number): boolean {
    return now - wall.at > LIFE[wall.rank];
  }

  /** Whether paint has faded past half, so an equal rank can go over it. */
  export function pastHalf(wall: Wall, now: number): boolean {
    return now - wall.at > LIFE[wall.rank] / 2;
  }

  /** Whether `writer` may put `rank` on a wall that has `current` on it (null when bare). */
  export function canPaint(current: Wall | null, writer: string, rank: string, cap: boolean, now: number): Verdict {
    if (!current || faded(current, now) || current.writer === writer) {
      return { ok: true, capped: false, reason: "" };
    }
    const was = RANKS.indexOf(current.rank);
    const next = RANKS.indexOf(rank);
    if (next > was || (next === was && pastHalf(current, now))) {
      return { ok: true, capped: false, reason: "" };
    }
    if (next < was && cap) {
      return { ok: true, capped: true, reason: "" };
    }
    return { ok: false, capped: false, reason: "rank" };
  }

  /** Every dawn after `from` up to and including `to`, the last BUFF_DAWNS of them, oldest first. */
  export function dawns(from: number, to: number, utcOffsetMin: number): number[] {
    const shift = DAWN_HOUR * 3600 - utcOffsetMin * 60;
    const last = Math.floor((to - shift) / DAY);
    const first = Math.max(Math.floor((from - shift) / DAY) + 1, last - BUFF_DAWNS + 1);
    const out: number[] = [];
    for (let d = first; d <= last; d++) {
      out.push(d * DAY + shift);
    }
    return out;
  }

  /** The latest dawn at or before `now`. */
  export function lastDawn(now: number, utcOffsetMin: number): number {
    const shift = DAWN_HOUR * 3600 - utcOffsetMin * 60;
    return Math.floor((now - shift) / DAY) * DAY + shift;
  }

  /** The Buff's order: cheapest first, then most eyes, then oldest, then by id. */
  function buffOrder(walls: { [id: string]: Wall }, a: string, b: string): number {
    const wa = walls[a];
    const wb = walls[b];
    if (BUFF_COST[wa.rank] !== BUFF_COST[wb.rank]) {
      return BUFF_COST[wa.rank] - BUFF_COST[wb.rank];
    }
    if (wa.eyes !== wb.eyes) {
      return wb.eyes - wa.eyes;
    }
    if (wa.at !== wb.at) {
      return wa.at - wb.at;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** The walls the Buff cleans at the dawns after `from` up to `to`, in order. Changes nothing. */
  export function buff(walls: { [id: string]: Wall }, from: number, to: number, utcOffsetMin: number): Buffed[] {
    const out: Buffed[] = [];
    const gone: { [id: string]: boolean } = {};
    const times = dawns(from, to, utcOffsetMin);
    for (let i = 0; i < times.length; i++) {
      const dawn = times[i];
      const standing = Object.keys(walls).filter(function (id) {
        const w = walls[id];
        return !gone[id] && !w.heaven && w.at < dawn && !faded(w, dawn);
      });
      standing.sort(function (a, b) {
        return buffOrder(walls, a, b);
      });
      let left = BUFF_BUDGET;
      for (let j = 0; j < standing.length; j++) {
        const cost = BUFF_COST[walls[standing[j]].rank];
        if (cost > left) {
          break;
        }
        left -= cost;
        gone[standing[j]] = true;
        out.push({ wall: standing[j], at: dawn });
      }
    }
    return out;
  }

  /**
   * Bring a quarter up to `now`: the Buff's dawns since buffed_until (logged
   * in buffs, the last BUFF_LOG kept), then faded paint dropped. Returns
   * whether a dawn passed, which is when the quarter is worth saving after a
   * read.
   */
  export function settle(q: Quarter, now: number): boolean {
    const passed = dawns(q.buffed_until, now, q.utc_offset_min).length > 0;
    const cleaned = buff(q.walls, q.buffed_until, now, q.utc_offset_min);
    for (let i = 0; i < cleaned.length; i++) {
      delete q.walls[cleaned[i].wall];
      q.buffs.push(cleaned[i]);
    }
    if (q.buffs.length > BUFF_LOG) {
      q.buffs = q.buffs.slice(q.buffs.length - BUFF_LOG);
    }
    const ids = Object.keys(q.walls);
    for (let i = 0; i < ids.length; i++) {
      if (faded(q.walls[ids[i]], now)) {
        delete q.walls[ids[i]];
      }
    }
    q.buffed_until = Math.max(q.buffed_until, now);
    return passed;
  }

  /** The walls the Buff cleaned after `since`, each once. */
  export function buffedSince(q: Quarter, since: number): string[] {
    const out: string[] = [];
    const seen: { [id: string]: boolean } = {};
    for (let i = 0; i < q.buffs.length; i++) {
      const b = q.buffs[i];
      if (b.at > since && !seen[b.wall]) {
        seen[b.wall] = true;
        out.push(b.wall);
      }
    }
    return out;
  }

  /** A stored quarter with every field in place (copied, so the read stays as it was), or a new one. */
  export function quarterFrom(value: { [key: string]: any } | null, utcOffsetMin: number, now: number): Quarter {
    const q: Quarter = { utc_offset_min: utcOffsetMin, buffed_until: now, walls: {}, buffs: [] };
    if (!value) {
      return q;
    }
    if (typeof value["utc_offset_min"] === "number") {
      q.utc_offset_min = value["utc_offset_min"];
    }
    if (typeof value["buffed_until"] === "number") {
      q.buffed_until = value["buffed_until"];
    }
    const walls = value["walls"];
    if (walls && typeof walls === "object") {
      const ids = Object.keys(walls);
      for (let i = 0; i < ids.length; i++) {
        if (walls[ids[i]] && LIFE[walls[ids[i]].rank] !== undefined) {
          q.walls[ids[i]] = walls[ids[i]];
        }
      }
    }
    if (Array.isArray(value["buffs"])) {
      q.buffs = value["buffs"].slice();
    }
    return q;
  }

  export function quarterKey(town: string, quarter: number): string {
    return town + ":" + quarter;
  }

  export function parseTown(req: { [key: string]: any }): string {
    const town = Util.str(req, "town", 48, true);
    if (!/^[a-z0-9-]{1,48}$/.test(town)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_town: towns are 1 to 48 lower-case letters, digits and '-'");
    }
    return town;
  }

  /** A paint request, checked: every field, and the time the rank takes to paint. */
  export function parsePaint(req: { [key: string]: any }): Paint {
    const town = parseTown(req);
    const quarter = Util.int(req, "quarter", 0, MAX_QUARTER);
    const wall = Util.str(req, "wall", 17, true);
    if (!/^w[0-9a-f]{6,16}$/.test(wall)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_wall: wall ids are 'w' and 6 to 16 lower-case hex digits");
    }
    const rank = Util.str(req, "rank", 16, true);
    if (RANKS.indexOf(rank) < 0) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_rank: " + rank + " is not one of " + RANKS.join(", "));
    }
    const kit = req["kit"];
    if (!kit || typeof kit !== "object" || Array.isArray(kit)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_kit: kit must be a JSON object");
    }
    if (Util.byteLength(JSON.stringify(kit)) > MAX_KIT_BYTES) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_large: kit must be " + MAX_KIT_BYTES + " bytes or less");
    }
    const seconds = req["seconds"];
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
      return Util.fail(Code.INVALID_ARGUMENT, "seconds must be a number from 0 to " + MAX_SECONDS);
    }
    if (seconds < MIN_SECONDS[rank]) {
      return Util.fail(Code.INVALID_ARGUMENT, "too_quick: a " + rank + " takes at least " + MIN_SECONDS[rank] + " seconds");
    }
    const offset = Util.int(req, "utc_offset_min", -9007199254740991, 9007199254740991);
    return {
      town: town,
      quarter: quarter,
      wall: wall,
      rank: rank,
      kit: kit,
      grade: Util.int(req, "grade", 0, 100),
      eyes: Util.int(req, "eyes", 0, 100),
      heaven: Util.bool(req, "heaven", false),
      seconds: seconds,
      utc_offset_min: Math.max(-720, Math.min(840, offset)),
      cap: Util.bool(req, "cap", false),
    };
  }

  export function record(p: Paint, writer: string, name: string, now: number, capped: boolean): Wall {
    return {
      writer: writer,
      name: name,
      rank: p.rank,
      kit: p.kit,
      grade: p.grade,
      eyes: p.eyes,
      heaven: p.heaven,
      at: now,
      capped: capped,
    };
  }

  /** Write a quarter back if nobody else has since `version` ("*" for a new one). */
  export function save(nk: nkruntime.Nakama, key: string, q: Quarter, version: string): boolean {
    try {
      nk.storageWrite([
        {
          collection: GAME_ALL_CITY.id + ".walls",
          key: key,
          userId: SYSTEM_USER_ID,
          value: { utc_offset_min: q.utc_offset_min, buffed_until: q.buffed_until, walls: q.walls, buffs: q.buffs },
          version: version,
          permissionRead: 0,
          permissionWrite: 0,
        },
      ]);
      return true;
    } catch (e) {
      return false;
    }
  }

  export function read(nk: nkruntime.Nakama, key: string): nkruntime.StorageObject | null {
    const found = nk.storageRead([{ collection: GAME_ALL_CITY.id + ".walls", key: key, userId: SYSTEM_USER_ID }]);
    return found.length > 0 ? found[0] : null;
  }
}

/**
 * all-city.paint — paint a wall.
 * {town, quarter, wall, rank, kit, grade, eyes, heaven, seconds, utc_offset_min, cap}
 *  -> {ok: true, wall: record} or {ok: false, reason: "rank"|"rate"|"full"|"busy"}
 */
function rpcAllCityPaint(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_ALL_CITY.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for All City sessions");
  }
  const paint = AllCity.parsePaint(Util.parsePayload(payload));
  if (!RateLimit.allow(nk, userId, "all-city.paint", AllCity.PAINTS_PER_HOUR, 3600)) {
    return JSON.stringify({ ok: false, reason: "rate" });
  }
  const users = nk.usersGetId([userId]);
  const name = users.length > 0 ? users[0].displayName || users[0].username : ctx.username || "";

  const key = AllCity.quarterKey(paint.town, paint.quarter);
  for (let attempt = 0; attempt < AllCity.TRIES; attempt++) {
    const found = AllCity.read(nk, key);
    const now = Util.nowSeconds();
    // A new quarter takes the town's offset from its first paint and keeps it.
    const q = AllCity.quarterFrom(found ? found.value : null, paint.utc_offset_min, now);
    AllCity.settle(q, now);
    const verdict = AllCity.canPaint(q.walls[paint.wall] || null, userId, paint.rank, paint.cap, now);
    if (!verdict.ok) {
      return JSON.stringify({ ok: false, reason: verdict.reason });
    }
    if (!q.walls[paint.wall] && Object.keys(q.walls).length >= AllCity.MAX_WALLS) {
      return JSON.stringify({ ok: false, reason: "full" });
    }
    const wall = AllCity.record(paint, userId, name, now, verdict.capped);
    q.walls[paint.wall] = wall;
    // Someone else painting in the quarter in between makes this fail; read again.
    if (AllCity.save(nk, key, q, found ? found.version : "*")) {
      logger.debug("All City %s on %s in %s by %s", paint.rank, paint.wall, key, userId);
      return JSON.stringify({ ok: true, wall: wall });
    }
  }
  return JSON.stringify({ ok: false, reason: "busy" });
}

/**
 * all-city.walls — every wall standing in a quarter, after the Buff.
 * {town, quarter, since?} -> {walls: {<wall id>: record}, last_dawn, buffed: [wall ids]}
 */
function rpcAllCityWalls(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  if (game.id !== GAME_ALL_CITY.id) {
    return Util.fail(Code.PERMISSION_DENIED, "wrong_game: this call is for All City sessions");
  }
  const req = Util.parsePayload(payload);
  const town = AllCity.parseTown(req);
  const quarter = Util.int(req, "quarter", 0, AllCity.MAX_QUARTER);
  const since = req["since"] === undefined || req["since"] === null ? -1 : Util.int(req, "since", 0, 9007199254740991);
  RateLimit.check(nk, userId, "all-city.walls", 120, 60);

  const key = AllCity.quarterKey(town, quarter);
  let q: AllCity.Quarter | null = null;
  let now = 0;
  for (let attempt = 0; attempt < AllCity.TRIES; attempt++) {
    const found = AllCity.read(nk, key);
    now = Util.nowSeconds();
    if (!found) {
      q = null;
      break;
    }
    q = AllCity.quarterFrom(found.value, 0, now);
    // Save only when the Buff came by since it was last saved. If the quarter
    // stays busy, what was worked out is still right to send.
    if (!AllCity.settle(q, now) || AllCity.save(nk, key, q, found.version)) {
      break;
    }
  }
  if (!q) {
    return JSON.stringify({ walls: {}, last_dawn: 0, buffed: [] });
  }
  return JSON.stringify({
    walls: q.walls,
    last_dawn: AllCity.lastDawn(now, q.utc_offset_min),
    buffed: since < 0 ? [] : AllCity.buffedSince(q, since),
  });
}
