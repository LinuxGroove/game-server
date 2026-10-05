// Sandbox: a test game that exercises every server feature.
//
// Off unless GAME_SANDBOX_ENABLED=true is in the runtime env. The local
// Compose setup and CI turn it on, so client developers can try score
// submission, blobs, share codes and rooms without touching real games.

const GAME_SANDBOX: Registry.GameDef = {
  id: "sandbox",
  name: "Sandbox",
  minVersion: "1.0.0",
  latestVersion: "1.2.0",
  enabledByDefault: false,
  chat: false,
  leaderboards: [
    { id: "score", sort: "desc", operator: "best", reset: null, clientSubmit: true, minScore: 0, maxScore: 1000000, enableRank: true },
    { id: "time_ms", sort: "asc", operator: "best", reset: "0 0 * * *", clientSubmit: true, minScore: 1000, maxScore: 3600000, enableRank: false },
    { id: "server_only", sort: "desc", operator: "incr", reset: null, clientSubmit: false, minScore: 0, maxScore: 1, enableRank: false },
  ],
  collections: [
    { name: "notes", clientWrite: true, maxBytes: 1024, read: "public" },
    { name: "private", clientWrite: true, maxBytes: 1024, read: "owner" },
  ],
  blobs: [{ name: "ghost", maxBytes: 65536, contentTypes: ["application/octet-stream"], uploadsPerHour: 60 }],
  shares: [{ name: "level", maxBytes: 16384, perUserLimit: 3 }],
  rooms: { minPlayers: 2, maxPlayers: 4, tickRate: 10, mode: "host", matchmaking: true, hostGraceSec: 5 },
};
