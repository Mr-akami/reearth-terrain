#!/usr/bin/env bash
# Upload data/egm08_cog.tif (and any other files passed as args) into the
# R2 bucket. Targets the local Miniflare bucket used by `wrangler dev` by
# default; set REMOTE=1 to upload to the production bucket instead (needed
# when refreshing the geoid COG, e.g. after adding overviews via
# scripts/fetch-egm08.sh).
#
# Usage:
#   bash scripts/upload-local-r2.sh                    # local: data/egm08_cog.tif -> sources/egm08_cog.tif
#   bash scripts/upload-local-r2.sh path/to/file.tif   # local: upload under its basename
#   bash scripts/upload-local-r2.sh key=path/file.tif  # local: upload under an explicit key
#   REMOTE=1 bash scripts/upload-local-r2.sh           # production bucket (real R2)
#
# For REMOTE=1 you must be logged in (`wrangler login`) to an account with
# write access to the bucket. The account is taken from $CLOUDFLARE_ACCOUNT_ID
# when set, else wrangler's configured/default account.
#
# Bucket name matches `[[r2_buckets]] bucket_name` in wrangler.toml.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUCKET="${BUCKET:-reearth-terrain}"
KEY_PREFIX="${KEY_PREFIX:-sources/}"
REMOTE="${REMOTE:-0}"

# `--local` writes to the Miniflare bucket; `--remote` writes to real R2.
if [[ "$REMOTE" == "1" ]]; then
  LOCATION_FLAG="--remote"
  echo "[upload-local-r2] TARGET: production R2 (--remote)"
else
  LOCATION_FLAG="--local"
fi

cd "$ROOT"

inputs=("$@")
if [[ ${#inputs[@]} -eq 0 ]]; then
  inputs=("data/egm08_cog.tif")
fi

for spec in "${inputs[@]}"; do
  if [[ "$spec" == *"="* ]]; then
    key="${spec%%=*}"
    file="${spec#*=}"
  else
    file="$spec"
    key="${KEY_PREFIX}$(basename "$file")"
  fi

  if [[ ! -s "$file" ]]; then
    echo "error: file not found or empty: $file" >&2
    exit 1
  fi

  echo "[upload-local-r2] $file -> $BUCKET/$key ($LOCATION_FLAG)"
  npx wrangler r2 object put "$BUCKET/$key" \
    --file="$file" \
    --content-type="image/tiff" \
    "$LOCATION_FLAG"
done
