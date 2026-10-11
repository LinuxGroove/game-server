// Verdigris Protocol: a first person horror shooter for one player against an
// alien growth on a space station (game-ideas, idea 21).
//
// Shift mode's boards: a night's score on tonight's station (the same seed
// for everyone, from the UTC date) goes on a board that resets at midnight
// UTC and on an all-time board of best nights. The client submits with
// core.score_submit; a night is three decks, each worth at most about 2,500.

const GAME_VERDIGRIS_PROTOCOL: Registry.GameDef = {
  id: "verdigris-protocol",
  name: "Verdigris Protocol",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  enabledByDefault: true,
  chat: false,
  leaderboards: [
    { id: "shift_daily", sort: "desc", operator: "best", reset: "0 0 * * *", clientSubmit: true, minScore: 1, maxScore: 20000, enableRank: true },
    { id: "shift_best", sort: "desc", operator: "best", reset: null, clientSubmit: true, minScore: 1, maxScore: 20000, enableRank: true },
  ],
  collections: [],
  blobs: [],
  shares: [],
  rooms: null,
};
