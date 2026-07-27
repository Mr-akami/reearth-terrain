import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  customCacheVariant,
  featherWeight,
  isValidScenario,
  loadCustomDem,
  sampleCustomDelta,
  type CustomDemManifest,
  type ResolvedCustomDem,
} from "./custom-dem.js";

// --- fixtures -------------------------------------------------------------

/**
 * Build a minimal single-strip, uncompressed, float32 GeoTIFF in EPSG:4326.
 *
 * Written by hand rather than checked in as a binary so the georeferencing
 * under test is visible in the test itself. Only the tags geotiff.js needs
 * for `getOrigin` / `getResolution` / `readRasters` are emitted; tags must be
 * in ascending order.
 */
function makeFloatGeoTiff(opts: {
  width: number;
  height: number;
  /** Top-left corner (pixel edge, not centre). */
  west: number;
  north: number;
  /** Degrees per pixel. */
  pixelSize: number;
  values: Float32Array;
  nodata?: number;
}): Uint8Array {
  const { width, height, west, north, pixelSize, values, nodata } = opts;
  const nodataAscii = nodata === undefined ? null : `${nodata}\0`;

  const TAG_COUNT = nodataAscii ? 13 : 12;
  const ifdOffset = 8;
  const ifdSize = 2 + TAG_COUNT * 12 + 4;
  let cursor = ifdOffset + ifdSize;

  const pixelScaleOffset = cursor;
  cursor += 24; // 3 doubles
  const tiepointOffset = cursor;
  cursor += 48; // 6 doubles
  let nodataOffset = 0;
  if (nodataAscii) {
    nodataOffset = cursor;
    cursor += nodataAscii.length;
  }
  const stripOffset = cursor;
  const stripBytes = width * height * 4;

  const buf = new ArrayBuffer(stripOffset + stripBytes);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Header: little-endian, classic TIFF.
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  const SHORT = 3;
  const LONG = 4;
  const ASCII = 2;
  const DOUBLE = 12;

  const entries: [number, number, number, number][] = [
    [256, LONG, 1, width], // ImageWidth
    [257, LONG, 1, height], // ImageLength
    [258, SHORT, 1, 32], // BitsPerSample
    [259, SHORT, 1, 1], // Compression = none
    [262, SHORT, 1, 1], // PhotometricInterpretation = BlackIsZero
    [273, LONG, 1, stripOffset], // StripOffsets
    [277, SHORT, 1, 1], // SamplesPerPixel
    [278, LONG, 1, height], // RowsPerStrip (single strip)
    [279, LONG, 1, stripBytes], // StripByteCounts
    [339, SHORT, 1, 3], // SampleFormat = IEEE float
    [33550, DOUBLE, 3, pixelScaleOffset], // ModelPixelScale
    [33922, DOUBLE, 6, tiepointOffset], // ModelTiepoint
  ];
  if (nodataAscii) {
    entries.push([42113, ASCII, nodataAscii.length, nodataOffset]); // GDAL_NODATA
  }
  entries.sort((a, b) => a[0] - b[0]);

  view.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    // SHORT values live in the low 2 bytes of the value field; LONG and
    // offsets use all 4.
    if (type === SHORT && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true); // no next IFD

  // ModelPixelScale: (x, y, z). y is positive here; the sign of the north-up
  // orientation comes from the tiepoint + geotiff's convention.
  view.setFloat64(pixelScaleOffset, pixelSize, true);
  view.setFloat64(pixelScaleOffset + 8, pixelSize, true);
  view.setFloat64(pixelScaleOffset + 16, 0, true);

  // ModelTiepoint: raster (0,0,0) -> model (west, north, 0).
  for (let i = 0; i < 3; i++) view.setFloat64(tiepointOffset + i * 8, 0, true);
  view.setFloat64(tiepointOffset + 24, west, true);
  view.setFloat64(tiepointOffset + 32, north, true);
  view.setFloat64(tiepointOffset + 40, 0, true);

  if (nodataAscii) {
    for (let i = 0; i < nodataAscii.length; i++) {
      bytes[nodataOffset + i] = nodataAscii.charCodeAt(i);
    }
  }

  for (let i = 0; i < values.length; i++) {
    view.setFloat32(stripOffset + i * 4, values[i]!, true);
  }

  return bytes;
}

let seq = 0;
/** Unique key per call — `openCog` memoizes by key for the isolate's lifetime. */
function uniqueKey(name: string): string {
  return `custom/test-${name}-${seq++}.tif`;
}

async function putManifest(scenario: string, manifest: CustomDemManifest): Promise<void> {
  await env.R2.put(`custom/${scenario}/index.json`, JSON.stringify(manifest));
}

