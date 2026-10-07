// Blob uploads and downloads (ghosts, replays, screenshots) via object storage.
//
// Object keys are "<game>/<kind>/<user id>/<blob id>". Each upload is also
// recorded in the player's "core.blobs" storage, so account deletion can
// remove the player's objects. Retention is up to bucket lifecycle rules
// per "<game>/<kind>/" prefix.

namespace Blobs {
  export const COLLECTION = "core.blobs";
  export const UPLOAD_EXPIRY_SEC = 600;
  export const DOWNLOAD_EXPIRY_SEC = 900;

  export function requireConfig(ctx: nkruntime.Context): S3.Config {
    const cfg = S3.config(ctx);
    if (!cfg) {
      return Util.fail(Code.UNAVAILABLE, "blobs_disabled: this server has no object storage configured");
    }
    return cfg;
  }

  /** Validate a key someone passed in, and that it belongs to this game. */
  export function checkKey(game: Registry.GameDef, key: string): string[] {
    const parts = key.split("/");
    if (
      parts.length !== 4 ||
      parts[0] !== game.id ||
      !Registry.blobKind(game, parts[1]) ||
      !/^[0-9a-f-]{36}$/.test(parts[2]) ||
      !/^[0-9a-f-]{36}$/.test(parts[3])
    ) {
      return Util.fail(Code.INVALID_ARGUMENT, "bad_key: not a blob key for " + game.id);
    }
    return parts;
  }

  /** Delete every blob a player uploaded, for every game. Best effort. */
  export function deleteAllFor(nk: nkruntime.Nakama, logger: nkruntime.Logger, cfg: S3.Config | null, userId: string): number {
    let deleted = 0;
    let cursor: string | undefined = undefined;
    do {
      const page: nkruntime.StorageObjectList = nk.storageList(userId, COLLECTION, 100, cursor);
      const objects = page.objects || [];
      const removals: nkruntime.StorageDeleteRequest[] = [];
      for (let i = 0; i < objects.length; i++) {
        const key = objects[i].value["key"];
        if (cfg && typeof key === "string") {
          try {
            if (!S3.deleteObject(nk, cfg, key)) {
              logger.warn("Could not delete blob %s for %s", key, userId);
              continue;
            }
          } catch (e) {
            logger.warn("Could not delete blob %s for %s: %s", key, userId, String(e));
            continue;
          }
        }
        removals.push({ collection: COLLECTION, key: objects[i].key, userId: userId });
        deleted++;
      }
      if (removals.length > 0) {
        nk.storageDelete(removals);
      }
      cursor = page.cursor || undefined;
    } while (cursor);
    return deleted;
  }
}

/** core.blob_upload_url {kind, size, content_type} -> {key, url, method, headers, expires_in} */
function rpcBlobUploadUrl(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const cfg = Blobs.requireConfig(ctx);
  const req = Util.parsePayload(payload);

  const kindName = Util.str(req, "kind", 48, true);
  const kind = Registry.blobKind(game, kindName);
  if (!kind) {
    return Util.fail(Code.INVALID_ARGUMENT, "unknown_kind: " + game.id + " has no blob kind '" + kindName + "'");
  }
  const size = Util.int(req, "size", 1, kind.maxBytes);
  const contentType = Util.str(req, "content_type", 100, false) || kind.contentTypes[0];
  if (kind.contentTypes.indexOf(contentType) < 0) {
    return Util.fail(Code.INVALID_ARGUMENT, "bad_content_type: allowed types are " + kind.contentTypes.join(", "));
  }
  RateLimit.check(nk, userId, "blob_upload." + game.id + "." + kind.name, kind.uploadsPerHour, 3600);

  const id = nk.uuidv4();
  const key = game.id + "/" + kind.name + "/" + userId + "/" + id;
  nk.storageWrite([
    {
      collection: Blobs.COLLECTION,
      key: id,
      userId: userId,
      value: { game: game.id, kind: kind.name, key: key, size: size, content_type: contentType, created: Util.nowSeconds() },
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);

  const headers = { "Content-Length": String(size), "Content-Type": contentType };
  const url = S3.presign(cfg, "PUT", key, Blobs.UPLOAD_EXPIRY_SEC, headers, new Date(), false);
  Telemetry.count(nk, Telemetry.METRIC.BLOB_UPLOADS, { game: game.id, kind: kind.name });
  return JSON.stringify({
    key: key,
    url: url,
    method: "PUT",
    headers: headers,
    expires_in: Blobs.UPLOAD_EXPIRY_SEC,
  });
}

/** core.blob_download_url {key} -> {url, expires_in} */
function rpcBlobDownloadUrl(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const cfg = Blobs.requireConfig(ctx);
  const req = Util.parsePayload(payload);
  const key = Util.str(req, "key", 200, true);
  const parts = Blobs.checkKey(game, key);
  Telemetry.count(nk, Telemetry.METRIC.BLOB_DOWNLOADS, { game: game.id, kind: parts[1] });

  if (cfg.publicUrl) {
    return JSON.stringify({ url: cfg.publicUrl + "/" + S3.uriEncode(key, true), expires_in: 0 });
  }
  const url = S3.presign(cfg, "GET", key, Blobs.DOWNLOAD_EXPIRY_SEC, {}, new Date(), false);
  return JSON.stringify({ url: url, expires_in: Blobs.DOWNLOAD_EXPIRY_SEC });
}

/** core.blob_delete {key} -> {} (owner only) */
function rpcBlobDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const cfg = Blobs.requireConfig(ctx);
  const req = Util.parsePayload(payload);
  const key = Util.str(req, "key", 200, true);
  const parts = Blobs.checkKey(game, key);
  if (parts[2] !== userId) {
    return Util.fail(Code.PERMISSION_DENIED, "not_owner: only the uploader can delete a blob");
  }
  if (!S3.deleteObject(nk, cfg, key)) {
    return Util.fail(Code.UNAVAILABLE, "storage_error: object storage did not delete the blob, try again later");
  }
  nk.storageDelete([{ collection: Blobs.COLLECTION, key: parts[3], userId: userId }]);
  return "{}";
}
