// Custom DEM overlay: adds a locally-authored elevation delta on top of the
// base (DEM + geoid) grid, per request, before any mesh or raster encoding.
//
// Why a *delta* and not absolute heights: the grid this hooks into is already
// in ellipsoid heights (orthometric DEM + geoid undulation). A delta is a
// difference, so it carries no vertical datum and can be added directly. An
// absolute custom DEM would first need to declare whether it is orthometric
// or ellipsoidal — exactly the tens-of-meters trap this service exists to
// avoid. `add` is therefore the only mode implemented; `max` / `replace` need
// a datum declaration in the index and are deliberately left out.
//
// Layout in R2:
//   custom/{scenario}/index.json     manifest (bbox + options per COG)
//   custom/{scenario}/*.tif          float32 COGs holding the deltas
//
// The manifest's revision is folded into the tile cache key by the caller, so
// rewriting index.json rotates cached tiles without an explicit purge.
//
// Locally this is the Miniflare R2 bucket that `wrangler dev` provides —
// see scripts/upload-local-r2.sh. No separate filesystem backend exists.

import { openCog } from "./cog.js";
import { lonLatBoundsToPixelWindow, type LonLatBounds } from "./tile.js";

/** R2 key prefix for custom DEM scenarios. Sits alongside sources/, cache/, mirror/. */
const CUSTOM_PREFIX = "custom";

/**
 * How long a parsed manifest is trusted inside one isolate, by default.
 *
 * The cache exists to avoid an R2 GET per tile request. It also puts a floor on
 * how quickly an edit becomes visible, so an authoring loop wants it short or
 * off — see `loadCustomDem`'s `ttlMs`.
 */
const DEFAULT_INDEX_TTL_MS = 60_000;

/**
 * Upper bound on how many source pixels we decode per COG per tile. The
 * window is resampled down to this before we sample it, which keeps a
 * low-zoom request over a large COG from decoding hundreds of MB into a
 * 128 MB Worker (the failure mode `sampleGeoid` hit with the geoid base
 * level). Output grids are 65² (mesh) or 512² (raster), so 2048 per side
 * is far more resolution than any consumer can use.
 */
const MAX_READ_SIDE = 2048;

const M_PER_DEG_LAT = 111_320;

/** Scenario names land in R2 keys and cache paths — keep them boring. */
const SCENARIO_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidScenario(name: string): boolean {
  return SCENARIO_RE.test(name);
}

/**
 * Resolve the manifest cache TTL for this request.
 *
 * `0` disables the cache, so an edit published to R2 is visible on the very
 * next tile request. `.dev.vars` sets that locally: the authoring loop is
 * write-then-look, and a minute of staleness reads as a broken tool.
 * `DISABLE_CACHE` implies it too — that flag already means "show me what the
 * code and data produce right now".
 */
export function indexTtlMs(env: {
  CUSTOM_DEM_INDEX_TTL_MS?: string;
  DISABLE_CACHE?: string;
}): number {
  const disable = env.DISABLE_CACHE;
  if (disable === "1" || disable?.toLowerCase() === "true") return 0;
  const raw = env.CUSTOM_DEM_INDEX_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_INDEX_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INDEX_TTL_MS;
}

/**
 * Cache-key fragment identifying the active scenario *and* its manifest
 * revision. Appended to `encoding`, which already flows into the L1 path,
 * the L2 R2 key, and the ETag — so rewriting index.json rotates every cache
 * layer with no explicit purge, exactly like a tileset `version` bump.
 *
 * Empty string when no custom DEM applies, so base tiles keep sharing their
 * existing keys and stay byte-stable with upstream.
 */
export function customCacheVariant(
  scenario: string | null,
  custom: ResolvedCustomDem | null,
): string {
  if (!custom || !scenario) return "";
  // Revisions can be an R2 ETag; keep only path-safe characters.
  const rev = custom.revision.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32) || "x";
  return `+s-${scenario}@${rev}`;
}

export interface CustomDemEntry {
  /** R2 key of a float32 COG holding elevation deltas in meters. */
  key: string;
  /** Coarse extent `[west, south, east, north]`, used to skip non-overlapping tiles. */
  bounds: [number, number, number, number];
  /**
   * Width in meters of the taper that eases the delta to zero at the COG's
   * edge. Without it the delta steps from (say) +5 m to 0 m across one grid
   * cell and the terrain shows a wall at the edit boundary. 0 disables it.
   */
  featherMeters?: number;
}

export interface CustomDemManifest {
  /**
   * Optional author-managed revision. When absent the R2 ETag of index.json
   * is used, so the cache still rotates on every edit without bookkeeping.
   */
  version?: string;
  entries: CustomDemEntry[];
}