/** A flat delta COG covering [west, north-size .. ] at `pixelSize` resolution. */
async function putFlatDelta(opts: {
  key: string;
  west: number;
  north: number;
  pixelSize: number;
  side: number;
  value: number;
  nodata?: number;
}): Promise<[number, number, number, number]> {
  const { key, west, north, pixelSize, side, value, nodata } = opts;
  const tiff = makeFloatGeoTiff({
    width: side,
    height: side,
    west,
    north,
    pixelSize,
    values: new Float32Array(side * side).fill(value),
    ...(nodata === undefined ? {} : { nodata }),
  });
  await env.R2.put(key, tiff);
  return [west, north - side * pixelSize, west + side * pixelSize, north];
}

// --- pure helpers ---------------------------------------------------------

describe("isValidScenario", () => {
  it("accepts plain identifiers and rejects anything that could escape a key", () => {
    expect(isValidScenario("plan-A")).toBe(true);
    expect(isValidScenario("flood_2026.rev3")).toBe(true);
    expect(isValidScenario("../sources")).toBe(false);
    expect(isValidScenario("a/b")).toBe(false);
    expect(isValidScenario("")).toBe(false);
  });
});

describe("customCacheVariant", () => {
  const custom: ResolvedCustomDem = { revision: "abc123", entries: [] };

  it("is empty when no custom DEM applies, so base tiles keep their key", () => {
    expect(customCacheVariant(null, null)).toBe("");
    expect(customCacheVariant("plan-A", null)).toBe("");
    expect(customCacheVariant(null, custom)).toBe("");
  });

  it("includes both scenario and revision so an edit rotates the cache", () => {
    expect(customCacheVariant("plan-A", custom)).toBe("+s-plan-A@abc123");
    expect(customCacheVariant("plan-A", { revision: "def456", entries: [] })).toBe(
      "+s-plan-A@def456",
    );
  });
});

