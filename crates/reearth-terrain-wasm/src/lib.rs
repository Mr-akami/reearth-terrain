//! WASM bindings that expose the [`terrain_codec`] crate to the
//! Re:Earth Terrain Cloudflare Worker. All heavy lifting (heightmap
//! codecs, RTIN meshing, seamless normals) lives in the upstream crate
//! — this file is just a thin wasm-bindgen surface that matches what
//! the TypeScript side calls.

use terrain_codec::heightmap::container::{
    decode_image, rgb_to_png as container_rgb_to_png, rgb_to_webp as container_rgb_to_webp,
    rgba_to_png as container_rgba_to_png, rgba_to_webp as container_rgba_to_webp,
};
use terrain_codec::heightmap::{self, HeightmapFormat};
use terrain_codec::normals::BufferedElevations;
use terrain_codec::quantized_mesh::{TileBounds, WaterMask};
use terrain_codec::terrain::{NormalMode, TerrainOptions, encode_terrain_from_fn};
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

    // Seam-free DEM-gradient normals need the neighbour halo; without it (or
    // when normals aren't requested) fall back to per-tile face normals / none.
    let normals = if include_normals {
        let side = grid_size + 2 * halo_cells as usize;
        if halo_cells > 0 && halo_elevations.len() == side * side {
            NormalMode::BufferedGradient(BufferedElevations::new(
                halo_elevations,
                MESH_GRID_SIZE,
                halo_cells,
            ))
        } else {
            NormalMode::FaceNormals
        }
    } else {
        NormalMode::None
    };

    // `encode_terrain` runs Martini + quantize + header + normals + encode, and
    // always folds the WGS84 curvature bulge into the error pyramid (never into
    // emitted heights) so nearly-flat low-zoom tiles still tessellate enough to
    // track the globe instead of collapsing to a quad that cuts under it.
    let options = TerrainOptions {
        max_error,
        compression_level,
        normals,
        water_mask,
        metadata: None,
    };

    // Row-major north→south grid; NaN ("no data") is sanitised to 0 so it never
    // poisons the mesh. The closure feeds both the error pyramid and the stored
    // heights — the bulge is added internally to the former only.
    encode_terrain_from_fn(
        MESH_GRID_SIZE,
        &bounds,
        |x, y| {
            let idx = y as usize * grid_size + x as usize;
            let h = elevations.get(idx).copied().unwrap_or(0.0);
            if h.is_nan() { 0.0 } else { h }
        },
        &options,
    )
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
    // Validate up front so a bad length surfaces as a JsError instead of the
    // panic (= wasm abort) that the underlying container encoder would raise.
    assert_rgba_len(rgba, width, height)?;
    container_rgba_to_png(rgba, width, height)
        .map_err(|e| JsError::new(&format!("png encode failed: {e}")))
}

#[wasm_bindgen]
pub fn rgba_to_webp(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    assert_rgba_len(rgba, width, height)?;
    container_rgba_to_webp(rgba, width, height)
        .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))
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
    use terrain_codec::quantized_mesh::DecodedMesh;

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

    /// Triangle count of a perfectly flat tile, encoded through the real
    /// `encode_quantized_mesh` path (no normals / watermask) and decoded back.
    /// This exercises the curvature bulge that `terrain-codec`'s `encode_terrain`
    /// folds into the error pyramid.
    fn flat_tile_triangle_count(bounds: &TileBounds, max_error: f64) -> usize {
        let elevations = vec![0.0f64; N * N];
        let bytes = encode_quantized_mesh(
            &elevations,
            bounds.west,
            bounds.south,
            bounds.east,
            bounds.north,
            max_error,
            0,          // raw bytes — match the worker
            false,      // no normals
            &[],        // no watermask
            Vec::new(), // no halo
            0,
        );
        let mesh = DecodedMesh::decode(&bytes).expect("decode");
        mesh.indices.len() / 3
    }

    #[test]
    fn flat_low_zoom_ocean_tile_is_subdivided_not_a_bare_quad() {
        // Regression: before the curvature bulge, a flat tile collapsed to 2
        // triangles (4 corners) and rendered as a flat sheet cutting through
        // the globe. The bulge (now in terrain-codec) must still subdivide it.
        let b = geodetic_bounds(2, 0, 1); // open South Pacific, all ocean
        let tris = flat_tile_triangle_count(&b, meshMaxErrorForZoom(2));
        assert!(
            tris > 2,
            "low-zoom flat tile must tessellate, got {tris} tris"
        );
    }

    #[test]
    fn flat_high_zoom_tile_stays_cheap() {
        // At z14 the per-tile curvature is sub-meter, so the bulge must not
        // force needless subdivision: a flat tile should stay a bare quad.
        let b = geodetic_bounds(14, 0, 0);
        let tris = flat_tile_triangle_count(&b, meshMaxErrorForZoom(14));
        assert_eq!(tris, 2, "high-zoom flat tile should stay minimal");
    }

    #[test]
    fn flat_tile_emits_flat_heights() {
        // The curvature bulge feeds error estimation only — emitted heights
        // for a flat tile must stay flat (never polluted by the bulge).
        let b = geodetic_bounds(2, 0, 1);
        let elevations = vec![0.0f64; N * N];
        let bytes = encode_quantized_mesh(
            &elevations,
            b.west,
            b.south,
            b.east,
            b.north,
            meshMaxErrorForZoom(2),
            0,
            false,
            &[],
            Vec::new(),
            0,
        );
        let mesh = DecodedMesh::decode(&bytes).expect("decode");
        assert_eq!(mesh.header.min_height, 0.0);
        assert_eq!(mesh.header.max_height, 0.0);
        assert!(mesh.vertices.height.iter().all(|&h| h == 0));
    }

    // Mirror of `meshMaxErrorForZoom` (TypeScript) so the tests exercise the
    // same per-zoom thresholds the worker passes to `encode_quantized_mesh`.
    #[allow(non_snake_case)]
    fn meshMaxErrorForZoom(z: u32) -> f64 {
        (1000.0 / f64::from(1u32 << z)).max(1.0)
    }
}
