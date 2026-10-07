// Account deletion and data export, required from day one.
//
// Players can delete their account with Nakama's own DELETE /v2/account or
// with core.account_delete. Both remove the player's blobs from object
// storage and their share codes first; Nakama then deletes the account,
// storage objects, leaderboard records and friends.

namespace Account {
  export function cleanup(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, userId: string): void {
    const blobs = Blobs.deleteAllFor(nk, logger, S3.config(ctx), userId);
    Shares.deleteAllFor(nk, userId);
    logger.info("Cleaned up account %s before deletion (%d blobs)", userId, blobs);
    const game = Registry.find(ctx, ctx.vars ? ctx.vars["game"] || "" : "");
    Telemetry.count(nk, Telemetry.METRIC.ACCOUNT_DELETIONS, { game: game ? game.id : "unknown" });
  }
}

function beforeDeleteAccount(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, data: void): void {
  if (ctx.userId) {
    Account.cleanup(ctx, logger, nk, ctx.userId);
  }
}

/** core.account_delete {confirm: "DELETE"} -> {} */
function rpcAccountDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const req = Util.parsePayload(payload);
  if (req["confirm"] !== "DELETE") {
    return Util.fail(Code.INVALID_ARGUMENT, "confirm_required: send {\"confirm\": \"DELETE\"} to delete this account");
  }
  Account.cleanup(ctx, logger, nk, userId);
  nk.accountDeleteId(userId, false);
  return "{}";
}

/** core.account_export -> everything the server stores about the caller, as JSON. */
function rpcAccountExport(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  RateLimit.check(nk, userId, "account_export", 5, 3600);
  return nk.accountExportId(userId);
}
