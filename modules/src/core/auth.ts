// Login checks: every session must say which game and client version it is.
//
// Clients pass session vars when they authenticate, for example
// {"game": "graveyard-hollow", "version": "0.1.0", "platform": "ubuntu"}.
// Nakama stores the vars in the session token, so every later call carries
// them without the client repeating itself.

namespace Auth {
  const ALLOWED_VARS: { [key: string]: number } = {
    game: 32,
    version: 32,
    platform: 32,
  };

  export function checkVars(ctx: nkruntime.Context, vars: { [key: string]: string } | null | undefined): void {
    if (!vars || !vars["game"]) {
      Util.fail(
        Code.INVALID_ARGUMENT,
        "missing_game: authenticate with session vars {game, version}, for example {\"game\": \"graveyard-hollow\", \"version\": \"1.0.0\"}",
      );
      return;
    }
    for (const key in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) {
        continue;
      }
      const max = ALLOWED_VARS[key];
      if (!max) {
        Util.fail(Code.INVALID_ARGUMENT, "bad_vars: unknown session var '" + key + "' (allowed: game, version, platform)");
      }
      if (typeof vars[key] !== "string" || vars[key].length > max) {
        Util.fail(Code.INVALID_ARGUMENT, "bad_vars: session var '" + key + "' is too long");
      }
    }
    const game = Registry.find(ctx, vars["game"]);
    if (!game) {
      Util.fail(Code.FAILED_PRECONDITION, "unknown_game: " + vars["game"] + " is not enabled on this server");
      return;
    }
    const version = vars["version"] || "";
    if (!Util.isVersion(version)) {
      Util.fail(Code.INVALID_ARGUMENT, "bad_version: session var 'version' must look like 1.2.3");
    }
    const min = Registry.minVersion(ctx, game);
    if (Util.compareVersions(version, min) < 0) {
      Util.fail(
        Code.FAILED_PRECONDITION,
        "update_required: " + game.name + " " + version + " is too old for this server, update to " + min + " or newer",
      );
    }
  }
}

function beforeAuthenticateDevice(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.AuthenticateDeviceRequest,
): nkruntime.AuthenticateDeviceRequest {
  const vars = data.account ? data.account.vars : null;
  Telemetry.checkLogin(ctx, nk, vars, function () {
    Auth.checkVars(ctx, vars);
  });
  return data;
}

function afterAuthenticateDevice(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.Session,
  request: nkruntime.AuthenticateDeviceRequest,
): void {
  Telemetry.login(ctx, nk, request.account ? request.account.vars : null, "device", data.created === true);
}

function beforeAuthenticateCustom(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.AuthenticateCustomRequest,
): nkruntime.AuthenticateCustomRequest {
  const vars = data.account ? data.account.vars : null;
  Telemetry.checkLogin(ctx, nk, vars, function () {
    Auth.checkVars(ctx, vars);
  });
  return data;
}

function afterAuthenticateCustom(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.Session,
  request: nkruntime.AuthenticateCustomRequest,
): void {
  Telemetry.login(ctx, nk, request.account ? request.account.vars : null, "custom", data.created === true);
}

function beforeAuthenticateEmail(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.AuthenticateEmailRequest,
): nkruntime.AuthenticateEmailRequest {
  const vars = data.account ? data.account.vars : null;
  Telemetry.checkLogin(ctx, nk, vars, function () {
    Auth.checkVars(ctx, vars);
  });
  return data;
}

function afterAuthenticateEmail(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.Session,
  request: nkruntime.AuthenticateEmailRequest,
): void {
  Telemetry.login(ctx, nk, request.account ? request.account.vars : null, "email", data.created === true);
}

function beforeAuthenticateSteam(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.AuthenticateSteamRequest,
): nkruntime.AuthenticateSteamRequest {
  const vars = data.account ? data.account.vars : null;
  Telemetry.checkLogin(ctx, nk, vars, function () {
    Auth.checkVars(ctx, vars);
  });
  return data;
}

function afterAuthenticateSteam(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.Session,
  request: nkruntime.AuthenticateSteamRequest,
): void {
  Telemetry.login(ctx, nk, request.account ? request.account.vars : null, "steam", data.created === true);
}