export interface ResolvedCustomDem {
  /** Folded into the tile cache key by the caller. */
  revision: string;
  entries: CustomDemEntry[];
}

/**
 * Load and validate `custom/{scenario}/index.json`.
 *
 * Returns null when the scenario has no manifest, the manifest is unusable,
 * or it declares no entries — all of which mean "serve the base terrain",
 * so the caller leaves the cache key untouched and shares base tiles.
 */
export async function loadCustomDem(
  bucket: R2Bucket | undefined,
  scenario: string | null,
  ttlMs = DEFAULT_INDEX_TTL_MS,
): Promise<ResolvedCustomDem | null> {
  if (!bucket || !scenario || !isValidScenario(scenario)) return null;

  const cached = ttlMs > 0 ? readCache(bucket, scenario, ttlMs) : undefined;
  if (cached !== undefined) return cached;

  const resolved = await fetchManifest(bucket, scenario);
  if (ttlMs > 0) writeCache(bucket, scenario, resolved);
  return resolved;
}

async function fetchManifest(
  bucket: R2Bucket,
  scenario: string,
): Promise<ResolvedCustomDem | null> {
  const key = `${CUSTOM_PREFIX}/${scenario}/index.json`;
  const obj = await bucket.get(key);
  if (!obj) return null;

  let manifest: CustomDemManifest;
  try {
    manifest = JSON.parse(await obj.text()) as CustomDemManifest;
  } catch (err) {
    // A malformed manifest must not take terrain down — an editing scenario
    // is additive, so degrading to base terrain is the safe direction.
    console.log(`custom-dem: bad manifest ${key}: ${String(err)}`);
    return null;
  }

  const entries = normalizeEntries(manifest.entries, scenario);
  if (entries.length === 0) return null;

  return { revision: manifest.version ?? obj.etag, entries };
}

/** Drop entries we cannot use rather than failing the whole scenario. */
function normalizeEntries(raw: unknown, scenario: string): CustomDemEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomDemEntry[] = [];
  for (const e of raw as CustomDemEntry[]) {
    if (!e || typeof e.key !== "string" || !e.key) continue;
    if (!Array.isArray(e.bounds) || e.bounds.length !== 4) continue;
    if (!e.bounds.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const [west, south, east, north] = e.bounds;
    if (east <= west || north <= south) continue;
    // Keys are joined onto the scenario prefix unless already absolute, so a
    // manifest cannot reach into sources/ or cache/.
    const key = e.key.startsWith(`${CUSTOM_PREFIX}/`)
      ? e.key
      : `${CUSTOM_PREFIX}/${scenario}/${e.key}`;
    const feather = typeof e.featherMeters === "number" && e.featherMeters > 0
      ? e.featherMeters
      : 0;
    out.push({ key, bounds: [west, south, east, north], featherMeters: feather });
  }
  return out;
}

// --- manifest cache (per isolate, per bucket) ---

interface CacheEntry {
  at: number;
  value: ResolvedCustomDem | null;
}

const manifestCache = new WeakMap<R2Bucket, Map<string, CacheEntry>>();

/** `undefined` = not cached; `null` = cached "no custom DEM". */
function readCache(
  bucket: R2Bucket,
  scenario: string,
  ttlMs: number,
): ResolvedCustomDem | null | undefined {
  const hit = manifestCache.get(bucket)?.get(scenario);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) return undefined;
  return hit.value;
}

function writeCache(bucket: R2Bucket, scenario: string, value: ResolvedCustomDem | null): void {
  let byScenario = manifestCache.get(bucket);
  if (!byScenario) {
    byScenario = new Map();
    manifestCache.set(bucket, byScenario);
  }
  byScenario.set(scenario, { at: Date.now(), value });
}

// --- sampling ---

/**
 * True when any entry's coarse bounds overlap `bounds` — i.e. this tile is
 * one the custom DEM actually touches, not just "the scenario has some
 * custom DEM somewhere". Callers that scope a decision to "edited tiles"
 * (e.g. the mesh simplification error budget) must use this, not a bare
 * `custom !== null` check.
 */
export function entryOverlapsTile(custom: ResolvedCustomDem, bounds: LonLatBounds): boolean {
  return custom.entries.some((e) => intersects(e.bounds, bounds));
}

/**
 * Sample the summed delta for `bounds` onto a `size`×`size` grid.
 *
 * Grid layout matches `sampleGrid` / `readTileSamples`: row-major,
 * north-to-south, west-to-east, positions linear in lon/lat.
 *
 * Returns null when no entry overlaps, so callers can skip the add entirely.
 */
