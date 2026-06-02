//! WASM bindings that expose the [`terrain_codec`] crate to the
//! Re:Earth Terrain Cloudflare Worker. All heavy lifting (heightmap
//! codecs, RTIN meshing, seamless normals) lives in the upstream crate
//! — this file is just a thin wasm-bindgen surface that matches what
//! the TypeScript side calls.

use image::ImageEncoder;
use terrain_codec::heightmap::container::{
    decode_image, rgb_to_png as container_rgb_to_png, rgb_to_webp as container_rgb_to_webp,
};
use terrain_codec::heightmap::{self, HeightmapFormat};
use terrain_codec::martini::Martini;
use terrain_codec::normals::{BufferedElevations, buffered_gradient_normals, face_normals};
use terrain_codec::quantized_mesh::{
    EdgeIndices, EncodeOptions, QUANTIZED_MAX, QuantizedMeshEncoder, QuantizedMeshHeader,
    QuantizedVertices, TileBounds, WaterMask,
};
use wasm_bindgen::prelude::*;

/// Grid size used by `encode_quantized_mesh`. Must match
/// `MESH_GRID_SIZE` on the TypeScript side.
const MESH_GRID_SIZE: u32 = 65;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

// ---------- Cesium quantized-mesh-1.0 ----------

/// Generate a gzipped Cesium quantized-mesh-1.0 tile from elevation data.
///
/// `elevations` is a row-major 65x65 grid (north-to-south, west-to-east),
/// values in meters above the WGS84 ellipsoid. `west / south / east / north`
/// are the tile's geodetic bounds in degrees. `max_error` is the Martini
/// simplification threshold in meters — lower means more triangles.
///
/// Optional extensions:
/// * `include_normals` - emit per-vertex oct-encoded normals for lighting.
/// * `water_mask` - empty slice = no watermask; 1 byte = uniform mask
///   (0 = all land, 255 = all water); 65536 bytes = 256x256 grid mask.
/// * `halo_elevations` / `halo_cells` - when non-empty, normals are
///   computed from the DEM gradient on this halo-extended grid (size
///   `(65 + 2*halo_cells)²`) instead of from face-normal accumulation.
///   Empty slice / `halo_cells = 0` falls back to the legacy face-normal
///   path.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn encode_quantized_mesh(
    elevations: &[f64],
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    max_error: f64,
    compression_level: u32,
    include_normals: bool,
    water_mask: &[u8],
    // Taken by-value so wasm-bindgen hands us ownership of the Vec it
    // already allocated to receive the JS Float64Array — we hand that
    // straight to `BufferedElevations::new` without an extra `.to_vec()`.
    halo_elevations: Vec<f64>,
    halo_cells: u32,
) -> Vec<u8> {
    let bounds = TileBounds::new(west, south, east, north);
    let grid_size = MESH_GRID_SIZE as usize;
    assert!(
        elevations.len() >= grid_size * grid_size,
        "encode_quantized_mesh: expected at least {} elevation values, got {}",
        grid_size * grid_size,
        elevations.len()
    );

    let water_mask = match water_mask.len() {
        0 => None,
        1 => Some(WaterMask::Uniform(water_mask[0])),
        len if len == 256 * 256 => Some(WaterMask::from_data(water_mask)),
        _ => None, // malformed — drop the extension
    };
    let include_water_mask = water_mask.is_some();

    let buffered = if include_normals && halo_cells > 0 && !halo_elevations.is_empty() {
        let side = grid_size + 2 * halo_cells as usize;
        if halo_elevations.len() == side * side {
            Some(BufferedElevations::new(
                halo_elevations,
                MESH_GRID_SIZE,
                halo_cells,
            ))
        } else {
            None
        }
    } else {
        None
    };

    let (min_height, max_height) = find_height_range(elevations);

    // Build the RTIN mesh via Martini.
    //
    // Martini measures error purely as a height delta (|interpolated −
    // actual| at each edge midpoint), so a height field that is flat — open
    // ocean, where DEM is 0 and the geoid varies only gently — yields zero
    // error everywhere and collapses to just the 4 corner vertices. Cesium
    // then renders that tile as a single flat quad whose straight ECEF chords
    // cut *under* the round ellipsoid: at low zoom a tile spans tens of
    // degrees, so the facet deviates from the globe by hundreds of km and
    // reads as a flat sheet / spike when the whole Earth is in view.
    //
    // We don't want Martini to know about ellipsoids, so we add the local
    // ellipsoid "bulge" (how far the curved surface rises above the flat
    // bilinear interpolation of the tile corners) to the height field used
    // for *error estimation only*. That forces enough subdivision for the
    // mesh to track the curve. The chosen vertices are still emitted with
    // their true heights below (the `construct_mesh` transform reads the
    // original `elevations`), and `find_height_range` already ran on the
    // true values — so the bulge changes tessellation density, never output
    // heights.
    let mut martini = Martini::new(MESH_GRID_SIZE);
    let tile = martini.create_terrain(|x, y| {
        let idx = y * grid_size + x;
        let h = elevations.get(idx).copied().unwrap_or(0.0);
        let h = if h.is_nan() { 0.0 } else { h };
        h + curvature_bulge(x, y, grid_size, &bounds)
    });
    let (vertices_flat, indices, _uvs) =
        tile.construct_mesh(&mut martini, max_error, &mut |(u, v)| {
            let lon = bounds.west + u * (bounds.east - bounds.west);
            let lat = bounds.south + v * (bounds.north - bounds.south);
            let px = (u * (grid_size - 1) as f64).round() as usize;
            let py = ((1.0 - v) * (grid_size - 1) as f64).round() as usize;
            let idx = py.min(grid_size - 1) * grid_size + px.min(grid_size - 1);
            let height = elevations.get(idx).copied().unwrap_or(0.0);
            let height = if height.is_nan() { 0.0 } else { height };
            (lon, lat, height)
        });

    // Quantize to (u, v, h) ∈ [0, 32767].
    let vertex_count = vertices_flat.len() / 3;
    let mut vertices = QuantizedVertices::with_capacity(vertex_count);
    for i in 0..vertex_count {
        let lon = vertices_flat[i * 3] as f64;
        let lat = vertices_flat[i * 3 + 1] as f64;
        let h = vertices_flat[i * 3 + 2] as f64;
        vertices.push(
            quantize(lon, bounds.west, bounds.east),
            quantize(lat, bounds.south, bounds.north),
            quantize(h, min_height, max_height),
        );
    }

    let edge_indices = EdgeIndices::from_vertices(&vertices);

    // Tight horizon-occlusion point: stream the actual mesh vertices
    // straight from the flat Vec<f32> so Cesium doesn't false-cull
    // tiles near the bounding sphere's equator. The iter API avoids
    // materialising an intermediate Vec<[f64; 3]>.
    let header = QuantizedMeshHeader::from_bounds_with_vertices_iter(
        &bounds,
        min_height as f32,
        max_height as f32,
        vertices_flat
            .chunks_exact(3)
            .map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]),
    );

    let normals = if include_normals {
        Some(match &buffered {
            Some(b) => buffered_gradient_normals(&vertices, &bounds, b),
            None => face_normals(&vertices, &indices, &bounds, min_height, max_height),
        })
    } else {
        None
    };

    let encoder = QuantizedMeshEncoder::new(header, vertices, indices, edge_indices);
    encoder.encode_with_options(&EncodeOptions {
        include_normals,
        normals,
        include_water_mask,
        water_mask,
        include_metadata: false,
        metadata: None,
        compression_level,
    })
}

