#!/usr/bin/env bash
# Deploy a CI-built, attested StreamVault image on the Pi. Nothing is built here.
# Run it from the production worktree (a detached checkout with the .env that
# pins COMPOSE_PROJECT_NAME and COMPOSE_FILE).
#
#   scripts/deploy-pi.sh [REF]           deploy REF (default origin/main) after fetching
#   scripts/deploy-pi.sh --wait [REF]    wait for CI to publish the image first
#   scripts/deploy-pi.sh --rollback [TAG]  put a rollback image back (default: newest)
#
# Options:
#   --wait          wait up to $WAIT_MINUTES (default 45) for ghcr.io/...:sha-<commit>
#   --skip-verify   do not verify the build provenance attestation (not recommended)
#   --force         deploy/roll back even while a recording is active or the API is down
#   -h, --help      show this help
#
# Steps: fetch → resolve REF → wait for and resolve ghcr.io/christopherklint97/streamvault:sha-<commit>
# → gh attestation verify (fail closed) → refuse while a recording is active → pull by digest
# → tag the running image streamvault-server:rollback-<stamp> (keeps 5) → tag the new image
# streamvault-server:latest → check out the commit → docker compose up -d --no-build --pull never
# → wait for /api/health and confirm the container runs the new image.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_IMAGE=ghcr.io/christopherklint97/streamvault
GH_REPO=christopherklint97/streamvault
LOCAL_REPO=streamvault-server
LOCAL=$LOCAL_REPO:latest
CONTAINER=streamvault-server
API=http://127.0.0.1:3002
KEEP_ROLLBACKS=5
WAIT_MINUTES=${WAIT_MINUTES:-45}
HEALTH_SECONDS=${HEALTH_SECONDS:-600} # compose start_period is 10m
SOON_SECONDS=${SOON_SECONDS:-600} # refuse when a scheduled recording starts this soon
GH=${GH:-gh}

# Compose resolves `image:` from this; the shell value wins over .env. Production
# keeps its existing local image name so rollback tags and volumes stay as they are.
export STREAMVAULT_IMAGE=$LOCAL

wait_ci=0 verify=1 force=0 rollback="" target=""
while [ $# -gt 0 ]; do
	case "$1" in
	--wait) wait_ci=1 ;;
	--skip-verify) verify=0 ;;
	--force) force=1 ;;
	--rollback)
		rollback=latest-rollback
		case "${2:-}" in "" | -*) ;; *) rollback=$2; shift ;; esac
		;;
	-h | --help) sed -n '2,22p' "$0"; exit 0 ;;
	-*) echo "unknown option: $1" >&2; exit 2 ;;
	*) [ -z "$target" ] || { echo "only one REF allowed" >&2; exit 2; }; target=$1 ;;
	esac
	shift
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mdeploy: %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight: right checkout, right compose project, right image name -----------------
[ -f .env ] || die ".env missing: run this from the production worktree"
grep -q '^COMPOSE_PROJECT_NAME=' .env || die ".env does not pin COMPOSE_PROJECT_NAME; refusing to risk a second stack"
git diff --quiet HEAD -- || die "tracked files have local changes"

compose_project() {
	docker compose config --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["name"])'
}
project=$(compose_project) || die "docker compose config failed"
running_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null || true)
if [ -n "$running_project" ] && [ "$running_project" != "$project" ]; then
	die "compose project '$project' does not match the running container's '$running_project'"
fi

container_image() { docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }

# --- recording guard ----------------------------------------------------------------------
# GET /api/recordings?status=S&limit=N&offset=M (server/src/index.ts) returns
# {"recordings":[{"id","title","status","start_time","end_time",...}]}, times in epoch ms.
# Status "recording" or "finalizing" means ffmpeg is still writing that recording; a
# "scheduled" one starting within SOON_SECONDS would also be interrupted by the restart.
# With STREAMVAULT_AUTH_TOKEN set the API needs X-StreamVault-Token; it is read from the
# running container and handed to Python through the environment, never argv or output.
RECORDING_CHECK=$(cat <<'PY'
import json, os, sys, time, urllib.request

api, token, soon = os.environ["API"], os.environ.get("TOKEN", ""), int(os.environ["SOON_SECONDS"])

def get(status, offset=0):
    req = urllib.request.Request(f"{api}/api/recordings?status={status}&limit=200&offset={offset}")
    if token:
        req.add_header("X-StreamVault-Token", token)
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)["recordings"]