export async function sampleCustomDelta(
  bucket: R2Bucket,
  custom: ResolvedCustomDem,
  bounds: LonLatBounds,
  size: number,
): Promise<Float64Array | null> {
  const overlapping = custom.entries.filter((e) => intersects(e.bounds, bounds));
  if (overlapping.length === 0) return null;

  const out = new Float64Array(size * size);
  let contributed = false;

  // Sequential on purpose: each entry decodes a raster window, and a Worker
  // has 128 MB. Overlapping edits on one tile are the rare case.
  for (const entry of overlapping) {
    const added = await addEntryDelta(bucket, entry, bounds, size, out);
    contributed = contributed || added;
  }

  return contributed ? out : null;
}

/**
 * Sample the summed delta at arbitrary points. Sister to
 * `sampleCustomDelta`, matching how `sample.ts` mirrors `sampleGrid`.
 *
 * Returns one value per point (0 where nothing applies), or null when no
 * entry covers any point at all.
 */
export async function sampleCustomDeltaAtPoints(
  bucket: R2Bucket,
  custom: ResolvedCustomDem,
  points: { lon: number; lat: number }[],
): Promise<Float64Array | null> {
  if (points.length === 0) return null;

  const out = new Float64Array(points.length);
  let contributed = false;

  for (const entry of custom.entries) {
    const [ew, es, ee, en] = entry.bounds;
    const inside = points
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.lon >= ew && p.lon <= ee && p.lat >= es && p.lat <= en);
    if (inside.length === 0) continue;

    let image: Awaited<ReturnType<typeof openCog>>["image"];
    try {
      ({ image } = await openCog(bucket, entry.key));
    } catch (err) {
      console.log(`custom-dem: cannot open ${entry.key}: ${String(err)}`);
      continue;
    }

    const bbox = image.getBoundingBox();
    const imgWest = Math.min(bbox[0]!, bbox[2]!);
    const imgEast = Math.max(bbox[0]!, bbox[2]!);
    const imgSouth = Math.min(bbox[1]!, bbox[3]!);
    const imgNorth = Math.max(bbox[1]!, bbox[3]!);

    const origin = image.getOrigin();
    const res = image.getResolution();
    const width = image.getWidth();
    const height = image.getHeight();
    const nodata = image.getGDALNoData();
    const feather = entry.featherMeters ?? 0;

    await Promise.all(
      inside.map(async ({ p, i }) => {
        const w = featherWeight(p.lon, p.lat, imgWest, imgSouth, imgEast, imgNorth, feather);
        if (w <= 0) return;
        const px = (p.lon - origin[0]!) / res[0]!;
        const py = (p.lat - origin[1]!) / res[1]!;
        if (px < 0 || px > width || py < 0 || py > height) return;

        // Read the 2x2 neighbourhood only — same approach `sample.ts` uses
        // for the geoid, and geotiff.js caches decoded tiles across calls.
        const x0 = Math.max(0, Math.min(width - 2, Math.floor(px)));
        const y0 = Math.max(0, Math.min(height - 2, Math.floor(py)));
        let band: ArrayLike<number>;
        try {
          const rasters = await image.readRasters({
            window: [x0, y0, x0 + 2, y0 + 2],
            width: 2,
            height: 2,
            interleave: false,
            samples: [0],
          });
          const first = Array.isArray(rasters) ? rasters[0] : rasters;
          if (!first) return;
          band = first as ArrayLike<number>;
        } catch (err) {
          console.log(`custom-dem: point read failed ${entry.key}: ${String(err)}`);
          return;
        }

        const raw = bilinear(band, 2, 2, px - x0, py - y0, nodata);
        if (raw === 0) return;
        out[i] = out[i]! + raw * w;
        contributed = true;
      }),
    );
  }

  return contributed ? out : null;
}

/** True when two lon/lat boxes share area. */
function intersects(b: [number, number, number, number], t: LonLatBounds): boolean {
  const [west, south, east, north] = b;
  return west < t.east && east > t.west && south < t.north && north > t.south;
}

