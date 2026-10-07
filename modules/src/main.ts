// Entry point Nakama calls once at startup.
//
// Nakama finds each handler by reading this function's source, so every
// register* call must be a plain statement here, with a string id and the
// name of a global function. No loops, helpers or inline functions.

function InitModule(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, initializer: nkruntime.Initializer) {
  const errors = Registry.validateAll();
  if (errors.length > 0) {
    throw new Error("Invalid game registry:\n" + errors.join("\n"));
  }

  // Login checks: every session names its game and client version. The
  // after hooks count logins, daily players and retention (telemetry.ts).
  initializer.registerBeforeAuthenticateDevice(beforeAuthenticateDevice);
  initializer.registerBeforeAuthenticateCustom(beforeAuthenticateCustom);
  initializer.registerBeforeAuthenticateEmail(beforeAuthenticateEmail);
  initializer.registerBeforeAuthenticateSteam(beforeAuthenticateSteam);
  initializer.registerAfterAuthenticateDevice(afterAuthenticateDevice);
  initializer.registerAfterAuthenticateCustom(afterAuthenticateCustom);
  initializer.registerAfterAuthenticateEmail(afterAuthenticateEmail);
  initializer.registerAfterAuthenticateSteam(afterAuthenticateSteam);

  // Namespacing and safety guards.
  initializer.registerBeforeWriteStorageObjects(beforeWriteStorageObjects);
  initializer.registerBeforeDeleteStorageObjects(beforeDeleteStorageObjects);
  initializer.registerRtBefore("MatchmakerAdd", beforeMatchmakerAdd);
  initializer.registerRtBefore("PartyMatchmakerAdd", beforePartyMatchmakerAdd);
  initializer.registerRtBefore("ChannelJoin", beforeChannelJoin);
  initializer.registerBeforeDeleteAccount(beforeDeleteAccount);

  // Shared services for every game.
  initializer.registerRpc("core.config", rpcConfig);
  initializer.registerRpc("core.score_submit", rpcScoreSubmit);
  initializer.registerRpc("core.blob_upload_url", rpcBlobUploadUrl);
  initializer.registerRpc("core.blob_download_url", rpcBlobDownloadUrl);
  initializer.registerRpc("core.blob_delete", rpcBlobDelete);
  initializer.registerRpc("core.share_create", rpcShareCreate);
  initializer.registerRpc("core.share_get", rpcShareGet);
  initializer.registerRpc("core.share_delete", rpcShareDelete);
  initializer.registerRpc("core.share_list_mine", rpcShareListMine);
  initializer.registerRpc("core.share_report", rpcShareReport);
  initializer.registerRpc("core.room_create", rpcRoomCreate);
  initializer.registerRpc("core.room_find", rpcRoomFind);
  initializer.registerRpc("core.room_list", rpcRoomList);
  initializer.registerRpc("core.account_delete", rpcAccountDelete);
  initializer.registerRpc("core.account_export", rpcAccountExport);

  // Online rooms: named bridge rooms (Nakama relayed matches) and relay rooms.
  initializer.registerRtBefore("MatchCreate", beforeMatchCreate);
  initializer.registerRtBefore("MatchJoin", beforeMatchJoin);
  initializer.registerMatch("relay", {
    matchInit: relayMatchInit,
    matchJoinAttempt: relayMatchJoinAttempt,
    matchJoin: relayMatchJoin,
    matchLeave: relayMatchLeave,
    matchLoop: relayMatchLoop,
    matchTerminate: relayMatchTerminate,
    matchSignal: relayMatchSignal,
  });
  initializer.registerMatchmakerMatched(matchmakerMatched);

  // Game modules.
  initializer.registerRpc("graveyard-hollow.round_report", rpcGraveyardHollowRoundReport);

  Leaderboards.createAll(ctx, logger, nk);
  Telemetry.init(ctx, nk);

  const enabled: string[] = [];
  for (let i = 0; i < Registry.GAMES.length; i++) {
    if (Registry.isEnabled(ctx, Registry.GAMES[i])) {
      enabled.push(Registry.GAMES[i].id);
    }
  }
  logger.info("Game server modules loaded. Games: %s", enabled.join(", "));
}
