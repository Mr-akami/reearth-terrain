import { describe, it, expect } from "vitest";
import {
  meshCacheVersion,
  tileIntersectsBbox,
  type CachePatch,
} from "./cache-patches.js";

// A patch whose box wraps the antimeridian (NE of New Zealand), low zoom only.
const NZNE: CachePatch[] = [
  { id: "curv-nzne1", minZoom: 0, maxZoom: 6, bbox: [150, -55, -150, 0] },
];

describe("tileIntersectsBbox", () => {
  it("matches tiles touching the box on the east side of 180°", () => {
    // z2/x7/y1 spans (135..180, -45..0) — reaches past 150°E.
    expect(tileIntersectsBbox(2, 7, 1, [150, -55, -150, 0])).toBe(true);
  });

  it("matches tiles on the west side of 180° via the wrap", () => {
    // z2/x0/y1 spans (-180..-135, -45..0) — reaches past 150°W.
    expect(tileIntersectsBbox(2, 0, 1, [150, -55, -150, 0])).toBe(true);
  });

  it("rejects tiles that fall in the gap between the wrapped edges", () => {
    // z2/x6/y1 spans (90..135, -45..0) — east of 135 but well short of 150.
    expect(tileIntersectsBbox(2, 6, 1, [150, -55, -150, 0])).toBe(false);
  });

  it("rejects tiles outside the latitude band", () => {
    // z2/x7/y3 spans (135..180, 45..90) — far north of the box.
    expect(tileIntersectsBbox(2, 7, 3, [150, -55, -150, 0])).toBe(false);
  });

  it("handles a non-wrapping box too", () => {
    // z2/x4/y2 spans (0..45, 0..45); box [10,10,40,40] overlaps it.
    expect(tileIntersectsBbox(2, 4, 2, [10, 10, 40, 40])).toBe(true);
    // A box entirely east of the tile does not.
    expect(tileIntersectsBbox(2, 4, 2, [50, 10, 80, 40])).toBe(false);
  });
});

describe("meshCacheVersion", () => {
  it("appends the patch id to matching tiles", () => {
    expect(meshCacheVersion("5", 2, 7, 1, NZNE)).toBe("5-curv-nzne1");
  });

  it("leaves non-matching tiles on the plain version", () => {
    expect(meshCacheVersion("5", 2, 6, 1, NZNE)).toBe("5");
  });

  it("respects the patch zoom band", () => {
    // Same area but above maxZoom — not invalidated.
    expect(meshCacheVersion("5", 7, 255, 63, NZNE)).toBe("5");
  });

  it("preserves a geoid-suffixed base version", () => {
    expect(meshCacheVersion("5-g2", 2, 7, 1, NZNE)).toBe("5-g2-curv-nzne1");
  });

  it("is a no-op with no patches", () => {
    expect(meshCacheVersion("5", 2, 7, 1, [])).toBe("5");
  });
});
