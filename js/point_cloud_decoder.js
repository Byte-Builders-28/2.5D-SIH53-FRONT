// ============================================================
// Point Cloud Decoder
//
// Responsibility:
//   fetch compressed .bin
//     ↓
//   Zstandard decompress  (via globalThis.fzstd)
//     ↓
//   interpret bytes as Float32 XYZ
//     ↓
//   validate XYZ layout
//     ↓
//   return decoded point-cloud frame
//
// The decoder is intentionally decoupled from:
//   - FrameManager
//   - PointCloudView
//   - Three.js
//
// It knows only about binary data and decompression.
// ============================================================

// Maximum points expected per frame (set by the Python generator).
export const PC_MAX_POINTS = 50_000;

// Frame count emitted by the Python pipeline.
export const PC_FRAME_COUNT = 992;

// Playback frame rate (shared with raster source).
export const PC_FPS = 25;

// Source configuration (matches FrameManager.setSource() API).
export const PC_FRAME_DIRECTORY = "/data/pc";
export const PC_FRAME_PREFIX = "frame_pc_";
export const PC_FRAME_EXTENSION = ".bin";

// ============================================================
// Internal helpers
// ============================================================

/**
 * Decompress a Zstandard frame using fzstd.
 *
 * fzstd.js is loaded as a global script before the module scripts.
 * It exposes globalThis.fzstd.decompress(Uint8Array) -> Uint8Array.
 *
 * @param {Uint8Array} bytes  Raw compressed bytes.
 * @returns {Uint8Array}      Decompressed bytes.
 */
function decompressZstd(bytes) {
	if (
		typeof globalThis.fzstd === "undefined" ||
		typeof globalThis.fzstd.decompress !== "function"
	) {
		throw new Error(
			"PointCloudDecoder: fzstd is not available. " +
				"Ensure fzstd.js is loaded before the module scripts.",
		);
	}

	let result;

	try {
		result = globalThis.fzstd.decompress(bytes);
	} catch (error) {
		throw new Error(
			`PointCloudDecoder: Zstandard decompression failed: ${error.message}`,
			{ cause: error },
		);
	}

	if (!(result instanceof Uint8Array)) {
		result = new Uint8Array(result);
	}

	return result;
}

// ============================================================
// Decoder
// ============================================================

/**
 * Decode a point-cloud .bin frame.
 *
 * @param {ArrayBuffer|Uint8Array} rawData
 *   Raw bytes as returned by fetch().arrayBuffer() or equivalent.
 *
 * @param {object} [options]
 * @param {number} [options.maxPoints=PC_MAX_POINTS]
 *   Hard cap.  If the decoded frame contains more points than this,
 *   an error is thrown instead of silently downsampling.
 *
 * @returns {{
 *   positions: Float32Array,
 *   pointCount: number
 * }}
 *   positions   – flat XYZ buffer, length = pointCount * 3
 *   pointCount  – number of valid points in positions
 */
export function decodePointCloudFrame(
	rawData,
	{ maxPoints = PC_MAX_POINTS } = {},
) {
	// --------------------------------------------------------
	// Normalise input to Uint8Array
	// --------------------------------------------------------

	let bytes;

	if (rawData instanceof ArrayBuffer) {
		bytes = new Uint8Array(rawData);
	} else if (rawData instanceof Uint8Array) {
		bytes = rawData;
	} else {
		throw new TypeError(
			"PointCloudDecoder: rawData must be an ArrayBuffer or Uint8Array",
		);
	}

	// --------------------------------------------------------
	// Zstandard decompression
	// --------------------------------------------------------

	const decompressed = decompressZstd(bytes);

	// --------------------------------------------------------
	// Interpret as Float32
	// --------------------------------------------------------

	// decompressed.buffer may have a byteOffset if it is a sub-view.
	const floatCount = decompressed.byteLength / 4;

	if (!Number.isInteger(floatCount)) {
		throw new Error(
			`PointCloudDecoder: decompressed byte length (${decompressed.byteLength}) ` +
				"is not divisible by 4. File may be corrupt.",
		);
	}

	if (floatCount % 3 !== 0) {
		throw new Error(
			`PointCloudDecoder: float count (${floatCount}) is not divisible by 3. ` +
				"Expected interleaved XYZ layout.",
		);
	}

	const pointCount = floatCount / 3;

	if (pointCount > maxPoints) {
		throw new Error(
			`PointCloudDecoder: frame contains ${pointCount} points which exceeds ` +
				`the configured maximum of ${maxPoints}. ` +
				"Refusing to silently downsample.",
		);
	}

	// Create a properly aligned Float32Array view over the
	// decompressed bytes.  We copy into a fresh buffer to
	// guarantee 4-byte alignment regardless of the fzstd output.
	const positions = new Float32Array(pointCount * 3);

	// Use DataView to be safe against alignment issues.
	const dv = new DataView(
		decompressed.buffer,
		decompressed.byteOffset,
		decompressed.byteLength,
	);

	for (let i = 0; i < pointCount * 3; i++) {
		positions[i] = dv.getFloat32(i * 4, true /* little-endian */);
	}

	return {
		positions,
		pointCount,
	};
}

// ============================================================
// Async fetch + decode convenience wrapper
// ============================================================

/**
 * Fetch a point-cloud .bin file and decode it.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxPoints]
 * @returns {Promise<{ positions: Float32Array, pointCount: number }>}
 */
export async function loadPointCloudFrame(url, options) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(
			`PointCloudDecoder: fetch failed for "${url}": ` +
				`${response.status} ${response.statusText}`,
		);
	}

	const buffer = await response.arrayBuffer();

	return decodePointCloudFrame(buffer, options);
}
