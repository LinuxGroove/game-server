// core.config: what this server offers the caller's game.
//
// Clients call it once after login to learn which features are on, whether
// an update is available, and the full ids of their leaderboards.

function rpcConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  Util.requireUser(ctx);
  const game = Registry.forSession(ctx);
  const client = (ctx.vars && ctx.vars["version"]) || "";
  const latest = Registry.latestVersion(ctx, game);

  const leaderboards: any[] = [];
  for (let i = 0; i < game.leaderboards.length; i++) {
    const b = game.leaderboards[i];
    leaderboards.push({
      id: Registry.leaderboardId(game, b.id),
      name: b.id,
      sort: b.sort,
      operator: b.operator,
      reset: b.reset,
      client_submit: b.clientSubmit,
    });
  }
  const collections: any[] = [];
  for (let i = 0; i < game.collections.length; i++) {
    const c = game.collections[i];
    collections.push({ id: game.id + "." + c.name, name: c.name, client_write: c.clientWrite, max_bytes: c.maxBytes, read: c.read });
  }
  const blobsOn = S3.config(ctx) !== null;
  const blobs: any[] = [];
  for (let i = 0; i < game.blobs.length && blobsOn; i++) {
    const b = game.blobs[i];
    blobs.push({ kind: b.name, max_bytes: b.maxBytes, content_types: b.contentTypes });
  }
  const shares: any[] = [];
  for (let i = 0; i < game.shares.length; i++) {
    shares.push({ kind: game.shares[i].name, max_bytes: game.shares[i].maxBytes, per_user_limit: game.shares[i].perUserLimit });
  }
  const rooms = game.rooms
    ? {
        min_players: game.rooms.minPlayers,
        max_players: game.rooms.maxPlayers,
        mode: game.rooms.mode,
        matchmaking: game.rooms.matchmaking,
        tick_rate: game.rooms.tickRate,
        first_game_opcode: Relay.FIRST_GAME_OPCODE,
      }
    : null;

  return JSON.stringify({
    game: game.id,
    name: game.name,
    server_time: Util.nowSeconds(),
    motd: Util.env(ctx, Registry.envKey(game.id, "MOTD"), ""),
    version: {
      client: client,
      min: Registry.minVersion(ctx, game),
      latest: latest,
      update_available: client !== "" && Util.compareVersions(client, latest) < 0,
    },
    features: {
      chat: game.chat,
      leaderboards: leaderboards,
      collections: collections,
      blobs: blobs,
      shares: shares,
      rooms: rooms,
    },
  });
}
