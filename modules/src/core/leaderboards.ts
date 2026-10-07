// Namespaced leaderboards.
//
// Every board is created as "<game>.<id>" and is authoritative, so players
// cannot write records directly. Players submit through core.score_submit
// (boards with clientSubmit) and game modules write the rest server-side.
// Reading uses Nakama's normal leaderboard APIs with the full id.

namespace Leaderboards {
  /** Create every registered board. Creation is idempotent in Nakama. */
  export function createAll(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama): void {
    for (let i = 0; i < Registry.GAMES.length; i++) {
      const game = Registry.GAMES[i];
      if (!Registry.isEnabled(ctx, game)) {
        continue;
      }
      for (let j = 0; j < game.leaderboards.length; j++) {
        const b = game.leaderboards[j];
        const id = Registry.leaderboardId(game, b.id);
        nk.leaderboardCreate(
          id,
          true,
          // Nakama accepts the short names; the type definitions only list some.
          b.sort as any,
          b.operator as any,
          b.reset,
          { game: game.id },
          b.enableRank,
        );
        logger.debug("Leaderboard ready: %s", id);
      }
    }
  }

  /** Write a record on behalf of a player (used by game modules too). */
  export function write(
    nk: nkruntime.Nakama,
    game: Registry.GameDef,
    boardId: string,
    userId: string,
    username: string,
    score: number,
    subscore: number,
    metadata: { [key: string]: any } | undefined,
  ): nkruntime.LeaderboardRecord {
    return nk.leaderboardRecordWrite(Registry.leaderboardId(game, boardId), userId, username, score, subscore, metadata);
  }
}

/** core.score_submit {board, score, subscore?, metadata?} -> {record} */
function rpcScoreSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  const userId = Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const req = Util.parsePayload(payload);

  const boardId = Util.str(req, "board", 48, true);
  const board = Registry.leaderboard(game, boardId);
  if (!board) {
    return Util.fail(Code.NOT_FOUND, "unknown_board: " + game.id + " has no leaderboard '" + boardId + "'");
  }
  if (!board.clientSubmit) {
    return Util.fail(Code.PERMISSION_DENIED, "server_only: " + boardId + " is updated by the server, not by clients");
  }
  const score = Util.int(req, "score", board.minScore, board.maxScore);
  const subscore = Util.int(req, "subscore", 0, 9007199254740991, 0);
  let metadata: { [key: string]: any } = {};
  if (req["metadata"] !== undefined && req["metadata"] !== null) {
    if (typeof req["metadata"] !== "object" || Array.isArray(req["metadata"])) {
      return Util.fail(Code.INVALID_ARGUMENT, "metadata must be a JSON object");
    }
    metadata = req["metadata"];
    if (Util.byteLength(JSON.stringify(metadata)) > 2048) {
      return Util.fail(Code.INVALID_ARGUMENT, "metadata must be 2 KB or less");
    }
  }
  RateLimit.check(nk, userId, "score." + game.id, 30, 60);
  if (board.validate) {
    board.validate(ctx, nk, userId, score, subscore, metadata);
  }

  const record = Leaderboards.write(nk, game, board.id, userId, ctx.username || "", score, subscore, metadata);
  Telemetry.count(nk, Telemetry.METRIC.SCORES_SUBMITTED, { game: game.id, board: board.id });
  return JSON.stringify({
    record: {
      leaderboard_id: record.leaderboardId,
      owner_id: record.ownerId,
      score: record.score,
      subscore: record.subscore,
      rank: record.rank,
      update_time: record.updateTime,
    },
  });
}
