// Potluck: a block sandbox where every creature, block and mini game is a
// Luau creation players can tweak, remix and share (game-ideas, idea 26).
//
// Creations go up as shares of kind "creation": the creation's files and
// knob settings as JSON in `data`, with `meta` naming who made it, what kind
// of thing it is and its id. Worlds friends join are hosted by the game or by
// potluck-server, not through rooms here. Builds from source report version
// 0.0.0+..., so the minimum stays at 0.0.0 while the game is in test.

const GAME_POTLUCK: Registry.GameDef = {
  id: "potluck",
  name: "Potluck",
  minVersion: "0.0.0",
  latestVersion: "0.0.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [],
  collections: [],
  blobs: [],
  shares: [{ name: "creation", maxBytes: 262144, perUserLimit: 200 }],
  rooms: null,
};
