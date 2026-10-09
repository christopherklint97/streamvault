#!/usr/bin/env bash
# Bind-mounted dev dependencies belong to the runner, not the image's node UID.
# Keep production/default-user smoke separate from these source suites.
set -euo pipefail

image="${1:?Usage: bash scripts/test-packaged-source.sh IMAGE [CHECKOUT]}"
checkout="${2:-$PWD}"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:?Set RUNNER_TEMP or TMPDIR to a writable scratch directory}}/streamvault-source-tests.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

container_args=(
  --rm --cpus=1 --memory=768m --pids-limit=256
  --user "$(id -u):$(id -g)"
  -e TMPDIR=/scratch -e HOME=/scratch
  -e NODE_OPTIONS=--max-old-space-size=512 -e GOMAXPROCS=1
  -e PYTHONDONTWRITEBYTECODE=1
  -v "$checkout:/checkout" -v "$scratch:/scratch"
)

nice -n 15 docker run "${container_args[@]}" -w /checkout/server "$image" \
  nice -n 15 npm run test -- --run --no-file-parallelism --maxWorkers=1 --testTimeout=30000
nice -n 15 docker run "${container_args[@]}" -w /checkout/server/src "$image" \
  nice -n 15 /usr/bin/python3 -m unittest -v test_live_packet_worker test_live_packet_stitch