/// Radial deviation (meters) of the WGS84 ellipsoid surface above the flat
/// bilinear interpolation of the tile's four corners, evaluated at grid cell
/// `(x, y)`. Added to the height field that drives Martini's error pyramid so
/// nearly-flat tiles still tessellate enough to track the globe's curvature
/// (see `encode_quantized_mesh`).
///
/// Derivation: along one geodesic edge spanning angle `Δ`, the arc rises above
/// its chord by `R·(cos((t−½)Δ) − cos(Δ/2))`, which for the small `Δ` of a
/// tile is `≈ R·(Δ²/2)·t·(1−t)` — zero at the corners, peaking at the center.
/// Because Martini's interpolation is exact for affine fields, only this
/// non-linear `t·(1−t)` term contributes error, so it is precisely the signal
/// that controls subdivision. Longitude and latitude separate; longitude span
/// is scaled by `cos(lat)` for meridian convergence. The term shrinks with the
/// square of the tile span, so it forces dense meshes at low zoom (few, large
/// tiles) and fades to nothing at high zoom (negligible curvature per tile).
fn curvature_bulge(x: usize, y: usize, grid_size: usize, bounds: &TileBounds) -> f64 {
    // WGS84 mean radius. Sub-meter accuracy here is irrelevant — this only
    // scales an error threshold, never an emitted height.
    const EARTH_RADIUS_M: f64 = 6_371_008.8;
    let n = (grid_size - 1).max(1) as f64;
    let u = x as f64 / n;
    let v = y as f64 / n;
    let dlon = (bounds.east - bounds.west).to_radians();
    let dlat = (bounds.north - bounds.south).to_radians();
    let mid_lat = ((bounds.south + bounds.north) * 0.5).to_radians();
    let dlon_eff = dlon * mid_lat.cos();
    0.5 * EARTH_RADIUS_M
        * (dlat * dlat * v * (1.0 - v) + dlon_eff * dlon_eff * u * (1.0 - u))
}

