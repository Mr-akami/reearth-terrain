// Region-scoped cache invalidation for quantized-mesh tiles.
//
// A full `Tileset.version` bump (see tilesets.ts) rotates the cache prefix
// for the *entire globe*, regenerating every tile. That's overkill when a
// fix only changes a handful of tiles in one area — e.g. re-meshing the
// open ocean north-east of New Zealand after the ellipsoid-curvature fix.
//
// Instead, each patch below names a geographic box + zoom band. A mesh tile
// whose geodetic bounds intersect a patch (within its zoom range) gets the
// patch `id` folded into its cache version, so its L1/L2/ETag keys all
// rotate and it regenerates on next request — while every tile outside the
// box keeps serving the existing cached bytes untouched.
//
// To invalidate a region: add a patch (or bump the trailing number of an
// existing `id`, e.g. `nzne1` -> `nzne2`, to re-clear the same area after a
// later fix). Patches are cheap to leave in place; they only ever *add* a
// suffix to matching tiles.

import { geodeticTileBounds } from "./cesium.js";

export interface CachePatch {
  /**
   * Token appended to a matching tile's cache version (e.g. `curv-nzne1`).
   * Keep it short and bump a trailing counter to re-clear the same region.
   */
  id: string;
  /** Inclusive Cesium geodetic (TMS) zoom range this patch covers. */
  minZoom: number;
  maxZoom: number;
  /**
   * Geographic box `[west, south, east, north]` in degrees. When
   * `west > east` the box wraps across the antimeridian — e.g.
   * `[150, -55, -150, 0]` covers 150°E eastward through 180° to 150°W.
   */
  bbox: [west: number, south: number, east: number, north: number];
}

/**
 * Active mesh cache invalidations. Empty = no regional overrides (every tile
 * uses the plain tileset version).
 */
export const MESH_CACHE_PATCHES: CachePatch[] = [
  // 2026-06: ellipsoid-curvature fix. Flat open-ocean tiles north-east of
  // New Zealand collapsed to 4-vertex facets that poked through the globe at
  // low zoom. Changing the cache version for this box rotates the L1/L2/ETag
  // keys so the tiles regenerate with the curvature-aware mesh — no manual
  // Cloudflare purge or R2 delete needed. The box wraps the antimeridian
  // (150°E → 180° → 150°W); low zoom only, where the facets were visible.
  { id: "curv-nzne1", minZoom: 0, maxZoom: 6, bbox: [150, -55, -150, 0] },
];

/**
 * Fold any matching patch ids into `base`, producing the per-tile cache
 * version used as the `version` key for a mesh tile. Tiles that match no
 * patch return `base` unchanged (so their cache entries are preserved).
 */
export function meshCacheVersion(
  base: string,
  z: number,
  x: number,
  y: number,
  patches: readonly CachePatch[] = MESH_CACHE_PATCHES,
): string {
  let version = base;
  for (const p of patches) {
    if (z < p.minZoom || z > p.maxZoom) continue;
    if (tileIntersectsBbox(z, x, y, p.bbox)) version += `-${p.id}`;
  }
  return version;
}

/** True when geodetic tile `z/x/y` overlaps `[w, s, e, n]` (w>e wraps 180°). */
export function tileIntersectsBbox(
  z: number,
  x: number,
  y: number,
  [w, s, e, n]: CachePatch["bbox"],
): boolean {
  const b = geodeticTileBounds(z, x, y);
  // Latitude: disjoint when one rect is entirely above the other.
  if (b.north <= s || b.south >= n) return false;
  // Longitude, non-wrapping query box.
  if (w <= e) return b.west < e && b.east > w;
  // Wrapping query box = [w, 180] ∪ [-180, e]; a (non-wrapping) tile hits it
  // if it reaches past `w` to the east or past `e` to the west.
  return b.east > w || b.west < e;
}