try:
    busy = [r for s in ("recording", "finalizing") for r in get(s)]
    now = time.time() * 1000
    offset = 0
    while offset <= 5000:
        page = get("scheduled", offset)
        busy += [r for r in page if r["start_time"] <= now + soon * 1000 and r["end_time"] > now]
        if len(page) < 200:
            break
        offset += 200
except Exception as error:  # unreachable, unhealthy, 401, unexpected shape
    print(f"cannot read {api}/api/recordings: {type(error).__name__}: {error}", file=sys.stderr)
    sys.exit(2)
for r in busy:
    when = "" if r["status"] != "scheduled" else f" (starts in {max(0, int(r['start_time'] - now) // 1000)}s)"
    print(f"  {r['status']}: {r.get('title') or '?'}{when} [{r['id']}]")
sys.exit(1 if busy else 0)
PY
)

check_recordings() {
	if ! container_running; then
		echo "$CONTAINER is not running; no recording can be active"
		return 0
	fi
	local token status=0
	token=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" |
		sed -n 's/^STREAMVAULT_AUTH_TOKEN=//p' | head -1)
	TOKEN=$token API=$API SOON_SECONDS=$SOON_SECONDS python3 -I -c "$RECORDING_CHECK" || status=$?
	case "$status" in
	0) echo "no active or imminent recordings" ;;
	1)
		[ "$force" = 1 ] || die "refusing to restart the server during a recording; retry later or pass --force"
		echo "warning: --force given; interrupting the recordings above"
		;;
	*)
		[ "$force" = 1 ] || die "cannot check recordings; use --force to deploy anyway"
		echo "warning: --force given; recordings not checked"
		;;
	esac
}

health() {
	local want=$1 body
	say "waiting for $API/api/health (up to ${HEALTH_SECONDS}s)"
	for _ in $(seq 1 $((HEALTH_SECONDS / 3))); do
		if body=$(curl -sf --max-time 3 "$API/api/health") &&
			python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") is True else 1)' <<<"$body" &&
			[ "$(container_image)" = "$want" ]; then
			echo "healthy: $body"
			return 0
		fi
		sleep 3
	done
	docker logs --tail 40 "$CONTAINER" >&2 || true
	return 1
}

up() {
	local images
	images=$(docker compose config --images) || die "docker compose config failed"
	grep -qx "$LOCAL" <<<"$images" || die "compose would not run $LOCAL (got: $(tr '\n' ' ' <<<"$images"))"
	say "docker compose up -d --no-build --pull never (project $project)"
	docker compose up -d --no-build --pull never
}

save_rollback() {
	local running=$1 stamp
	stamp=$(date +%Y%m%d-%H%M%S)
	rollback_tag=rollback-$stamp
	say "rollback tag $LOCAL_REPO:$rollback_tag"
	docker tag "$running" "$LOCAL_REPO:$rollback_tag"
	docker image ls "$LOCAL_REPO" --format '{{.Tag}}' | grep -E '^rollback-[0-9]{8}-[0-9]{6}$' | sort -r |
		tail -n +$((KEEP_ROLLBACKS + 1)) | sed "s/^/$LOCAL_REPO:/" | xargs -r docker image rm >/dev/null || true
}

