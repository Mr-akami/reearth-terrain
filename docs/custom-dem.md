# Custom DEM overlay (fork feature)

Serve terrain with a locally-authored elevation change — cut, fill, grading,
a flood scenario — without pre-generating a single tile. The delta is applied
per request, on the sampled grid, just before mesh/raster encoding.

This is a fork-only feature. Upstream `reearth/reearth-terrain` does not have it.

## How it works

```
tile request ──▶ base DEM (Mapterhorn) ──┐
                                          ├──▶ ellipsoid grid ──▶ + custom delta ──▶ encode
                 geoid (EGM2008 COG) ─────┘
```

The delta is added **after** the DEM + geoid sum, i.e. on the ellipsoid-height
grid. That is deliberate: a delta is a *difference*, so it carries no vertical
datum and needs no geoid conversion. An absolute custom DEM would first have to
declare whether it is orthometric or ellipsoidal — the exact tens-of-meters trap
this service exists to remove. Hence `add` is the only mode; `max` and `replace`
would need a datum declaration and are intentionally not implemented.

Both grid paths are covered:

- `cesium-mesh` (quantized-mesh, geodetic TMS) — including the normals halo, so
  lighting stays continuous across an edit boundary
- `terrarium` / `mapbox` (Terrain-RGB, Web Mercator XYZ)

Only `data_type=ellipsoid` is edited. `elevation` and `geoid` stay as pure views
of the upstream data.

## Storage layout

```
custom/{scenario}/index.json     manifest
custom/{scenario}/*.tif          float32 COGs holding deltas in meters
```

`index.json`:

```json
{
  "version": "r3",
  "entries": [
    { "key": "fill-plan-a.tif", "bounds": [139.70, 35.68, 139.71, 35.69], "featherMeters": 20 }
  ]
}
```

| Field | Meaning |
|---|---|
| `version` | Optional. Cache revision. When omitted the manifest's R2 ETag is used. |
| `entries[].key` | COG key. Relative keys are resolved under `custom/{scenario}/`. |
| `entries[].bounds` | `[west, south, east, north]`. Coarse filter only — tiles that don't intersect skip the COG entirely. The COG's own georeferencing is what actually positions the delta. |
| `entries[].featherMeters` | Width of the taper that eases the delta to 0 at the COG edge. Omit or `0` for a hard edge. |

Overlapping entries sum. `nodata` pixels contribute nothing.

### Feathering

Without a taper the delta steps from (say) +5 m to 0 m across one grid cell and
the terrain shows a wall at the edit boundary. `featherMeters` applies a
smoothstep falloff inward from the COG's extent. Set it to 0 only when the COG
already carries a zero-valued margin around the edit.

## Requesting a scenario

```
GET /cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain?scenario=plan-a
GET /terrarium/ellipsoid/{z}/{x}/{y}.png?scenario=plan-a
```

Without `?scenario=` nothing changes — the request is byte-identical to upstream
and shares the same cache entries.

Scenario names are restricted to `A-Z a-z 0-9 . _ -` (max 64); anything else is
a 400.

## Cache invalidation

The scenario name **and** the manifest revision are folded into `encoding`,
which already flows into the L1 (edge) key, the L2 (R2) key, and the ETag. So:

**rewrite `index.json` → every cache layer rotates.** No purge step, no
`version` bump, no stale tiles from a previous edit. Same mechanism as a tileset
`version` bump, just scoped to one scenario.

If you edit a `.tif` in place *without* touching `index.json`, cached tiles will
keep serving. Bump `version` (or just re-put `index.json`) when you do that.

## Local development

`wrangler dev` provides a Miniflare-backed R2 bucket, so this works locally with
the same code path as production — there is no filesystem backend and no MinIO.

```bash
# Author the delta however you like — GDAL, QGIS, rasterio.
gdal_translate -ot Float32 -of COG delta.tif custom-delta.tif

# Upload to the LOCAL Miniflare bucket.
bash scripts/upload-local-r2.sh \
  custom/plan-a/fill-plan-a.tif=custom-delta.tif \
  custom/plan-a/index.json=path/to/index.json

npm run dev
# http://localhost:8787/viewer?scenario=plan-a
```

`REMOTE=1` on the same script targets the production bucket.

Tip: `.dev.vars` with `DISABLE_CACHE=1` skips both cache layers, which is what
you want while iterating on a delta.

## Limits

- Per COG, per tile, at most 2048×2048 source pixels are decoded (the window is
  resampled down first). A Worker has 128 MB; low-zoom reads over a large COG
  would otherwise OOM. Output grids are 65² or 512², so this is not a
  resolution limit in practice.
- Overlapping entries are read sequentially, for the same memory reason.
- Sampling assumes the COG is in EPSG:4326 and north-up, matching the geoid COG
  path. Reproject before uploading.
- Feathering tapers from the COG's rectangular extent, not from the boundary of
  the valid-data region inside it. Irregular edit footprints should carry their
  own zero margin (nodata blends toward 0, so it fades rather than steps).
- A malformed manifest or an unreadable COG degrades to base terrain and logs;
  it does not fail the request.
