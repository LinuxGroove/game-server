# Running the server

The production server is the `linuxgroove-game-server` snap: Nakama,
PostgreSQL 16, the game modules and Caddy (for HTTPS) in one strictly confined
package. It follows the [hosting plan](https://github.com/kenvandine/game-ideas/blob/main/infrastructure/nakama-hosting.md):
one Ubuntu server to start, the database split onto its own machine when it
needs to be.

- [Install](#install)
- [Settings](#settings)
- [Secrets](#secrets)
- [HTTPS and firewall](#https-and-firewall)
- [Admin console](#admin-console)
- [Object storage for blobs](#object-storage-for-blobs)
- [Backups and restore](#backups-and-restore)
- [Scaling](#scaling)
- [Updates](#updates)
- [Monitoring](#monitoring)
- [Docker Compose instead](#docker-compose-instead)

## Install

```sh
sudo snap install linuxgroove-game-server
sudo linuxgroove-game-server.info
```

The first start creates the database, generates every secret and starts
serving on port 7350. `info` prints the API address, the console login and
where backups go. Check it is up with `curl http://127.0.0.1:7350/healthcheck`.

Before players use it, set the server key the games ship with and a domain:

```sh
sudo snap set linuxgroove-game-server server-key=<key> domain=api.example.org
```

## Settings

Change settings with `sudo snap set linuxgroove-game-server key=value`. The
snap checks every value, refuses bad ones, and restarts only the services a
change affects. `snap get linuxgroove-game-server` shows the current values.

| Setting | Default | What it does |
| --- | --- | --- |
| `role` | `all` | `all`: everything on this machine. `api`: Nakama only, with an external database. `database`: PostgreSQL only |
| `server-key` | `defaultkey` | Key the game clients send. Set your own before going public |
| `domain` | | Public host name. Turns on Caddy with automatic HTTPS on ports 80 and 443 |
| `proxy.email` | | Contact address for the Let's Encrypt account |
| `api.address` | `0.0.0.0` (`127.0.0.1` with a domain) | Where Nakama listens |
| `api.port` | `7350` | Nakama's API and socket port |
| `console.address` | `127.0.0.1` | Where the admin console listens |
| `console.port` | `7351` | Admin console port |
| `node-name` | `game-server` | Nakama node name (logs, metrics) |
| `log-level` | `info` | `debug`, `info`, `warn` or `error` |
| `metrics.port` | `0` (off) | Prometheus metrics port |
| `postgres.listen-address` | `127.0.0.1` | Extra address PostgreSQL listens on (for `role=database`) |
| `postgres.port` | `5432` | PostgreSQL port |
| `postgres.allowed-cidrs` | | Comma-separated networks allowed to connect as `nakama` (for `role=database`) |
| `postgres.shared-buffers` | 25% of RAM, at most 8 GB | PostgreSQL `shared_buffers` |
| `postgres.effective-cache-size` | 60% of RAM | PostgreSQL `effective_cache_size` |
| `postgres.max-connections` | `100` | PostgreSQL `max_connections` |
| `backup.enabled` | `true` | Nightly database dump between 03:00 and 04:00 |
| `backup.keep-days` | `7` | Days of dumps to keep |
| `games.<id>.enabled` | per game | Turn a game on or off on this server (`games.sandbox.enabled=true` for the test game) |
| `games.<id>.min-version` | per game | Refuse older clients (`update_required`) |
| `games.<id>.latest-version` | per game | Tell older clients an update exists |
| `games.<id>.motd` | | Message of the day for that game's players |
| `blobs.endpoint` | | S3-compatible endpoint, for example `https://<account>.r2.cloudflarestorage.com` |
| `blobs.bucket` | | Bucket name |
| `blobs.region` | `us-east-1` | Region (`auto` for Cloudflare R2) |
| `blobs.access-key-id` | | Access key id (the secret key is a [secret](#secrets)) |
| `blobs.public-url` | | Public or CDN base URL for downloads, instead of signed links |
| `blobs.virtual-host` | `false` | Use `bucket.host` style URLs |
| `blobs.internal-endpoint` | | Endpoint the server itself uses, if different from the public one |
| `shares.hide-threshold` | `5` | Player reports that hide a share until an admin clears it |

Game ids in `games.*` use dashes as in the game id (`games.graveyard-hollow.motd`).

## Secrets

Snap settings are readable by every local user, so passwords live in
`/var/snap/linuxgroove-game-server/current/secrets` (root only) instead. The
snap generates its own (session keys, console password, database passwords) on
first start. Two are yours to set, from standard input:

```sh
echo -n 'nakama:<password>@db.internal:5432/nakama?sslmode=require' | sudo linuxgroove-game-server.secret set database-url
echo -n '<secret key>' | sudo linuxgroove-game-server.secret set s3-secret-access-key
sudo snap restart linuxgroove-game-server
```

`secret unset <name>` removes one. A `database-url` makes Nakama use that
database instead of the bundled one.

## HTTPS and firewall

With `domain` set, Caddy gets a certificate from Let's Encrypt and proxies
443 to Nakama, which then listens on localhost only. Point the domain's DNS at
the server first. Open only:

| Port | For |
| --- | --- |
| 80, 443 | Players (HTTP is only for certificate challenges and redirects) |
| 22 | You |
| 5432 | API nodes, on `role=database` machines only, over a private network or WireGuard |

Without a domain, players connect to port 7350 over plain HTTP, which is fine
on a LAN or for testing but not for a public server.

Caddy listens on 80 and 443 on every address, so nothing else on the machine
may use those ports, not even on one address such as a Tailscale one. If
another program has them, the proxy keeps retrying every few seconds and
`snap logs linuxgroove-game-server.proxy` says `address already in use`;
players can't connect until the port is free again.

Caddy also serves `POST /launch`, the games' [launch pings](game-api.md#launch-pings),
by calling the `core.launch` RPC with the runtime HTTP key, which is why its
generated Caddyfile is readable by root only. A server without a domain has no
`/launch`, so games pointed at it send no launch pings.

## Admin console

Nakama's console (players, storage, leaderboards, live matches) listens on
localhost. Reach it through an SSH tunnel:

```sh
ssh -L 7351:127.0.0.1:7351 you@server
# then open http://127.0.0.1:7351, user "operator", password from .info
```

Or serve it on your tailnet, on a port other than 443 (see above):

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:7351
# then open https://<machine>.<tailnet>.ts.net:8443
```

Clear a share hidden by reports by editing its `core.share_codes` object
(set `hidden` to `false` and `reports` to `0`), or delete it.

## Object storage for blobs

Ghosts, replays and screenshots go to S3-compatible storage (Cloudflare R2,
Backblaze B2, Garage, MinIO and others). Without it everything else works
and games hide blob features.

```sh
echo -n '<secret key>' | sudo linuxgroove-game-server.secret set s3-secret-access-key
sudo snap set linuxgroove-game-server \
  blobs.endpoint=https://<account>.r2.cloudflarestorage.com blobs.region=auto \
  blobs.bucket=linuxgroove-blobs blobs.access-key-id=<key id>
```

Give the key read, write and delete on that bucket only. Objects are keyed
`<game>/<kind>/<user>/<id>`, so set retention with lifecycle rules per prefix
(for example, expire `toybox-grand-prix/ghost/` after 90 days). The bucket's CORS
rules don't matter for native games.

## Backups and restore

Every night between 03:00 and 04:00, and before every snap refresh, the snap
dumps the database to `/var/snap/linuxgroove-game-server/common/backups` and
deletes dumps older than `backup.keep-days`. Run one by hand with
`sudo linuxgroove-game-server.backup`.

**Copy the dumps off the machine**, to storage at a different provider; a
local dump doesn't survive losing the server. For example, a root cron job
with [restic](https://restic.net) or `rclone copy` to a Backblaze B2 bucket.

To restore:

```sh
sudo snap stop linuxgroove-game-server.nakama
sudo linuxgroove-game-server.restore /var/snap/linuxgroove-game-server/common/backups/nakama-<stamp>.dump
sudo snap start linuxgroove-game-server.nakama
```

Practise a restore on a scratch machine every month (`scripts/smoke-test.mjs`
checks the result). Open `sudo linuxgroove-game-server.psql` for a SQL shell.

Not yet built in: continuous WAL archiving for point-in-time recovery (the
plan's WAL-G or pgBackRest). Until then the worst case is losing the day since
the last dump.

## Scaling

One machine running everything goes a long way: a bigger machine is the
first scaling step. When the database needs its own machine:

1. On the new database machine:

   ```sh
   sudo snap install linuxgroove-game-server
   sudo snap set linuxgroove-game-server role=database \
     postgres.listen-address=10.0.0.2 postgres.allowed-cidrs=10.0.0.0/24
   sudo linuxgroove-game-server.info      # shows the nakama database password
   ```

2. Move the data: `backup` on the old machine, copy the dump over, then
   `restore` on the new one.
3. On the API machine:

   ```sh
   echo -n 'nakama:<password>@10.0.0.2:5432/nakama?sslmode=disable' | sudo linuxgroove-game-server.secret set database-url
   sudo snap set linuxgroove-game-server role=api
   ```

   The bundled PostgreSQL on the API machine stops. Use a private network or
   WireGuard between the machines (the database connection isn't encrypted
   unless your database serves TLS).

A managed PostgreSQL works the same way: set its `database-url` and
`role=api`.

### Beyond one API machine (planned, not built)

Open-source Nakama doesn't cluster: sockets, rooms, the matchmaker and
presence live in one node's memory, and clustering is only in Heroic Labs'
paid edition. Two copies of the same server behind a load balancer would
split players into groups that can't see each other. A single node handles
tens of thousands of players online at once, so this is a later problem.
When it comes, the plan is Kubernetes, in this order:

1. **One Nakama per game, sharing one database.** Sessions are bound to one
   game and rooms and matchmaking never cross games, so each game (or group
   of small games) can run its own Nakama with its own hostname, with only
   that game turned on (`games.<id>.enabled`). Accounts and leaderboards stay
   in the shared PostgreSQL. To check first: leaderboard reset schedules and
   rank caches when several nodes share a database.
2. **Highly available PostgreSQL** with CloudNativePG: a standby that takes
   over on failure, continuous WAL backups to object storage and
   point-in-time restore, replacing the nightly dumps.
3. **A Helm chart** with cert-manager for HTTPS, health checks so a crashed
   server restarts on its own, and Prometheus scraping of Nakama's metrics.
   CI would test it on a throwaway kind cluster.
4. **Server-run matches** for games that need them: headless Godot servers
   scheduled by Agones, which scales them with demand.

Kubernetes with a database standby costs several times the single-machine
setup, so it waits until player numbers call for it. The snap stays the way
to run small servers.

## Updates

`snap refresh` brings new versions of the modules, Nakama and PostgreSQL 16.
Every refresh first dumps the database, and Nakama applies its own schema
migrations when it starts. `snap revert` goes back to the previous version of
the software but not of the data, so after a Nakama upgrade restore the
pre-refresh dump if you revert.

To run modified modules without rebuilding the snap, put a built `index.js` in
`/var/snap/linuxgroove-game-server/common/modules/` and restart; delete it to
go back to the bundled ones.

### Versions and channels

The snap uses the LinuxGroove games' version scheme. Releases are tagged
`vYYYY.WW.MINOR`: the year and week (weeks run Sunday to Saturday, UTC,
numbered like ISO weeks), then a number from 0 for that week's releases.
Every push to `main` is published to `edge` as the last release plus the
commits since it and the commit, like `2026.41.0+3.g1a2b3c4d`
(`tools/version.sh` works it out, and CI stamps it into `snapcraft.yaml`).
`linuxgroove-game-server.info` shows the running version.

Releases are made with the **Release** workflow (Actions, Release, Run
workflow). It refuses a commit whose CI hasn't passed, picks the next version
by itself, publishes a GitHub release whose notes point at the Snap Store and
list the changes since the last release (`tools/release.sh`), and starts the
**Snap** workflow on the tag, which publishes that build to `candidate`.
Promote it to `stable` in the Snap Store once it has run well:

```sh
sudo snap refresh linuxgroove-game-server --candidate   # try a release
sudo snap refresh linuxgroove-game-server --edge        # follow main
```

Publishing needs the snap registered in the Snap Store and a `STORE_LOGIN`
secret in the repository (`snapcraft export-login`).

## Monitoring

- `GET /healthcheck` on the API port (or `https://<domain>/healthcheck`):
  point a free uptime monitor at it.
- `snap logs -n=100 linuxgroove-game-server` for Nakama, PostgreSQL and Caddy
  logs (Nakama logs JSON).
- `snap set linuxgroove-game-server metrics.port=9100` exposes Prometheus
  metrics. Keep the port closed in the firewall and scrape it locally.
- Alert when the newest file in the backups folder is older than 26 hours.

### Game telemetry

With metrics on, the modules add counters per game next to Nakama's own
metrics, all prefixed `nakama_custom_`:

| Metric | Labels | Counts |
| --- | --- | --- |
| `logins` | game, version, platform, method, new | Successful logins (`new`: account created) |
| `logins_rejected` | game, reason | Refused logins (`update_required`, `unknown_game`, ...) |
| `active_players` | game | A player's first login of the UTC day (daily actives) |
| `new_players` | game | A player's first login to that game |
| `returning_players` | game, day | Players back exactly 1, 7 or 30 days (`d1`, `d7`, `d30`) after their first day |
| `rooms_opened` | game, transport, source | Rooms by `relay`/`bridge`, opened by `code` or `matchmaker` |
| `rooms_closed` | game, reason | Relay rooms ending, and why |
| `room_seconds`, `room_players` | game | Summed over closed relay rooms (divide by `rooms_closed` for averages) |
| `matchmaker_matches` | game | Matchmaker results |
| `rounds`, `round_players` | game, outcome | Rounds reported by game modules |
| `scores_submitted` | game, board | `core.score_submit` calls |
| `blob_uploads`, `blob_downloads`, `shares_created` | game, kind | Upload and download links handed out, shares made |
| `shares_opened`, `share_reports`, `account_deletions` | game | |
| `launches` | game, version, os, os_version, arch | Every [launch ping](game-api.md#launch-pings), signed in or not |
| `launch_players` | game | An install's first launch of the UTC day (daily players, signed in or not) |
| `launch_systems` | game, os, arch | The same, by system |
| `new_installs` | game | An install's first launch |
| `returning_installs` | game, day | Installs launched again exactly 1, 7 or 30 days after their first day |
| `installs` (gauge) | game | Every install ever seen, from the database |

Daily actives for a day are `increase(nakama_custom_active_players[1d])` over
that UTC day; D1 retention is the day's `returning_players{day="d1"}` over
the previous day's `new_players`. Those count players who sign in, which games
only do for online play. Launch pings count everyone whose device is online
when the game starts: daily players are
`increase(nakama_custom_launch_players[1d])`, and all-time players are
`nakama_custom_installs`, which is read from the database at startup because
counters restart at zero. `os` is a fixed list of systems and distributions
(every snap reports `ubuntu_core`, its base), and `os_version` keeps 16 values
per game and OS before the rest become `other`. Label values come only from the game
registry and fixed lists (a game's 65th distinct version since the server
started becomes `other`),
so a client can't create unlimited series. The exporter rewrites label values
to letters, digits and `_`, so `graveyard-hollow` shows as `graveyard_hollow`
and `0.1.0` as `0_1_0`. Counters start at zero on every restart, which
`increase()` handles.

Game modules count their own events with
`Telemetry.count(nk, Telemetry.METRIC.<NAME>, {tags})`. Add new names to the
`METRIC` table in `telemetry.ts`, and always pass the same tag keys for a
name: Prometheus refuses a second set (a unit test checks this).

### Grafana Cloud

The free tier is plenty for one server. Install
[Grafana Alloy](https://grafana.com/docs/alloy/latest/set-up/install/linux/)
from Grafana's apt repository, copy
[`deploy/grafana/config.alloy`](../deploy/grafana/config.alloy) to
`/etc/alloy/config.alloy` and fill in your stack's Prometheus and Loki URLs
and user ids. Put an access policy token with `metrics:write` and
`logs:write` in `/etc/alloy/grafana-cloud-token` (mode 640, group `alloy`),
then `sudo systemctl enable --now alloy`. It ships Nakama's metrics, machine
stats (for the Linux Server integration's dashboards) and the system journal,
with Nakama's and Caddy's log level as a label.

Import [`deploy/grafana/game-telemetry.json`](../deploy/grafana/game-telemetry.json)
(Dashboards, New, Import) for players, retention, rooms and feature use.

## Docker Compose instead

`deploy/compose/` runs the same server with the official Nakama and PostgreSQL
images. It is what CI and local development use, and a starting point for
anyone hosting on a non-Ubuntu machine. See the comments in
[compose.yaml](../deploy/compose/compose.yaml); copy `.env.example` to `.env`
and set real secrets before exposing it.