# --- rollback -----------------------------------------------------------------------------
if [ -n "$rollback" ]; then
	if [ "$rollback" = latest-rollback ]; then
		rollback=$(docker image ls "$LOCAL_REPO" --format '{{.Tag}}' | grep -E '^rollback-[0-9]{8}-[0-9]{6}$' | sort -r | head -1 || true)
		[ -n "$rollback" ] || die "no $LOCAL_REPO:rollback-<stamp> image; pass a tag (docker image ls $LOCAL_REPO)"
	fi
	rollback=${rollback#"$LOCAL_REPO":}
	want=$(docker image inspect -f '{{.Id}}' "$LOCAL_REPO:$rollback" 2>/dev/null) || die "no image $LOCAL_REPO:$rollback"
	check_recordings
	# No new rollback tag here: the image being replaced is still pullable by digest, and
	# a fresh tag would become the "newest" rollback and point back at the bad image.
	# Images from CI carry their commit; restore the matching compose file when we have it.
	rev=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$LOCAL_REPO:$rollback" 2>/dev/null || true)
	if [[ "$rev" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$rev^{commit}" 2>/dev/null; then
		say "checking out $rev (the rolled-back image's commit)"
		git checkout -q --detach "$rev"
	else
		echo "image has no usable revision label; keeping checkout $(git rev-parse --short HEAD)"
	fi
	say "rolling back to $LOCAL_REPO:$rollback"
	docker tag "$LOCAL_REPO:$rollback" "$LOCAL"
	up
	health "$want" || die "rollback is not healthy"
	printf '\033[32mrolled back to %s\033[0m\n' "$LOCAL_REPO:$rollback"
	exit 0
fi

# --- deploy -------------------------------------------------------------------------------
say "git fetch"
git fetch -q --tags origin
target=${target:-origin/main}
sha=$(git rev-parse --verify -q "$target^{commit}") || die "unknown ref: $target"
remote="$REPO_IMAGE:sha-$sha"
say "target $(git log -1 --format='%h %s' "$sha")"

resolve_digest() {
	docker buildx imagetools inspect "$remote" --format '{{json .Manifest}}' 2>/dev/null |
		python3 -I -c 'import json,sys; print(json.load(sys.stdin)["digest"])'
}
if ! digest=$(resolve_digest); then
	if [ "$wait_ci" = 0 ]; then
		echo "No image for ${sha:0:7} yet: CI is still running, failed, or the commit is not on main."
		"$GH" run list --repo "$GH_REPO" --workflow ci.yml --commit "$sha" --limit 1 2>/dev/null || true
		die "retry with --wait, or check the run above"
	fi
	say "waiting up to ${WAIT_MINUTES}m for CI to publish $remote"
	deadline=$((SECONDS + WAIT_MINUTES * 60))
	until digest=$(resolve_digest); do
		[ "$SECONDS" -lt "$deadline" ] || die "timed out waiting for $remote"
		sleep 30
	done
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "bad digest for $remote: $digest"
pinned="$REPO_IMAGE@$digest"
echo "image $pinned"

if [ "$verify" = 1 ]; then
	say "verifying build provenance"
	"$GH" attestation --help >/dev/null 2>&1 ||
		die "'$GH attestation' is unavailable (gh >= 2.49 needed; set GH=/path/to/gh) — or pass --skip-verify"
	# The attestation must be signed by this repo's CI workflow and name this exact commit.
	att=$("$GH" attestation verify "oci://$pinned" --repo "$GH_REPO" \
		--signer-workflow "$GH_REPO/.github/workflows/ci.yml" --format json) ||
		die "attestation verification failed for $pinned"
	SHA=$sha python3 -I -c 'import json,os,sys
results = json.load(sys.stdin)
digests = {r["verificationResult"]["signature"]["certificate"]["sourceRepositoryDigest"] for r in results}
sys.exit(0 if os.environ["SHA"] in digests else "attestation commit %s != %s" % (digests, os.environ["SHA"]))' <<<"$att" ||
		die "attestation does not belong to commit $sha"
	echo "attested by $GH_REPO ci.yml at ${sha:0:7}"
else
	echo "warning: --skip-verify: provenance NOT verified"
fi

check_recordings

say "pull $pinned"
docker pull -q "$pinned"
want=$(docker image inspect -f '{{.Id}}' "$pinned")
running=$(container_image)
if [ "$running" = "$want" ] && [ "$(git rev-parse HEAD)" = "$sha" ]; then
	echo "already running ${sha:0:7}; nothing to do"
	exit 0
fi

rollback_tag=""
if [ -n "$running" ] && [ "$running" != "$want" ]; then save_rollback "$running"; fi
docker tag "$pinned" "$LOCAL"

say "check out ${sha:0:7}"
git checkout -q --detach "$sha"
up

if health "$want"; then
	printf '\033[32mdeployed %s\033[0m\n' "$(git log -1 --format='%h %s')"
	[ -z "$rollback_tag" ] || echo "rollback: scripts/deploy-pi.sh --rollback $rollback_tag"
else
	[ -z "$rollback_tag" ] || echo "rollback: scripts/deploy-pi.sh --rollback $rollback_tag" >&2
	die "new container is not healthy"
fi