describe("featherWeight", () => {
  // 1 degree of latitude ~ 111.32 km, so these boxes are ~111 km on a side.
  const box = { west: 0, south: 0, east: 1, north: 1 };

  it("is 0 outside and at the edge, 1 well inside, partial in the taper", () => {
    expect(featherWeight(-0.1, 0.5, box.west, box.south, box.east, box.north, 100)).toBe(0);
    expect(featherWeight(0, 0.5, box.west, box.south, box.east, box.north, 1000)).toBe(0);
    expect(featherWeight(0.5, 0.5, box.west, box.south, box.east, box.north, 1000)).toBe(1);
    // Feathering off means no taper at all.
    expect(featherWeight(0, 0.5, box.west, box.south, box.east, box.north, 0)).toBe(1);
    const partial = featherWeight(0.004, 0.5, box.west, box.south, box.east, box.north, 1000);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});

// --- manifest loading -----------------------------------------------------

describe("loadCustomDem", () => {
  it("returns null when the scenario has no manifest", async () => {
    expect(await loadCustomDem(env.R2, "missing-scenario")).toBeNull();
  });

  it("degrades to base terrain on malformed JSON instead of throwing", async () => {
    await env.R2.put("custom/bad-json/index.json", "{ not json");
    expect(await loadCustomDem(env.R2, "bad-json")).toBeNull();
  });

  it("keeps good entries, prefixes relative keys, and defaults feather to 0", async () => {
    await putManifest("mixed", {
      entries: [
        { key: "hill.tif", bounds: [0, 0, 1, 1] },
        { key: "bad", bounds: [1, 1, 0, 0] },
        { key: "custom/other/abs.tif", bounds: [2, 2, 3, 3], featherMeters: 25 },
      ],
    });
    const resolved = await loadCustomDem(env.R2, "mixed");
    expect(resolved).not.toBeNull();
    expect(resolved!.entries).toHaveLength(2);
    expect(resolved!.entries[0]!.key).toBe("custom/mixed/hill.tif");
    expect(resolved!.entries[0]!.featherMeters).toBe(0);
    // Already-prefixed keys are left alone.
    expect(resolved!.entries[1]!.key).toBe("custom/other/abs.tif");
    expect(resolved!.entries[1]!.featherMeters).toBe(25);
  });

  it("uses the R2 ETag as the revision when the manifest declares none", async () => {
    await putManifest("etag-rev", { entries: [{ key: "a.tif", bounds: [0, 0, 1, 1] }] });
    const resolved = await loadCustomDem(env.R2, "etag-rev");
    expect(resolved!.revision).toBeTruthy();
    const head = await env.R2.head("custom/etag-rev/index.json");
    expect(resolved!.revision).toBe(head!.etag);
  });
});

// --- sampling -------------------------------------------------------------

describe("sampleCustomDelta", () => {
  it("returns null when no entry overlaps the requested bounds", async () => {
    const custom: ResolvedCustomDem = {
      revision: "r1",
      entries: [{ key: uniqueKey("far"), bounds: [100, 30, 101, 31], featherMeters: 0 }],
    };
    const out = await sampleCustomDelta(
      env.R2,
      custom,
      { west: 0, south: 0, east: 1, north: 1 },
      8,
    );
    // No COG was even opened — the bbox filter short-circuits.
    expect(out).toBeNull();
  });

  it("applies a flat delta over the whole grid when the COG covers the tile", async () => {
    const key = uniqueKey("cover");
    // COG spans 0..1 in both axes; the tile we ask for sits inside it.
    const bounds = await putFlatDelta({
      key,
      west: 0,
      north: 1,
      pixelSize: 1 / 16,
      side: 16,
      value: 5,
    });
    const custom: ResolvedCustomDem = {
      revision: "r1",
      entries: [{ key, bounds, featherMeters: 0 }],
    };

    const size = 8;
    const out = await sampleCustomDelta(
      env.R2,
      custom,
      { west: 0.25, south: 0.25, east: 0.75, north: 0.75 },
      size,
    );
    expect(out).not.toBeNull();
    for (let i = 0; i < size * size; i++) expect(out![i]).toBeCloseTo(5, 4);
  });

  it("confines the delta to the COG's footprint instead of stretching it across the tile", async () => {
    // This is the failure mode `readTileFromImage` would have produced: it
    // clamps the pixel window to the image and then resamples that window to
    // the full output size, so a small COG would smear over the whole tile.
    const key = uniqueKey("partial");
    // COG covers only the WEST HALF of the tile below (0..0.5 of 0..1).
    const bounds = await putFlatDelta({
      key,
      west: 0,
      north: 1,
      pixelSize: 0.5 / 16,
      side: 16,
      value: 10,
    });
    expect(bounds[2]).toBeCloseTo(0.5, 9);

    const custom: ResolvedCustomDem = {
      revision: "r1",
      entries: [{ key, bounds, featherMeters: 0 }],
    };

    const size = 9; // odd, so i=4 is exactly the midpoint (lon 0.5)
    const out = await sampleCustomDelta(
      env.R2,
      custom,
      { west: 0, south: 0.5, east: 1, north: 1 },
      size,
    );
    expect(out).not.toBeNull();

    const row = 0;
    // West half carries the delta.
    expect(out![row * size + 0]).toBeCloseTo(10, 4);
    expect(out![row * size + 3]).toBeCloseTo(10, 4);
    // East half is untouched — the whole point of this test.
    expect(out![row * size + 5]).toBe(0);
    expect(out![row * size + 8]).toBe(0);
  });

  it("feathers the delta to zero at the COG boundary", async () => {
    const key = uniqueKey("feather");
    const bounds = await putFlatDelta({
      key,
      west: 0,
      north: 1,
      pixelSize: 1 / 32,
      side: 32,
      value: 8,
    });
    // ~1 degree spans ~111 km; feather over 20 km so a coarse grid can see it.
    const custom: ResolvedCustomDem = {
      revision: "r1",
      entries: [{ key, bounds, featherMeters: 20_000 }],
    };

    const size = 9;
    const out = await sampleCustomDelta(
      env.R2,
      custom,
      { west: 0, south: 0, east: 1, north: 1 },
      size,
    );
    expect(out).not.toBeNull();

    const mid = Math.floor(size / 2);
    // Centre keeps the full delta.
    expect(out![mid * size + mid]).toBeCloseTo(8, 3);
    // The boundary column is exactly zero, and the next one in is partial.
    expect(out![mid * size + 0]).toBe(0);
    const nextIn = out![mid * size + 1]!;
    expect(nextIn).toBeGreaterThan(0);
    expect(nextIn).toBeLessThan(8);
  });

  it("treats nodata as no delta", async () => {
    const key = uniqueKey("nodata");
    const side = 8;
    const values = new Float32Array(side * side).fill(-9999);
    const tiff = makeFloatGeoTiff({
      width: side,
      height: side,
      west: 0,
      north: 1,
      pixelSize: 1 / side,
      values,
      nodata: -9999,
    });
    await env.R2.put(key, tiff);

    const custom: ResolvedCustomDem = {
      revision: "r1",
      entries: [{ key, bounds: [0, 0, 1, 1], featherMeters: 0 }],
    };
    const out = await sampleCustomDelta(
      env.R2,
      custom,
      { west: 0.1, south: 0.1, east: 0.9, north: 0.9 },
      4,
    );
    // Every sample was nodata, so nothing contributed at all.
    expect(out).toBeNull();
  });
});
