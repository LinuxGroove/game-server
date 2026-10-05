// Hooks that keep each game inside its own namespace.
//
// Nakama lets clients write any storage collection and join any matchmaker
// pool by default. These hooks limit a session to its own game's declared
// collections, tag matchmaker tickets with the game, and keep free-text chat
// off unless a game turns it on.

const MAX_STORAGE_OBJECTS_PER_WRITE = 16;

namespace Guards {
  /** Split "<game>.<name>" and check it is a client-writable collection. */
  export function clientCollection(game: Registry.GameDef, collection: string | undefined): Registry.CollectionDef {
    const full = collection || "";
    const dot = full.indexOf(".");
    const prefix = dot > 0 ? full.substr(0, dot) : "";
    const name = dot > 0 ? full.substr(dot + 1) : "";
    if (prefix !== game.id) {
      return Util.fail(
        Code.PERMISSION_DENIED,
        "wrong_namespace: " + game.id + " sessions can only write collections named " + game.id + ".<name>",
      );
    }
    const def = Registry.collection(game, name);
    if (!def || !def.clientWrite) {
      return Util.fail(Code.PERMISSION_DENIED, "read_only: " + full + " is not writable by clients");
    }
    return def;
  }
}

function beforeWriteStorageObjects(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.WriteStorageObjectsRequest,
): nkruntime.WriteStorageObjectsRequest {
  const game = Registry.forSession(ctx);
  const objects = data.objects || [];
  if (objects.length > MAX_STORAGE_OBJECTS_PER_WRITE) {
    Util.fail(Code.INVALID_ARGUMENT, "too_many_objects: write at most " + MAX_STORAGE_OBJECTS_PER_WRITE + " objects at once");
  }
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const def = Guards.clientCollection(game, obj.collection);
    if (Util.byteLength(obj.value || "") > def.maxBytes) {
      Util.fail(Code.INVALID_ARGUMENT, "too_large: objects in " + obj.collection + " must be " + def.maxBytes + " bytes or less");
    }
    if (obj.permissionRead === 2 && def.read !== "public") {
      Util.fail(Code.PERMISSION_DENIED, "private_collection: objects in " + obj.collection + " cannot be public");
    }
  }
  return data;
}

function beforeDeleteStorageObjects(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  data: nkruntime.DeleteStorageObjectsRequest,
): nkruntime.DeleteStorageObjectsRequest {
  const game = Registry.forSession(ctx);
  const ids = data.objectIds || [];
  for (let i = 0; i < ids.length; i++) {
    Guards.clientCollection(game, ids[i].collection);
  }
  return data;
}

/** Matchmaker tickets only ever match players of the same game. */
function beforeMatchmakerAdd(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.EnvelopeMatchmakerAdd,
): nkruntime.EnvelopeMatchmakerAdd {
  const game = Registry.forSession(ctx);
  if (!game.rooms || !game.rooms.matchmaking) {
    Util.fail(Code.FAILED_PRECONDITION, "matchmaking_disabled: " + game.id + " does not use the matchmaker");
  }
  const msg = envelope.matchmakerAdd;
  Rooms.tagTicket(game, msg);
  return envelope;
}

function beforePartyMatchmakerAdd(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.EnvelopePartyMatchmakerAdd,
): nkruntime.EnvelopePartyMatchmakerAdd {
  const game = Registry.forSession(ctx);
  if (!game.rooms || !game.rooms.matchmaking) {
    Util.fail(Code.FAILED_PRECONDITION, "matchmaking_disabled: " + game.id + " does not use the matchmaker");
  }
  Rooms.tagTicket(game, envelope.partyMatchmakerAdd);
  return envelope;
}

/** Free-text chat is off unless the game enables it. */
function beforeChannelJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  envelope: nkruntime.EnvelopeChannelJoin,
): nkruntime.EnvelopeChannelJoin {
  const game = Registry.forSession(ctx);
  if (!game.chat) {
    Util.fail(Code.PERMISSION_DENIED, "chat_disabled: " + game.id + " has no free-text chat");
  }
  return envelope;
}
