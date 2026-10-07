#!/bin/bash
# Helpers for .github/workflows/release.yml (and for trying it locally).
#
#   tools/release.sh next-version            # vYYYY.WW.MINOR for a release made now
#                                            # (RELEASE_DATE=2026-10-12 to pretend it's another day)
#   tools/release.sh notes TAG [HIGHLIGHTS]  # release notes for TAG at HEAD, as Markdown
#
# Versions are explained in tools/version.sh. The notes lead with the Snap
# Store, which is how people should run the server; the source archives
# GitHub attaches are for developers.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_TAGS='v[0-9][0-9][0-9][0-9].*'

snap_name() { sed -n 's/^name: *//p' snap/snapcraft.yaml | head -1; }
game_title() { sed -n 's/^title: *//p' snap/snapcraft.yaml | head -1; }
repo_url() {
	if [ -n "${GITHUB_REPOSITORY:-}" ]; then
		echo "${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY"
	else
		git remote get-url origin | sed -e 's#^git@github.com:#https://github.com/#' -e 's#\.git$##'
	fi
}

# The newest release tag before HEAD, or nothing before the first release.
previous_tag() { git describe --tags --abbrev=0 --match "$VERSION_TAGS" HEAD 2>/dev/null || true; }

# This week's first release is .0; each later one that week adds 1. Weeks run
# Sunday to Saturday (UTC), numbered like ISO weeks: a Sunday belongs to the
# ISO week of the Monday after it (see tools/version.sh).
next_version() {
	local when year week minor last
	when="${RELEASE_DATE:-now} + 1 day"
	year=$(date -u -d "$when" +%G)
	week=$(date -u -d "$when" +%V | sed 's/^0//')
	last=$(git tag --list "v$year.$week.*" | sed "s/^v$year\.$week\.//" | grep -E '^[0-9]+$' | sort -n | tail -1 || true)
	if [ -z "$last" ]; then minor=0; else minor=$((last + 1)); fi
	echo "v$year.$week.$minor"
}

notes() {
	local tag=$1 highlights=${2:-} snap title url prev range count
	snap=$(snap_name)
	title=$(game_title)
	url=$(repo_url)
	prev=$(previous_tag)
	cat <<EOF
## Get the $title

**[Get the $title from the Snap Store](https://snapcraft.io/$snap)**. That's the way to install and run it: it bundles Nakama, PostgreSQL and Caddy, backs up the database before every update, and keeps itself up to date.

[![Get it from the Snap Store](https://snapcraft.io/static/images/badges/en/snap-store-black.svg)](https://snapcraft.io/$snap)

This release goes to the **candidate** channel first, and to stable once it has been tried. To run it now:

\`\`\`sh
sudo snap install $snap --candidate     # a new server
sudo snap refresh $snap --candidate     # update a server
\`\`\`

Setting it up, updates, backups and monitoring are in the [operations guide]($url/blob/main/docs/operations.md).

EOF
	if [ -n "$highlights" ]; then
		printf '%s\n\n' "$highlights"
	fi
	if [ -n "$prev" ]; then
		range="$prev..HEAD"
		count=$(git rev-list --count --no-merges "$range")
		echo "## What's changed since $prev"
	else
		range="HEAD"
		count=$(git rev-list --count --no-merges "$range")
		echo "## What's in the first release"
	fi
	echo
	if [ "$count" = 0 ]; then
		echo "No changes since $prev; this release re-publishes it."
	else
		# Commit subjects say what changed; link each one.
		git log -n 100 --no-merges --format="- %s ([%h]($url/commit/%H))" "$range"
		if [ "$count" -gt 100 ]; then
			echo "- ...and $((count - 100)) more."
		fi
	fi
	echo
	if [ -n "$prev" ]; then
		echo "**All changes:** [$prev...$tag]($url/compare/$prev...$tag)"
		echo
	fi
	echo "The source code archives below are for building the server yourself, or running it with Docker Compose for development. To run a server, [get the snap](https://snapcraft.io/$snap)."
}

case "${1:-}" in
	next-version) next_version ;;
	notes) shift; notes "$@" ;;
	*) echo "usage: $0 next-version | notes TAG [HIGHLIGHTS]" >&2; exit 2 ;;
esac