/** Accumulate one COG's feathered delta into `out`. Returns false if it read nothing. */
async function addEntryDelta(
  bucket: R2Bucket,
  entry: CustomDemEntry,
  bounds: LonLatBounds,
  size: number,
  out: Float64Array,
): Promise<boolean> {
  let tiff: Awaited<ReturnType<typeof openCog>>["tiff"];
  let image: Awaited<ReturnType<typeof openCog>>["image"];
  try {
    ({ tiff, image } = await openCog(bucket, entry.key));
  } catch (err) {
    console.log(`custom-dem: cannot open ${entry.key}: ${String(err)}`);
    return false;
  }

  // The COG's own georeferencing is the authority for where the delta
  // applies and where it tapers. `entry.bounds` is only the cheap filter.
  const bbox = image.getBoundingBox();
  const imgWest = Math.min(bbox[0]!, bbox[2]!);
  const imgEast = Math.max(bbox[0]!, bbox[2]!);
  const imgSouth = Math.min(bbox[1]!, bbox[3]!);
  const imgNorth = Math.max(bbox[1]!, bbox[3]!);

  const window = lonLatBoundsToPixelWindow(image, bounds);
  if (window.right <= window.left || window.bottom <= window.top) return false;

  const winW = window.right - window.left;
  const winH = window.bottom - window.top;
  const rw = Math.max(2, Math.min(winW, MAX_READ_SIDE));
  const rh = Math.max(2, Math.min(winH, MAX_READ_SIDE));

  let band: ArrayLike<number>;
  try {
    const rasters = await tiff.readRasters({
      window: [window.left, window.top, window.right, window.bottom],
      width: rw,
      height: rh,
      interleave: false,
      samples: [0],
    });
    const first = Array.isArray(rasters) ? rasters[0] : rasters;
    if (!first) return false;
    band = first as ArrayLike<number>;
  } catch (err) {
    console.log(`custom-dem: read failed ${entry.key}: ${String(err)}`);
    return false;
  }

  // Geographic extent of the window we actually decoded. `lonLatBoundsToPixelWindow`
  // clamps to the image, so this is the intersection — not the requested tile.
  const origin = image.getOrigin();
  const res = image.getResolution();
  const lonA = origin[0]! + window.left * res[0]!;
  const lonB = origin[0]! + window.right * res[0]!;
  const latA = origin[1]! + window.top * res[1]!;
  const latB = origin[1]! + window.bottom * res[1]!;
  const winWest = Math.min(lonA, lonB);
  const winEast = Math.max(lonA, lonB);
  const winSouth = Math.min(latA, latB);
  const winNorth = Math.max(latA, latB);
  if (winEast <= winWest || winNorth <= winSouth) return false;

  const nodata = image.getGDALNoData();
  const feather = entry.featherMeters ?? 0;

  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  const denom = size > 1 ? size - 1 : 1;

  let contributed = false;
  for (let j = 0; j < size; j++) {
    const lat = bounds.north - (j / denom) * latSpan;
    // Outside the decoded window there is no delta — leaving `out` at 0 is
    // what makes a 500 m COG stay 500 m wide instead of being stretched
    // across the whole tile.
    if (lat < winSouth || lat > winNorth) continue;
    const v = ((winNorth - lat) / (winNorth - winSouth)) * (rh - 1);

    for (let i = 0; i < size; i++) {
      const lon = bounds.west + (i / denom) * lonSpan;
      if (lon < winWest || lon > winEast) continue;
      const u = ((lon - winWest) / (winEast - winWest)) * (rw - 1);

      const raw = bilinear(band, rw, rh, u, v, nodata);
      if (raw === 0) continue;

      const w = featherWeight(lon, lat, imgWest, imgSouth, imgEast, imgNorth, feather);
      if (w <= 0) continue;

      out[j * size + i] = out[j * size + i]! + raw * w;
      contributed = true;
    }
  }

  return contributed;
}

/**
 * Bilinear sample with nodata treated as "no delta here" (0). Sampling
 * across a nodata edge blends toward 0, which is the behaviour we want:
 * the edit fades out rather than stepping.
 */
function bilinear(
  band: ArrayLike<number>,
  w: number,
  h: number,
  u: number,
  v: number,
  nodata: number | null,
): number {
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(u)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(v)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;

  const a = clean(band[y0 * w + x0], nodata);
  const b = clean(band[y0 * w + x1], nodata);
  const c = clean(band[y1 * w + x0], nodata);
  const d = clean(band[y1 * w + x1], nodata);

  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

function clean(v: number | undefined, nodata: number | null): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  if (nodata !== null && v === nodata) return 0;
  return v;
}

/**
 * Smooth 0→1 taper over `feather` meters inward from the COG's edge.
 *
 * Returns 0 outside the extent and 1 when `feather` is 0 (hard edge — fine
 * when the COG itself already carries a zero margin around the edit).
 */
export function featherWeight(
  lon: number,
  lat: number,
  west: number,
  south: number,
  east: number,
  north: number,
  feather: number,
): number {
  if (lon < west || lon > east || lat < south || lat > north) return 0;
  if (feather <= 0) return 1;

  // Local flat-earth conversion. At the scale a feather operates on (tens of
  // meters) the error is irrelevant, and it avoids pulling in a projection.
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const dWest = (lon - west) * mPerDegLon;
  const dEast = (east - lon) * mPerDegLon;
  const dSouth = (lat - south) * M_PER_DEG_LAT;
  const dNorth = (north - lat) * M_PER_DEG_LAT;

  const d = Math.min(dWest, dEast, dSouth, dNorth);
  if (d <= 0) return 0;
  if (d >= feather) return 1;
  const t = d / feather;
  return t * t * (3 - 2 * t); // smoothstep
}
