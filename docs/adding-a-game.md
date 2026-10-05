# Adding a game

Every LinuxGroove game shares this server. Adding one is a pull request to
this repository: describe the game's data in a definition, add any
game-specific server logic, and ship a new server build. Nothing is created by
hand in the database.

## 1. Write the definition

Create `modules/src/games/<id>.ts`. The id is a lower-case slug (letters,
digits and `-`), used in every namespace, and must never change once players
have data under it.

```ts
const GAME_FOAM_FRENZY: Registry.GameDef = {
  id: "foam-frenzy",
  name: "Foam Frenzy",
  minVersion: "0.1.0",     // older clients are refused at login
  latestVersion: "0.1.0",  // older clients are told an update exists
  enabledByDefault: true,
  chat: false,
  leaderboards: [
    // Created at startup as "foam-frenzy.best_time".
    { id: "best_time", sort: "asc", operator: "best", reset: null, clientSubmit: true,
      minScore: 5000, maxScore: 600000, enableRank: true },
  ],
  collections: [
    { name: "progress", clientWrite: true, maxBytes: 32768, read: "owner" },
  ],
  blobs: [
    { name: "ghost", maxBytes: 262144, contentTypes: ["application/octet-stream"], uploadsPerHour: 30 },
  ],
  shares: [
    { name: "track", maxBytes: 65536, perUserLimit: 50 },
  ],
  rooms: { minPlayers: 2, maxPlayers: 8, tickRate: 20, mode: "broadcast", matchmaking: true, hostGraceSec: 15 },
};
```

What each part gives the game is in [game-api.md](game-api.md). Notes:

- **Leaderboards.** `operator` is `best`, `set`, `incr` or `decr`; `reset` is
  a UTC cron expression or `null`. Boards with `clientSubmit: false` are only
  written by server code. Add a `validate(ctx, nk, userId, score, subscore,
  metadata)` function to reject impossible scores (call `Util.fail`). Turn on
  `enableRank` only for boards that show ranks, since it costs memory.
- **Collections.** `clientWrite: false` makes a collection server-written
  (for stats or rewards the game must not be able to forge). `read: "owner"`
  stops players from making objects public. The name `shares` is reserved.
- **Blobs** need object storage on the server; games must work without it.
- **Rooms.** Use `host` mode when one device must hold secrets or run the
  simulation (the host is the authority and the room closes if it leaves);
  `broadcast` when every player is equal, in which case the host role moves
  on when the host leaves. Set `rooms: null` for games without online play.
- **chat** turns on Nakama's free-text chat channels. Leave it off unless the
  game has moderation planned.

## 2. Register it

Add the file to `modules/tsconfig.json`, after the core files and before
`src/games/index.ts`:

```json
"src/games/lantern-out.ts",
"src/games/foam-frenzy.ts",
"src/games/sandbox.ts",
"src/games/index.ts",
```

and add the definition to `modules/src/games/index.ts`:

```ts
Registry.GAMES.push(GAME_LANTERN_OUT, GAME_FOAM_FRENZY, GAME_SANDBOX);
```

The server checks every definition at startup (ids, duplicate names, score
ranges, room sizes) and refuses to start with a clear message if one is wrong.
`npm test` catches the same mistakes.

## 3. Add server logic, if the game needs it

Most games need none: storage, leaderboards, shares, blobs and rooms are
generic. When a game needs its own rules, such as Lantern Out turning a host's
round report into stats and leaderboard records, add RPCs in the game's file.

Nakama's JavaScript runtime finds handlers by reading `InitModule`'s source,
so the rules are strict:

- Handlers are **global functions** with a name unique across all games:
  prefix it with the game, for example `rpcFoamFrenzyRaceResult`.
- Register each one in `modules/src/main.ts` under "Game modules", as a plain
  statement with a literal id named `<game>.<name>`:

  ```ts
  initializer.registerRpc("foam-frenzy.race_result", rpcFoamFrenzyRaceResult);
  ```

- Put helpers in a namespace named after the game (`namespace FoamFrenzy`).
- Start every handler with `Util.requireUser(ctx)` and
  `Registry.forSession(ctx)`, and refuse sessions of other games.
- Throw with `Util.fail(Code.X, "reason: explanation")` so clients get a
  stable reason.
- Rate-limit anything that writes with `RateLimit.check`.
- Read the room roster with `nk.matchSignal(matchId, '{"op": "roster"}')` to
  check that reported players were really in the room
  ([lantern-out.ts](../modules/src/games/lantern-out.ts) is the example).

The runtime is ES5 JavaScript (goja): no `async`, no Node or browser APIs, and
match state must be plain objects of strings, numbers and booleans.

## 4. Test

```sh
cd modules
npm ci
npm test               # type check, build, unit tests
cd ..
docker compose -f deploy/compose/compose.yaml up -d --wait
node scripts/smoke-test.mjs
```

Add unit tests for pure logic in `modules/test/` and end-to-end checks for the
game's RPCs to `scripts/smoke-test.mjs`. CI runs both, against Compose and
against the installed snap.

## 5. Ship

Merge, then publish a new snap revision. Servers pick it up on their next
refresh; Nakama creates the new game's leaderboards at startup. To keep a game
dark until launch, ship it with `enabledByDefault: false` and turn it on per
server with `snap set linuxgroove-game-server games.<id>.enabled=true`.

Removing a game or a leaderboard from the code doesn't delete its data; it is
just no longer served.
