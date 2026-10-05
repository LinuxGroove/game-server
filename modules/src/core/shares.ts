// Share codes for player-made content: tracks, courses, forts, parks.
//
// The content is a storage object the player owns in "<game>.shares", keyed
// by its share code, readable by everyone and writable only by the server.
// A server-owned index in "core.share_codes" maps each code to its owner, so
// anyone can fetch content by code alone, and holds report counts.
// Content reported by SHARE_HIDE_THRESHOLD different players (default 5) is
// hidden until an admin clears it in the Nakama console.

const MAX_SHARE_REPORTERS = 50;

namespace Shares {
  export const CODES = "core.share_codes";
  export const COUNTS = "core.share_counts";
  export const CODE_LENGTH = 8;

  export function collection(game: Registry.GameDef): string {
    return game.id + ".shares";
  }

  export function readCode(nk: nkruntime.Nakama, code: string): nkruntime.StorageObject | null {
    const found = nk.storageRead([{ collection: CODES, key: code, userId: SYSTEM_USER_ID }]);
    return found.length > 0 ? found[0] : null;
  }

  export function parseCode(req: { [key: string]: any }): string {
    const code = Util.normaliseCode(Util.str(req, "code", 16, true));
    if (!Util.isCode(code, CODE_LENGTH)) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_code: share codes are " + CODE_LENGTH + " letters and digits");
    }
    return code;
  }

  export function adjustCount(nk: nkruntime.Nakama, game: Registry.GameDef, userId: string, delta: number): number {
    const value = Objects.update(nk, COUNTS, game.id, userId, 1, function (current) {
      const count = current && typeof current["count"] === "number" ? current["count"] : 0;
      return { count: Math.max(0, count + delta) };
    });
    return value["count"];
  }

  /** Remove a player's share codes for every game. Content goes with the account. */
  export function deleteAllFor(nk: nkruntime.Nakama, userId: string): void {
    for (let i = 0; i < Registry.GAMES.length; i++) {
      const coll = collection(Registry.GAMES[i]);
      let cursor: string | undefined = undefined;
      do {
        const page: nkruntime.StorageObjectList = nk.storageList(userId, coll, 100, cursor);
        const objects = page.objects || [];
        const removals: nkruntime.StorageDeleteRequest[] = [];
        for (let j = 0; j < objects.length; j++) {
          removals.push({ collection: CODES, key: objects[j].key, userId: SYSTEM_USER_ID });
        }
        if (removals.length > 0) {
          nk.storageDelete(removals);
        }
        cursor = page.cursor || undefined;
      } while (cursor);
    }
  }
}

/** core.share_create {kind, title, data, meta?} -> {code} */
function rpcShareCreate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const req = Util.parsePayload(payload);
  const kindName = Util.str(req, "kind", 48, true);
  const kind = Registry.shareKind(game, kindName);
  if (!kind) {
    return Util.fail(Code.INVALID_ARGUMENT, "unknown_kind: " + game.id + " has no share kind '" + kindName + "'");
  }
  const title = Util.str(req, "title", 64, true);
  const data = Util.str(req, "data", kind.maxBytes, true);
  if (Util.byteLength(data) > kind.maxBytes) {
    return Util.fail(Code.INVALID_ARGUMENT, "too_large: " + kind.name + " data must be " + kind.maxBytes + " bytes or less");
  }
  const meta = Relay.checkMeta(req["meta"]);
  if (typeof meta === "string") {
    return Util.fail(Code.INVALID_ARGUMENT, meta);
  }
  RateLimit.check(nk, userId, "share_create." + game.id, 20, 3600);
  if (kind.validate) {
    kind.validate(ctx, nk, userId, data, meta);
  }

  const count = Shares.adjustCount(nk, game, userId, 1);
  if (count > kind.perUserLimit) {
    Shares.adjustCount(nk, game, userId, -1);
    return Util.fail(Code.RESOURCE_EXHAUSTED, "share_limit: delete an old share before adding more");
  }

  let code = "";
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = Util.randomCode(nk, Shares.CODE_LENGTH);
    try {
      nk.storageWrite([
        {
          collection: Shares.CODES,
          key: candidate,
          userId: SYSTEM_USER_ID,
          value: { game: game.id, kind: kind.name, owner: userId, created: Util.nowSeconds(), reports: 0, reporters: [], hidden: false },
          version: "*",
          permissionRead: 0,
          permissionWrite: 0,
        },
      ]);
      code = candidate;
    } catch (e) {
      // Code already taken, pick another.
    }
  }
  if (!code) {
    Shares.adjustCount(nk, game, userId, -1);
    return Util.fail(Code.UNAVAILABLE, "no_code: could not allocate a share code, try again");
  }
  nk.storageWrite([
    {
      collection: Shares.collection(game),
      key: code,
      userId: userId,
      value: { kind: kind.name, title: title, data: data, meta: meta, created: Util.nowSeconds() },
      permissionRead: 2,
      permissionWrite: 0,
    },
  ]);
  return JSON.stringify({ code: code });
}