fn find_height_range(elevations: &[f64]) -> (f64, f64) {
    let mut min_height = f64::MAX;
    let mut max_height = f64::MIN;
    for &h in elevations {
        if !h.is_nan() {
            min_height = min_height.min(h);
            max_height = max_height.max(h);
        }
    }
    if min_height > max_height {
        min_height = 0.0;
        max_height = 0.0;
    }
    if (max_height - min_height).abs() < 1e-6 {
        max_height = min_height + 1.0;
    }
    (min_height, max_height)
}

#[inline]
fn quantize(value: f64, min: f64, max: f64) -> u16 {
    let t = (value - min) / (max - min);
    (t.clamp(0.0, 1.0) * QUANTIZED_MAX as f64).round() as u16
}

// ---------- Heightmap RGB codecs ----------

/// Encode elevation values (meters) as Terrarium-style RGB bytes.
#[wasm_bindgen]
pub fn encode_terrarium(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    heightmap::encode(HeightmapFormat::Terrarium, elevations, width, height)
}

/// Encode elevation values as Mapbox Terrain-RGB.
#[wasm_bindgen]
pub fn encode_mapbox(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    heightmap::encode(HeightmapFormat::Mapbox, elevations, width, height)
}

// ---------- Image container encoders ----------

#[wasm_bindgen]
pub fn rgb_to_webp(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    container_rgb_to_webp(rgb, width, height)
        .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))
}

#[wasm_bindgen]
pub fn rgb_to_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    container_rgb_to_png(rgb, width, height)
        .map_err(|e| JsError::new(&format!("png encode failed: {e}")))
}

#[wasm_bindgen]
pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    assert_rgba_len(rgba, width, height)?;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| JsError::new(&format!("png encode failed: {e}")))?;
    Ok(out)
}

#[wasm_bindgen]
pub fn rgba_to_webp(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    assert_rgba_len(rgba, width, height)?;
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))?;
    Ok(out)
}

fn assert_rgba_len(rgba: &[u8], width: u32, height: u32) -> Result<(), JsError> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(JsError::new(&format!(
            "rgba length {} does not match {}x{}x4 = {}",
            rgba.len(),
            width,
            height,
            expected
        )));
    }
    Ok(())
}

// ---------- Terrarium image decoders ----------

#[wasm_bindgen]
pub struct DecodedTile {
    width: u32,
    height: u32,
    elevations: Vec<f32>,
}

#[wasm_bindgen]
impl DecodedTile {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Consumes the struct; wasm-bindgen converts to a Float32Array.
    #[wasm_bindgen(getter)]
    pub fn elevations(self) -> Vec<f32> {
        self.elevations
    }
}

#[wasm_bindgen]
pub fn decode_terrarium_webp(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    decode_terrarium_image(bytes)
}

#[wasm_bindgen]
pub fn decode_terrarium_png(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    decode_terrarium_image(bytes)
}

