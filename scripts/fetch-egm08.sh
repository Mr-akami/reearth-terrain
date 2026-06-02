#!/usr/bin/env bash
# Download the EGM2008 geoid undulation grid as a Cloud Optimized GeoTIFF
# *with internal overviews*.
#
# Source: PROJ data CDN (Float32, DEFLATE, 256x256 tiled, EPSG:4979). The
# upstream file is a COG but ships WITHOUT overviews — a single 8640x4321
# full-resolution level. That's fine for the high-zoom mesh tiles (small
# windows), but a low-zoom Cesium tile covers a huge lon/lat span: a z0
# tile reads a ~half-globe window (~4320x4321 px ≈ 75 MB of float32) just
# to resample down to a 65x65 grid, which OOMs the 128 MB Worker (Error
# 1102). geotiff.js does not pick overviews on its own, but `sampleGeoid`
# (src/cesium.ts) selects the coarsest level that still resolves the tile —
# so the level pyramid we add here is what bounds the read. Overviews down
# to ~factor 128 mean even a z0 read touches only tens of pixels.
#
# We therefore rebuild the download through the GDAL COG driver, which adds
# the overview pyramid (BILINEAR — the undulation field is smooth) while
# keeping the same CRS, band, compression, and block size. The pixel values
# of the full-resolution level are unchanged, so existing cached tiles stay
# valid; no geoid version bump is required.
#
# Usage:
#   bash scripts/fetch-egm08.sh           # writes data/egm08_cog.tif
#   FORCE=1 bash scripts/fetch-egm08.sh   # re-download + rebuild

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/data"
SRC_URL="https://cdn.proj.org/us_nga_egm08_25.tif"
OUT_FILE="$DATA_DIR/egm08_cog.tif"

FORCE="${FORCE:-0}"

for cmd in curl gdal_translate gdalinfo; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: required command not found: $cmd" >&2
    exit 1
  }
done

mkdir -p "$DATA_DIR"

if [[ -s "$OUT_FILE" && "$FORCE" != "1" ]]; then
  echo "[fetch-egm08] already present: $OUT_FILE (set FORCE=1 to re-download)"
  exit 0
fi

RAW_FILE="$OUT_FILE.raw.tif"
echo "[fetch-egm08] downloading $SRC_URL"
curl -fL --retry 3 --retry-delay 2 -o "$RAW_FILE" "$SRC_URL"

echo "[fetch-egm08] rebuilding as COG with overviews"
gdal_translate "$RAW_FILE" "$OUT_FILE.tmp" \
  -of COG \
  -co COMPRESS=DEFLATE \
  -co PREDICTOR=YES \
  -co BLOCKSIZE=256 \
  -co OVERVIEWS=IGNORE_EXISTING \
  -co OVERVIEW_RESAMPLING=BILINEAR \
  -co RESAMPLING=BILINEAR
mv "$OUT_FILE.tmp" "$OUT_FILE"
rm -f "$RAW_FILE"

echo
echo "[fetch-egm08] done"
ls -la "$OUT_FILE"
echo "[fetch-egm08] overview levels:"
gdalinfo "$OUT_FILE" | grep -iE "size is|overviews" || true