/** core.share_get {code} -> {code, kind, title, data, meta, owner_id, created} */
function rpcShareGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const code = Shares.parseCode(Util.parsePayload(payload));
  RateLimit.check(nk, userId, "share_get", 120, 60);
  const index = Shares.readCode(nk, code);
  if (!index || index.value["game"] !== game.id) {
    return Util.fail(Code.NOT_FOUND, "share_not_found: no " + game.name + " share with code " + code);
  }
  if (index.value["hidden"] === true) {
    return Util.fail(Code.NOT_FOUND, "share_hidden: this share was hidden after player reports");
  }
  const owner = index.value["owner"];
  const found = nk.storageRead([{ collection: Shares.collection(game), key: code, userId: owner }]);
  if (found.length === 0) {
    // The owner deleted their account; drop the dangling code.
    nk.storageDelete([{ collection: Shares.CODES, key: code, userId: SYSTEM_USER_ID }]);
    return Util.fail(Code.NOT_FOUND, "share_not_found: no " + game.name + " share with code " + code);
  }
  const v = found[0].value;
  return JSON.stringify({
    code: code,
    kind: v["kind"],
    title: v["title"],
    data: v["data"],
    meta: v["meta"] || {},
    owner_id: owner,
    created: v["created"],
  });
}

/** core.share_delete {code} -> {} (owner only) */
function rpcShareDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const code = Shares.parseCode(Util.parsePayload(payload));
  const index = Shares.readCode(nk, code);
  if (!index || index.value["game"] !== game.id) {
    return Util.fail(Code.NOT_FOUND, "share_not_found: no " + game.name + " share with code " + code);
  }
  if (index.value["owner"] !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_owner: only the creator can delete a share");
  }
  nk.storageDelete([
    { collection: Shares.collection(game), key: code, userId: userId },
    { collection: Shares.CODES, key: code, userId: SYSTEM_USER_ID },
  ]);
  Shares.adjustCount(nk, game, userId, -1);
  return "{}";
}

/** core.share_list_mine {cursor?} -> {shares: [{code, kind, title, created}], cursor} */
function rpcShareListMine(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const req = Util.parsePayload(payload);
  const cursor = Util.str(req, "cursor", 512, false) || undefined;
  const page = nk.storageList(userId, Shares.collection(game), 50, cursor);
  const shares: any[] = [];
  const objects = page.objects || [];
  for (let i = 0; i < objects.length; i++) {
    const v = objects[i].value;
    shares.push({ code: objects[i].key, kind: v["kind"], title: v["title"], created: v["created"] });
  }
  return JSON.stringify({ shares: shares, cursor: page.cursor || "" });
}

/** core.share_report {code, reason} -> {} */
function rpcShareReport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const req = Util.parsePayload(payload);
  const code = Shares.parseCode(req);
  const reason = Util.str(req, "reason", 32, true);
  RateLimit.check(nk, userId, "share_report", 10, 3600);
  const threshold = parseInt(Util.env(ctx, "SHARE_HIDE_THRESHOLD", "5"), 10) || 5;

  const index = Shares.readCode(nk, code);
  if (!index || index.value["game"] !== game.id) {
    return Util.fail(Code.NOT_FOUND, "share_not_found: no " + game.name + " share with code " + code);
  }
  Objects.update(nk, Shares.CODES, code, SYSTEM_USER_ID, 0, function (current) {
    const v = current || index.value;
    const reporters: string[] = v["reporters"] || [];
    if (reporters.indexOf(userId) < 0 && v["owner"] !== userId) {
      reporters.push(userId);
      v["reports"] = (v["reports"] || 0) + 1;
      v["last_reason"] = reason;
      if (v["reports"] >= threshold) {
        v["hidden"] = true;
      }
    }
    v["reporters"] = reporters.slice(-MAX_SHARE_REPORTERS);
    return v;
  });
  logger.info("Share %s reported by %s: %s", code, userId, reason);
  return "{}";
}