fn decode_terrarium_image(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    let decoded =
        decode_image(bytes).map_err(|e| JsError::new(&format!("image decode failed: {e}")))?;
    let elevations = heightmap::decode(
        HeightmapFormat::Terrarium,
        &decoded.rgb,
        decoded.width,
        decoded.height,
    );
    Ok(DecodedTile {
        width: decoded.width,
        height: decoded.height,
        elevations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: usize = MESH_GRID_SIZE as usize;

    /// Geodetic (Cesium TMS) bounds for a tile, mirroring `geodeticTileBounds`
    /// on the TypeScript side.
    fn geodetic_bounds(z: u32, x: u32, y: u32) -> TileBounds {
        let lon_step = 360.0 / f64::from(1u32 << (z + 1));
        let lat_step = 180.0 / f64::from(1u32 << z);
        let west = -180.0 + f64::from(x) * lon_step;
        let south = -90.0 + f64::from(y) * lat_step;
        TileBounds::new(west, south, west + lon_step, south + lat_step)
    }

    /// Number of triangles Martini emits for a perfectly flat tile, with the
    /// curvature bulge folded into the error grid exactly as the encoder does.
    fn flat_tile_triangle_count(bounds: &TileBounds, max_error: f64) -> usize {
        let mut martini = Martini::new(MESH_GRID_SIZE);
        let tile = martini.create_terrain(|x, y| curvature_bulge(x, y, N, bounds));
        let (_, indices, _) =
            tile.construct_mesh(&mut martini, max_error, &mut |(u, v)| (u, v, 0.0));
        indices.len() / 3
    }

    #[test]
    fn curvature_bulge_is_zero_on_the_border_and_peaks_at_center() {
        let b = geodetic_bounds(2, 7, 1);
        // Only the four corners sit exactly on the interpolation plane → zero.
        assert_eq!(curvature_bulge(0, 0, N, &b), 0.0);
        assert_eq!(curvature_bulge(N - 1, 0, N, &b), 0.0);
        assert_eq!(curvature_bulge(0, N - 1, N, &b), 0.0);
        assert_eq!(curvature_bulge(N - 1, N - 1, N, &b), 0.0);
        // Edge midpoints lie on an arc (a meridian / parallel) and so still
        // bulge above the corner-to-corner chord — those edges need to bend
        // around the globe too.
        assert!(curvature_bulge(N / 2, 0, N, &b) > 0.0);
        assert!(curvature_bulge(0, N / 2, N, &b) > 0.0);
        // The center bulges the most — more than any edge midpoint.
        let center = curvature_bulge(N / 2, N / 2, N, &b);
        assert!(center > curvature_bulge(N / 2, 0, N, &b));
        assert!(center > curvature_bulge(N / 4, N / 4, N, &b));
        // z2 tile spans 45°; the center should rise hundreds of km above the
        // flat chord — the very deviation that produced the visible facets.
        assert!(center > 100_000.0, "expected huge low-zoom bulge, got {center}");
    }

    #[test]
    fn curvature_bulge_shrinks_with_the_square_of_the_tile_span() {
        // Halving the zoom step roughly quarters the angular span and so the
        // bulge: z2 center should be ~4x the z3 center at the same place.
        let c2 = curvature_bulge(N / 2, N / 2, N, &geodetic_bounds(2, 7, 1));
        let c3 = curvature_bulge(N / 2, N / 2, N, &geodetic_bounds(3, 15, 3));
        let ratio = c2 / c3;
        assert!((3.0..5.0).contains(&ratio), "expected ~4x falloff, got {ratio}");
    }

    #[test]
    fn flat_low_zoom_ocean_tile_is_subdivided_not_a_bare_quad() {
        // Regression: before the bulge, a flat tile collapsed to 2 triangles
        // (4 corners) and rendered as a flat sheet cutting through the globe.
        let b = geodetic_bounds(2, 0, 1); // open South Pacific, all ocean
        let tris = flat_tile_triangle_count(&b, meshMaxErrorForZoom(2));
        assert!(tris > 2, "low-zoom flat tile must tessellate, got {tris} tris");
    }

    #[test]
    fn flat_high_zoom_tile_stays_cheap() {
        // At z14 the per-tile curvature is sub-meter, so the bulge must not
        // force needless subdivision: a flat tile should stay a bare quad.
        let b = geodetic_bounds(14, 0, 0);
        let tris = flat_tile_triangle_count(&b, meshMaxErrorForZoom(14));
        assert_eq!(tris, 2, "high-zoom flat tile should stay minimal");
    }

    // Mirror of `meshMaxErrorForZoom` (TypeScript) so the tests exercise the
    // same per-zoom thresholds the worker passes to `encode_quantized_mesh`.
    #[allow(non_snake_case)]
    fn meshMaxErrorForZoom(z: u32) -> f64 {
        (1000.0 / f64::from(1u32 << z)).max(1.0)
    }
}
