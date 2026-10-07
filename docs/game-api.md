# Game API

Everything a LinuxGroove game needs to talk to the game server. The server is
[Nakama](https://heroiclabs.com/docs/nakama/) 3.41 with this repository's
modules, so games use the official Nakama client for their engine (for Godot 4,
[nakama-godot](https://github.com/heroiclabs/nakama-godot)) plus the calls
described here.

One server and one database serve every game. A session belongs to one game,
and the server keeps each game's data in its own namespace:

| What | Name on the server | Example |
| --- | --- | --- |
| Leaderboards | `<game>.<board>` | `graveyard-hollow.wins` |
| Storage collections | `<game>.<name>` | `graveyard-hollow.progress` |
| Blob object keys | `<game>/<kind>/<user id>/<blob id>` | `sandbox/ghost/…/…` |
| Rooms | match name, or label field `game` | `graveyard-hollow:QX7K2M` |
| Game RPCs | `<game>.<name>` | `graveyard-hollow.round_report` |
| Shared RPCs | `core.<name>` | `core.config` |

Games stay offline-first: every call here is optional, and the game should
work without a server.

- [Connecting](#connecting)
- [Errors](#errors)
- [core.config](#coreconfig)
- [Storage](#storage-saves-profiles-settings)
- [Leaderboards](#leaderboards)
- [Share codes](#share-codes)
- [Blobs](#blobs-ghosts-replays-screenshots)
- [Online rooms](#online-rooms)
- [Account deletion and export](#account-deletion-and-export)
- [Graveyard Hollow](#graveyard-hollow)
- [Foam Frenzy](#foam-frenzy)
- [Sandbox test game](#sandbox-test-game)

## Connecting

| Setting | Local development | Public server |
| --- | --- | --- |
| Scheme, host, port | `http`, `127.0.0.1`, `7350` | `https`, the server's domain, `443` |
| Server key | `defaultkey` | The `server-key` the server admin sets; ship it in the game build |

Authenticate with **session vars** naming the game and client version. Every
login without them is refused, and every later call uses them to decide which
game's data the session can touch.

| Var | Required | Value |
| --- | --- | --- |
| `game` | yes | The game id, for example `graveyard-hollow` |
| `version` | yes | The client version, `MAJOR.MINOR.PATCH` with optional `+build` metadata. LinuxGroove games use `YYYY.WW.MINOR` (year and week of the release, with weeks running Sunday to Saturday and numbered like ISO weeks), and edge builds add the commits since it and the commit, like `2026.41.0+3.g1a2b3c4d`. Metadata is ignored when comparing versions |
| `platform` | no | For stats: `linux`, `ubuntu`, `ubuntu-core`, `steamos`, `windows`, `macos`, `android`, `ios` or `web` (others count as `other`) |

No other vars are accepted. Device authentication is the default: generate a
UUID on first launch, store it in `user://`, and reuse it. Players can later
link an email or Steam account with Nakama's normal link calls.

```gdscript
var client := Nakama.create_client(server_key, host, port, scheme)
var vars := {"game": "graveyard-hollow", "version": "0.1.0", "platform": "ubuntu"}
var session := await client.authenticate_device_async(device_id, null, true, vars)
if session.is_exception():
    # session.get_exception().message starts with a reason, see Errors.
    return
var socket := Nakama.create_socket_from(client)
await socket.connect_async(session)
```

Sessions last 2 hours and refresh tokens 30 days. Refreshing keeps the vars.
After updating the game, log in again (not just refresh) so the server sees the
new version.

When `version` is older than the game's minimum, login fails with
`update_required`; show the message and point the player at the store. The
server admin can raise the minimum without a server release (`snap set …
games.<id>.min-version=…`).

## Errors

Errors carry a gRPC status code (an HTTP status over REST) and a message that
starts with a stable reason, then a colon and a human-readable explanation:

```
update_required: Graveyard Hollow 0.0.9 is too old for this server, update to 0.1.0 or newer
```

Match on the part before the colon. Reasons:

| Reason | HTTP | Meaning |
| --- | --- | --- |
| `missing_game`, `bad_vars`, `bad_version` | 400 | Login without valid session vars |
| `unknown_game` | 400 | The game is not registered or is turned off on this server |
| `update_required` | 400 | The client is older than the game's minimum version |
| `no_game` | 401 | The session has no game var; log in again |
| `wrong_namespace`, `read_only`, `private_collection` | 403 | Storage write outside what the game allows |
| `too_large`, `too_many_objects` | 400 | Payload over the limit |
| `unknown_board` | 404 | No such leaderboard for this game |
| `server_only` | 403 | That board is written by the server only |
| `rate_limited` | 429 | Slow down and try later |
| `blobs_disabled` | 503 | The server has no object storage configured |
| `unknown_kind`, `bad_content_type`, `bad_key` | 400 | Bad blob or share request |
| `not_owner` | 403 | Only the creator can delete it |
| `storage_error`, `no_code` | 503 | Temporary, retry |
| `share_not_found`, `share_hidden` | 404 | No share with that code (or hidden after reports) |
| `share_limit` | 429 | Player has too many shares of that kind |
| `bad_code` | 400 | Code is the wrong length or has bad characters |
| `rooms_disabled`, `matchmaking_disabled`, `chat_disabled` | 400/403 | The game doesn't use that feature |
| `room_not_found` | 404 | No open room with that code |
| `bad_room_name`, `room_full` | (socket) | Bridge room refused, see [Bridge rooms](#bridge-rooms) |
| `use_room_rpcs`, `use_named_rooms` | 400 / (socket) | Wrong kind of room for this game |
| `confirm_required` | 400 | `core.account_delete` needs `{"confirm": "DELETE"}` |
| `wrong_game`, `not_host`, `not_in_room` | 403/400 | Game module checks (see the game's section) |
| `too_many_winners` | 400 | A single-winner Foam Frenzy mode reported more than one winner |
| `already_reported` | 409 | That round was already recorded |

## core.config

Call once after login. It says what this server offers the game, so the game
can hide features the server has turned off.

```gdscript
var res := await client.rpc_async(session, "core.config")
var config: Dictionary = JSON.parse_string(res.payload)
```

```json
{
  "game": "graveyard-hollow",
  "name": "Graveyard Hollow",
  "server_time": 1790000000,
  "motd": "",
  "version": {"client": "0.1.0", "min": "0.1.0", "latest": "0.1.0", "update_available": false},
  "features": {
    "chat": false,
    "leaderboards": [{"id": "graveyard-hollow.wins", "name": "wins", "sort": "desc", "operator": "incr", "reset": null, "client_submit": false}],
    "collections": [{"id": "graveyard-hollow.progress", "name": "progress", "client_write": true, "max_bytes": 32768, "read": "owner"}],
    "blobs": [],
    "shares": [],
    "rooms": {"transport": "bridge", "min_players": 4, "max_players": 10, "matchmaking": true, "room_name_prefix": "graveyard-hollow:"}
  }
}
```

`motd` is a message of the day the admin sets per game. `blobs` is empty when
the server has no object storage. For relay rooms, `rooms` has `"transport":
"relay"` with `mode`, `tick_rate` and `first_game_opcode` instead of
`room_name_prefix`.

## Storage (saves, profiles, settings)

Use Nakama's storage API with the game's collections (`<game>.<name>`). The
server refuses writes to any other collection, values over the collection's
size limit, more than 16 objects per write, and public read permission on
owner-only collections. Collections the game marks server-written (like
`graveyard-hollow.stats`) can be read but not written by clients.

```gdscript
var obj := NakamaWriteStorageObject.new("graveyard-hollow.progress", "main", 1, 1, JSON.stringify(progress), "")
await client.write_storage_objects_async(session, [obj])
```

Read permission `1` is owner only, `2` is public. Pass the version from the
last read to avoid overwriting a newer save from another device.

## Leaderboards

Boards are created by the server at startup as `<game>.<board>` and are
authoritative: clients can't write records directly. Read them with Nakama's
normal calls and the full id:

```gdscript
var top := await client.list_leaderboard_records_async(session, "graveyard-hollow.wins", null, null, 20)
var mine := await client.list_leaderboard_records_around_owner_async(session, "graveyard-hollow.wins", session.user_id, null, 5)
```

Boards the game marks `client_submit` take scores through `core.score_submit`,
which checks the score range and the game's own validation:

```
core.score_submit {"board": "time_ms", "score": 61234, "subscore": 0, "metadata": {"car": "red"}}
-> {"record": {"leaderboard_id", "owner_id", "score", "subscore", "rank", "update_time"}}
```

`board` is the short name. Metadata is optional, at most 2 KB. Other boards
are written by the game's server module (for Graveyard Hollow, from round reports).

## Share codes

Player-made content (tracks, levels, layouts) that others load by an 8
character code. Only for games that declare share kinds.

| RPC | Payload | Returns |
| --- | --- | --- |
| `core.share_create` | `{"kind", "title", "data", "meta"?}` | `{"code"}` |
| `core.share_get` | `{"code"}` | `{"code", "kind", "title", "data", "meta", "owner_id", "created"}` |
| `core.share_delete` | `{"code"}` | `{}` (creator only) |
| `core.share_list_mine` | `{"cursor"?}` | `{"shares": [{"code", "kind", "title", "created"}], "cursor"}` |
| `core.share_report` | `{"code", "reason"}` | `{}` |

`data` is a string (JSON or base64) up to the kind's size limit. `meta` is up
to 8 short keys with string, number or boolean values. Codes ignore case and
leave out look-alike characters (0, O, 1, I, L, U), and spaces and dashes are
ignored, so `ab3d-9xyz` finds `AB3D9XYZ`. Content reported by enough different players
(default 5) is hidden until an admin clears it.

## Blobs (ghosts, replays, screenshots)

Large files go straight to S3-compatible object storage through short-lived
pre-signed URLs; they never pass through the game server.

1. `core.blob_upload_url {"kind": "ghost", "size": 48213, "content_type": "application/octet-stream"}`
   returns `{"key", "url", "method": "PUT", "headers", "expires_in": 600}`.
2. `PUT` the bytes to `url` within 10 minutes, sending exactly the returned
   headers. The signature covers the size and content type, so anything else
   is refused by the storage.
3. Store or share the `key` (for example in a leaderboard record's metadata).
4. Anyone in the same game gets a download link with
   `core.blob_download_url {"key"}` → `{"url", "expires_in"}`.
5. The uploader can remove it with `core.blob_delete {"key"}`.

Check `core.config` first: when `features.blobs` is empty the server has no
object storage and these calls return `blobs_disabled`.

## Online rooms

Online play works like LAN play: one player's device is the **host** and runs
the game, and the server passes messages between players. A game uses one of
two kinds of room, set in its definition and reported by `core.config` as
`features.rooms.transport`:

| | Bridge rooms (`bridge`) | Relay rooms (`relay`) |
| --- | --- | --- |
| Client | nakama-godot's `NakamaMultiplayerBridge`: Godot's high-level multiplayer (`rpc`, `MultiplayerSynchronizer`) with the same code as LAN | Raw match messages with the protocol below |
| Room codes | Chosen by the client, room named `<game>:<CODE>` | Issued by the server, `core.room_create` |
| Host | First player in (the bridge decides) | The room's creator |
| Server checks | Name, game, room size, who opened the room | Also locking, kicks, public listing, host-only messages |
| Used by | Graveyard Hollow | Sandbox |

### Bridge rooms

The game picks a code (4–16 capital letters and digits) and every player,
host included, joins the room named `<game>:<CODE>`:

```gdscript
var bridge := NakamaMultiplayerBridge.new(socket)
bridge.match_join_error.connect(_on_join_error)
bridge.match_joined.connect(_on_joined)
bridge.join_named_match("graveyard-hollow:" + code)
multiplayer.multiplayer_peer = bridge.multiplayer_peer
```

The first player in becomes the host (peer 1). Quick match uses
`bridge.start_matchmaking(ticket)` with a ticket from
`socket.add_matchmaker_async(...)`; the server keeps tickets inside the game.

The server refuses `bad_room_name` (wrong game prefix, bad code, or an unnamed
`create_match()`), `room_full` (the game's `max_players` reached; players
already in can rejoin) and `use_room_rpcs` (the game uses relay rooms). A code
that nobody is using simply opens a new, empty room, so the joiner becomes its
host. Guests should look the code up first with
`core.room_find {"code"}` → `{"match_id", "code", "players", "max_players", "open"}`,
which answers `room_not_found` (without opening a room) when nobody is in it
or the player who opened it has left. A room can still empty between the
lookup and the join, so also check that you aren't peer 1 after joining.

### Relay rooms

The server runs the room (an authoritative "relay" match): it decides who may
join, assigns each player a slot number, and keeps the room's code and listing
up to date.

- **Invite code.** The host calls `core.room_create {"max_players"?, "listed"?, "meta"?}`
  → `{"match_id", "code"}` and joins `match_id` straight away (the room closes
  if its creator hasn't joined within the game's host grace time). Friends call
  `core.room_find {"code"}` → `{"match_id", "code", "players", "max_players", "open", "mode", "meta"}`
  and join. A brand-new room can take about a second to become findable, so
  retry `room_not_found` once or twice.
- **Public list.** `core.room_list {"limit"?}` → `{"rooms": [...]}`: listed
  rooms with free seats.
- **Quick match.** Add a matchmaker ticket over the socket with any query and
  properties. The server limits it to players of the same game and puts each
  matched group in a new room; join it with `socket.join_matched_async(matched)`.
  The first player to join becomes host.

```gdscript
var room := JSON.parse_string((await client.rpc_async(session, "core.room_create", JSON.stringify({"listed": false}))).payload)
var match := await socket.join_match_async(room["match_id"])
```

Joining can fail with `room_full`, `room_locked`, `room_closing`, `kicked`,
`not_invited` (matchmaker rooms are reserved) or `wrong_game`. The `core.room_*`
calls other than `core.room_find` return `use_named_rooms` for games that use
bridge rooms.

#### Messages

Game messages use opcodes **100 and up**. Their data starts with a small
target header, then the game's own bytes:

| Bytes | Meaning |
| --- | --- |
| 0 | N, the number of target slots (0 = default destination) |
| 1..N | Target slot numbers |
| rest | Game payload, forwarded untouched |

Default destination: in `host` mode, players' messages go to the host and the
host's go to everyone; in `broadcast` mode, to everyone else. In `host` mode
non-hosts can only ever reach the host. Receivers get just the payload, with
the sender's presence attached; map the sender's user id to a slot with the
peer list below.

```gdscript
func relay_packet(targets: Array, payload: PackedByteArray) -> PackedByteArray:
    var out := PackedByteArray([targets.size()])
    for slot in targets:
        out.append(slot)
    out.append_array(payload)
    return out

# Host sends a secret role to the player in slot 3 only.
socket.send_match_state_raw_async(match_id, 100, relay_packet([3], role_bytes))
```

Messages are forwarded once per server tick (the game's tick rate), so keep
them to state changes and inputs, not per-frame streams.

#### Control messages (opcodes 1–99, JSON)

From the server:

| Op | Name | Body |
| --- | --- | --- |
| 1 | WELCOME | `{"slot", "host_slot", "host_away", "peers": [{"slot", "user_id", "username"}], "code", "mode", "max_players", "room": {"locked", "listed", "meta"}, "first_game_opcode"}` (only to the joiner) |
| 2 | PEER_JOINED | `{"slot", "user_id", "username", "rejoined"}` |
| 3 | PEER_LEFT | `{"slot", "user_id"}` |
| 4 | HOST | `{"host_slot", "away"}` |
| 5 | ROOM | `{"locked", "listed", "meta"}` |
| 6 | CLOSING | `{"reason"}`: `closed_by_host`, `host_left`, `host_missing`, `expired` (6 hours), `server_shutdown` |
| 7 | KICKED | `{"reason"}` (to the kicked player) |
| 8 | ERROR | `{"op", "message"}` |

From the host:

| Op | Name | Body |
| --- | --- | --- |
| 20 | SET_ROOM | `{"locked"?, "listed"?, "meta"?}`: lock the room when a round starts |
| 21 | KICK | `{"slot", "reason"?}` |
| 22 | CLOSE | `{}` |

A player who drops and rejoins gets the same slot. In `host` mode, if the host
drops, everyone gets `HOST {"away": true}` and the room closes after the
game's host grace time unless the host comes back. Players who were in the
room before it was locked can rejoin a locked room. Empty rooms close after 60
seconds.

## Account deletion and export

Required from day one. `core.account_delete {"confirm": "DELETE"}` (or
Nakama's own account delete) removes the player's blobs from object storage
and their share codes, then the account, storage objects and leaderboard
records. `core.account_export` returns everything the server stores about the
player as JSON. Offer both in the game's settings.

For player counts the server also keeps, per player and game, the first and
last UTC day they logged in (`core.activity`, readable only by the server).
It is deleted with the account and included in the export. Server metrics
count players and events per game, never individual players.

## Graveyard Hollow

Game id `graveyard-hollow`. Bridge rooms named `graveyard-hollow:<CODE>` for 4–10
players, with quick match. No free-text chat.

| Collection | Client writes | Read | Max | Use |
| --- | --- | --- | --- | --- |
| `graveyard-hollow.profile` | yes | public allowed | 4 KB | Colour, hat, lantern style others see |
| `graveyard-hollow.progress` | yes | owner | 32 KB | Unlocks, synced between devices |
| `graveyard-hollow.stats` | server | public | | Key `stats`: `rounds`, `wins`, `village_rounds`, `village_wins`, `hollow_rounds`, `hollow_wins`, `survived` |

Leaderboards (server-written): `graveyard-hollow.wins` (all time) and
`graveyard-hollow.wins_weekly` (resets Monday 00:00 UTC).

The host's device keeps every secret role and sends each player only what that
player may see (`rpc_id` to one peer). When a round ends, the host reports it:

```
graveyard-hollow.round_report {
  "match_id": "<bridge.match_id>",
  "round": 3,
  "winner": "village",
  "players": [{"user_id": "...", "team": "village", "survived": true}, ...]
}
-> {"recorded": 7}
```

`players` lists signed-in players only, not bots. The server checks the room
is a Graveyard Hollow room, the caller opened it (for rooms joined by code; in
quick-match rooms, any player in the room may report), every listed player is
in the room now, and the round number wasn't already reported. Then it updates
each player's stats and the winners' leaderboard records. `team` and `winner`
are `village` or `hollow`.

## Foam Frenzy

Game id `foam-frenzy`. Bridge rooms named `foam-frenzy:<CODE>` for 2–8
players, with quick match. No free-text chat.

| Collection | Client writes | Read | Max | Use |
| --- | --- | --- | --- | --- |
| `foam-frenzy.profile` | yes | public allowed | 4 KB | Camper look and colours others see |
| `foam-frenzy.progress` | yes | owner | 32 KB | Unlocks and preferences, synced between devices |
| `foam-frenzy.stats` | server | public | | Key `stats`: `matches`, `wins`, `tags`, `outs`, `captures`, and `<mode>_matches`, `<mode>_wins` per mode |

Leaderboards (server-written): `foam-frenzy.wins` (all time),
`foam-frenzy.wins_weekly` (resets Monday 00:00 UTC) and `foam-frenzy.tags`
(campers tagged, all time).

When a match ends, the host reports it:

```
foam-frenzy.match_report {
  "match_id": "<bridge.match_id>",
  "round": 2,
  "mode": "ctf",
  "players": [{"user_id": "...", "tags": 6, "outs": 2, "captures": 1, "won": true}, ...]
}
-> {"recorded": 4}
```

`players` lists each device's signed-in player, not bots or couch guests.
`mode` is `ffa`, `teams`, `ctf` or `hoarder`; `tags` and `outs` are 0–500 and
`captures` 0–100, counted only in `ctf`. In `ffa` and `hoarder` at most one
player has `won` (none for a tie), or the report is refused with
`too_many_winners`; in `teams` and `ctf` every player on the winning team has
it. The server makes the same checks as for Graveyard Hollow round reports,
then updates each player's stats and the leaderboards.

## Sandbox test game

Game id `sandbox`, off unless the server enables it (the Compose setup and CI
do). It has one of everything, for trying the API without touching real game
data: boards `score` (client submit, best), `time_ms` (ascending, daily reset)
and `server_only`; collections `notes` (public allowed) and `private`; blob
kind `ghost` (64 KB, `application/octet-stream`); share kind `level`; relay
rooms of 2–4 players in `host` mode with quick match. `scripts/smoke-test.mjs`
shows every call in use.
