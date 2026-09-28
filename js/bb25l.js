/**
 * BB25L V3 Browser Decoder
 *
 * Supports:
 *   - Uncompressed BB25L
 *   - Zstandard-compressed BB25L
 *   - Automatic raw/Zstd detection
 *
 * Dependencies:
 *   - fzstd.js loaded before this file
 *
 * Expected HTML:
 *
 *   <script src="./js/fzstd.js"></script>
 *   <script src="./js/bb25l.js"></script>
 *
 * Usage:
 *
 *   const frame = await BB25L.load("data/raster/frame_0000.bb25l");
 *
 * Result:
 *
 *   {
 *       cellIds: Uint32Array,
 *       data: Uint8Array,
 *       flags: number,
 *       occupiedCellCount: number
 *   }
 *
 * `data` is logically:
 *
 *   [cell0 14 bytes][cell1 14 bytes]...[cellN 14 bytes]
 *
 * It matches the RadialRasterizer output layout.
 *
 * BB25L V3
 * ============================================================
 *
 * Header:
 *
 *   0  - 3   magic       "BB25"
 *   4  - 5   version     uint16
 *   6  - 7   flags       uint16
 *   8  - 11  cell count  uint32
 *
 * Sparse record:
 *
 *   varuint cell-id/delta
 *   uint16 metadata
 *   optional ground   4 bytes
 *   optional static   4 bytes
 *   optional dynamic  4 bytes
 *
 * Logical cell data:
 *
 *   bytes 0-1    ground Z              uint16
 *   byte  2      ground delta min      int8
 *   byte  3      ground delta max      int8
 *   bytes 4-5    static height min     uint16
 *   bytes 6-7    static height max     uint16
 *   bytes 8-9    dynamic height min    uint16
 *   bytes 10-11  dynamic height max    uint16
 *   bytes 12-13  metadata              uint16
 *
 * Metadata:
 *
 *   bit  0      ground present
 *   bit  1      static present
 *   bit  2      dynamic present
 *   bit  3      ground drivable
 *   bits 4-6    ground semantic
 *   bits 7-9    static semantic
 *   bits 10-12  dynamic semantic
 *   bits 13-15  reserved
 */

(() => {
	"use strict";

	// ========================================================
	// Constants
	// ========================================================

	const VERSION = 3;
	const HEADER_SIZE = 12;
	const CELL_DATA_BYTES = 14;

	const GROUND_DATA_BYTES = 4;
	const STATIC_DATA_BYTES = 4;
	const DYNAMIC_DATA_BYTES = 4;
	const METADATA_BYTES = 2;

	const GROUND_PRESENT_BIT = 1 << 0;
	const STATIC_PRESENT_BIT = 1 << 1;
	const DYNAMIC_PRESENT_BIT = 1 << 2;

	const GROUND_DRIVABLE_BIT = 1 << 3;

	const GROUND_SEMANTIC_SHIFT = 4;
	const STATIC_SEMANTIC_SHIFT = 7;
	const DYNAMIC_SEMANTIC_SHIFT = 10;

	const SEMANTIC_MASK = 0x07;

	const MAX_VARINT_BYTES = 5;

	// "BB25" interpreted as little-endian uint32.
	//
	// ASCII:
	//   B = 0x42
	//   B = 0x42
	//   2 = 0x32
	//   5 = 0x35
	//
	// Little-endian uint32:
	//   0x35324242
	//
	const MAGIC = 0x35324242;

	// Zstandard frame magic:
	//   28 B5 2F FD
	const ZSTD_MAGIC_0 = 0x28;
	const ZSTD_MAGIC_1 = 0xb5;
	const ZSTD_MAGIC_2 = 0x2f;
	const ZSTD_MAGIC_3 = 0xfd;

	// ========================================================
	// Input conversion
	// ========================================================

	/**
	 * Convert supported binary inputs to Uint8Array.
	 *
	 * @param {ArrayBuffer|Uint8Array|DataView} input
	 * @returns {Uint8Array}
	 */
	function asUint8Array(input) {
		if (input instanceof Uint8Array) {
			return input;
		}

		if (input instanceof ArrayBuffer) {
			return new Uint8Array(input);
		}

		if (input instanceof DataView) {
			return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
		}

		throw new TypeError(
			"BB25L input must be an ArrayBuffer, Uint8Array, or DataView",
		);
	}

	// ========================================================
	// Magic detection
	// ========================================================

	/**
	 * Check whether bytes contain a BB25L header.
	 *
	 * @param {Uint8Array} bytes
	 * @returns {boolean}
	 */
	function isBB25L(bytes) {
		return (
			bytes.length >= 4 &&
			bytes[0] === 0x42 &&
			bytes[1] === 0x42 &&
			bytes[2] === 0x32 &&
			bytes[3] === 0x35
		);
	}

	/**
	 * Check whether bytes begin with a Zstandard frame.
	 *
	 * @param {Uint8Array} bytes
	 * @returns {boolean}
	 */
	function isZstd(bytes) {
		return (
			bytes.length >= 4 &&
			bytes[0] === ZSTD_MAGIC_0 &&
			bytes[1] === ZSTD_MAGIC_1 &&
			bytes[2] === ZSTD_MAGIC_2 &&
			bytes[3] === ZSTD_MAGIC_3
		);
	}

	// ========================================================
	// Zstandard
	// ========================================================

	/**
	 * Decompress a Zstandard frame.
	 *
	 * fzstd is loaded globally by fzstd.js.
	 *
	 * @param {Uint8Array} bytes
	 * @returns {Uint8Array}
	 */
	function decompressZstd(bytes) {
		if (
			typeof globalThis.fzstd === "undefined" ||
			typeof globalThis.fzstd.decompress !== "function"
		) {
			throw new Error(
				"BB25L: fzstd is not loaded. " + "Load fzstd.js before bb25l.js.",
			);
		}

		try {
			const result = globalThis.fzstd.decompress(bytes);

			if (!(result instanceof Uint8Array)) {
				return new Uint8Array(result);
			}

			return result;
		} catch (error) {
			throw new Error(
				`BB25L: Zstandard decompression failed: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}

	// ========================================================
	// Header
	// ========================================================

	/**
	 * Read BB25L V3 header.
	 *
	 * @param {Uint8Array} bytes
	 * @returns {{
	 *     version: number,
	 *     flags: number,
	 *     occupiedCellCount: number,
	 *     payloadOffset: number
	 * }}
	 */
	function readHeader(bytes) {
		if (bytes.length < HEADER_SIZE) {
			throw new Error(`BB25L: frame too small (${bytes.length} bytes)`);
		}

		if (!isBB25L(bytes)) {
			throw new Error("BB25L: invalid magic. Expected 'BB25'.");
		}

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		const magic = view.getUint32(0, true);

		if (magic !== MAGIC) {
			throw new Error("BB25L: invalid magic.");
		}

		const version = view.getUint16(4, true);

		if (version !== VERSION) {
			throw new Error(
				`BB25L: unsupported version ${version}. ` +
					`Expected version ${VERSION}.`,
			);
		}

		const flags = view.getUint16(6, true);
		const occupiedCellCount = view.getUint32(8, true);

		return {
			version,
			flags,
			occupiedCellCount,
			payloadOffset: HEADER_SIZE,
		};
	}

	// ========================================================
	// Unsigned LEB128
	// ========================================================

	/**
	 * Read unsigned LEB128 / varuint.
	 *
	 * BB25L cell IDs are uint32, therefore at most five bytes
	 * are required.
	 *
	 * @param {Uint8Array} bytes
	 * @param {number} offset
	 * @returns {{
	 *     value: number,
	 *     offset: number
	 * }}
	 */
	function readUVarint(bytes, offset) {
		let value = 0;
		let shift = 0;

		for (let i = 0; i < MAX_VARINT_BYTES; i++) {
			if (offset >= bytes.length) {
				throw new Error("BB25L: truncated cell ID varint.");
			}

			const byte = bytes[offset++];

			value += (byte & 0x7f) * 2 ** shift;

			if ((byte & 0x80) === 0) {
				return {
					value,
					offset,
				};
			}

			shift += 7;
		}

		throw new Error("BB25L: invalid cell ID varint.");
	}

	// ========================================================
	// Raw decoder
	// ========================================================

	/**
	 * Decode an uncompressed BB25L V3 frame.
	 *
	 * @param {ArrayBuffer|Uint8Array|DataView} input
	 *
	 * @returns {{
	 *     cellIds: Uint32Array,
	 *     data: Uint8Array,
	 *     flags: number,
	 *     occupiedCellCount: number
	 * }}
	 */
	function decodeBB25L(input) {
		const bytes = asUint8Array(input);

		const header = readHeader(bytes);

		const count = header.occupiedCellCount;

		const cellIds = new Uint32Array(count);

		// Logical RadialRasterizer-style output:
		//
		//   cell 0 = bytes 0..13
		//   cell 1 = bytes 14..27
		//   ...
		//
		const data = new Uint8Array(count * CELL_DATA_BYTES);

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		let offset = header.payloadOffset;

		let previousCellId = 0;

		for (let i = 0; i < count; i++) {
			// ------------------------------------------------
			// Cell ID
			// ------------------------------------------------

			const idResult = readUVarint(bytes, offset);

			const encodedId = idResult.value;
			offset = idResult.offset;

			let cellId;

			if (i === 0) {
				// First cell ID is absolute.
				cellId = encodedId;
			} else {
				// Remaining IDs are deltas.
				cellId = previousCellId + encodedId;
			}

			if (cellId > 0xffffffff) {
				throw new Error(`BB25L: cell ID exceeds uint32 at cell ${i}.`);
			}

			if (i > 0 && cellId <= previousCellId) {
				throw new Error(
					`BB25L: cell IDs are not strictly increasing at cell ${i}.`,
				);
			}

			cellIds[i] = cellId >>> 0;
			previousCellId = cellId;

			// ------------------------------------------------
			// Metadata
			// ------------------------------------------------

			if (offset + METADATA_BYTES > bytes.length) {
				throw new Error(`BB25L: truncated metadata at cell ${i}.`);
			}

			const metadata = view.getUint16(offset, true);

			offset += METADATA_BYTES;

			const dataOffset = i * CELL_DATA_BYTES;

			// Metadata occupies bytes 12-13.
			data[dataOffset + 12] = metadata & 0xff;
			data[dataOffset + 13] = metadata >>> 8;

			// ------------------------------------------------
			// Presence bits
			// ------------------------------------------------

			const hasGround = (metadata & GROUND_PRESENT_BIT) !== 0;

			const hasStatic = (metadata & STATIC_PRESENT_BIT) !== 0;

			const hasDynamic = (metadata & DYNAMIC_PRESENT_BIT) !== 0;

			// ------------------------------------------------
			// Ground
			// ------------------------------------------------

			if (hasGround) {
				if (offset + GROUND_DATA_BYTES > bytes.length) {
					throw new Error(`BB25L: truncated ground data at cell ${i}.`);
				}

				// Ground Z, uint16, little-endian.
				data[dataOffset + 0] = bytes[offset + 0];
				data[dataOffset + 1] = bytes[offset + 1];

				// Ground delta min/max.
				data[dataOffset + 2] = bytes[offset + 2];
				data[dataOffset + 3] = bytes[offset + 3];

				offset += GROUND_DATA_BYTES;
			}

			// ------------------------------------------------
			// Static
			// ------------------------------------------------

			if (hasStatic) {
				if (offset + STATIC_DATA_BYTES > bytes.length) {
					throw new Error(`BB25L: truncated static data at cell ${i}.`);
				}

				// Static height min, uint16.
				data[dataOffset + 4] = bytes[offset + 0];
				data[dataOffset + 5] = bytes[offset + 1];

				// Static height max, uint16.
				data[dataOffset + 6] = bytes[offset + 2];
				data[dataOffset + 7] = bytes[offset + 3];

				offset += STATIC_DATA_BYTES;
			}

			// ------------------------------------------------
			// Dynamic
			// ------------------------------------------------

			if (hasDynamic) {
				if (offset + DYNAMIC_DATA_BYTES > bytes.length) {
					throw new Error(`BB25L: truncated dynamic data at cell ${i}.`);
				}

				// Dynamic height min, uint16.
				data[dataOffset + 8] = bytes[offset + 0];
				data[dataOffset + 9] = bytes[offset + 1];

				// Dynamic height max, uint16.
				data[dataOffset + 10] = bytes[offset + 2];
				data[dataOffset + 11] = bytes[offset + 3];

				offset += DYNAMIC_DATA_BYTES;
			}
		}

		// There must not be unexplained bytes after the final
		// sparse record.
		if (offset !== bytes.length) {
			throw new Error(
				`BB25L: ${bytes.length - offset} trailing bytes after frame.`,
			);
		}

		return {
			cellIds,
			data,
			flags: header.flags,
			occupiedCellCount: count,
		};
	}

	// ========================================================
	// Automatic decoder
	// ========================================================

	/**
	 * Decode either:
	 *
	 *   raw BB25L
	 *
	 * or:
	 *
	 *   Zstd-compressed BB25L
	 *
	 * @param {ArrayBuffer|Uint8Array|DataView} input
	 *
	 * @returns {{
	 *     cellIds: Uint32Array,
	 *     data: Uint8Array,
	 *     flags: number,
	 *     occupiedCellCount: number
	 * }}
	 */
	function decode(input) {
		const bytes = asUint8Array(input);

		if (isBB25L(bytes)) {
			return decodeBB25L(bytes);
		}

		if (isZstd(bytes)) {
			const decompressed = decompressZstd(bytes);

			if (!isBB25L(decompressed)) {
				throw new Error(
					"BB25L: Zstandard payload does not contain a valid BB25L frame.",
				);
			}

			return decodeBB25L(decompressed);
		}

		throw new Error(
			"BB25L: unknown frame format. " +
				"Expected raw BB25L or Zstandard-compressed BB25L.",
		);
	}

	// ========================================================
	// Fetch helpers
	// ========================================================

	/**
	 * Fetch and decode a BB25L file.
	 *
	 * Automatically handles raw and Zstandard-compressed files.
	 *
	 * @param {string} url
	 * @param {RequestInit} [options]
	 *
	 * @returns {Promise<{
	 *     cellIds: Uint32Array,
	 *     data: Uint8Array,
	 *     flags: number,
	 *     occupiedCellCount: number
	 * }>}
	 */
	async function load(url, options = {}) {
		const response = await fetch(url, options);

		if (!response.ok) {
			throw new Error(
				`BB25L: failed to fetch ${url}: ` +
					`${response.status} ${response.statusText}`,
			);
		}

		const buffer = await response.arrayBuffer();

		return decode(buffer);
	}

	/**
	 * Fetch and decode a raw BB25L file.
	 *
	 * Unlike `load()`, this rejects Zstd-compressed frames.
	 *
	 * @param {string} url
	 *
	 * @returns {Promise<object>}
	 */
	async function loadRaw(url) {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(
				`BB25L: failed to fetch ${url}: ` +
					`${response.status} ${response.statusText}`,
			);
		}

		const buffer = await response.arrayBuffer();

		return decodeBB25L(buffer);
	}

	/**
	 * Fetch and decode a Zstandard-compressed BB25L file.
	 *
	 * @param {string} url
	 *
	 * @returns {Promise<object>}
	 */
	async function loadZstd(url) {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(
				`BB25L: failed to fetch ${url}: ` +
					`${response.status} ${response.statusText}`,
			);
		}

		const buffer = await response.arrayBuffer();
		const bytes = asUint8Array(buffer);

		if (!isZstd(bytes)) {
			throw new Error("BB25L: expected a Zstandard-compressed frame.");
		}

		return decode(bytes);
	}

	// ========================================================
	// Cell data access
	// ========================================================

	/**
	 * Get logical 14-byte cell data.
	 *
	 * @param {object} frame
	 * @param {number} index
	 *
	 * @returns {Uint8Array}
	 */
	function getCellData(frame, index) {
		if (index < 0 || index >= frame.occupiedCellCount) {
			throw new RangeError(`BB25L: cell index ${index} is out of range.`);
		}

		const offset = index * CELL_DATA_BYTES;

		return frame.data.subarray(offset, offset + CELL_DATA_BYTES);
	}

	/**
	 * Find the array index of a cell ID.
	 *
	 * Cell IDs are sorted, so binary search is used.
	 *
	 * @param {object} frame
	 * @param {number} cellId
	 *
	 * @returns {number}
	 *
	 * Returns -1 if the cell is not occupied.
	 */
	function findCell(frame, cellId) {
		let low = 0;
		let high = frame.cellIds.length - 1;

		while (low <= high) {
			const mid = (low + high) >>> 1;
			const value = frame.cellIds[mid];

			if (value === cellId) {
				return mid;
			}

			if (value < cellId) {
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		return -1;
	}

	// ========================================================
	// Metadata helpers
	// ========================================================

	/**
	 * Get metadata from a logical cell.
	 *
	 * @param {object} frame
	 * @param {number} index
	 *
	 * @returns {number}
	 */
	function getMetadata(frame, index) {
		const offset = index * CELL_DATA_BYTES + 12;

		return frame.data[offset] | (frame.data[offset + 1] << 8);
	}

	/**
	 * Test ground presence.
	 *
	 * @param {number} metadata
	 * @returns {boolean}
	 */
	function hasGround(metadata) {
		return (metadata & GROUND_PRESENT_BIT) !== 0;
	}

	/**
	 * Test static presence.
	 *
	 * @param {number} metadata
	 * @returns {boolean}
	 */
	function hasStatic(metadata) {
		return (metadata & STATIC_PRESENT_BIT) !== 0;
	}

	/**
	 * Test dynamic presence.
	 *
	 * @param {number} metadata
	 * @returns {boolean}
	 */
	function hasDynamic(metadata) {
		return (metadata & DYNAMIC_PRESENT_BIT) !== 0;
	}

	/**
	 * Test whether the ground is drivable.
	 *
	 * @param {number} metadata
	 * @returns {boolean}
	 */
	function isGroundDrivable(metadata) {
		return (metadata & GROUND_DRIVABLE_BIT) !== 0;
	}

	/**
	 * Extract ground semantic.
	 *
	 * @param {number} metadata
	 * @returns {number}
	 */
	function getGroundSemantic(metadata) {
		return (metadata >> GROUND_SEMANTIC_SHIFT) & SEMANTIC_MASK;
	}

	/**
	 * Extract static semantic.
	 *
	 * @param {number} metadata
	 * @returns {number}
	 */
	function getStaticSemantic(metadata) {
		return (metadata >> STATIC_SEMANTIC_SHIFT) & SEMANTIC_MASK;
	}

	/**
	 * Extract dynamic semantic.
	 *
	 * @param {number} metadata
	 * @returns {number}
	 */
	function getDynamicSemantic(metadata) {
		return (metadata >> DYNAMIC_SEMANTIC_SHIFT) & SEMANTIC_MASK;
	}

	/**
	 * Decode all metadata fields.
	 *
	 * @param {number} metadata
	 *
	 * @returns {{
	 *     groundPresent: boolean,
	 *     staticPresent: boolean,
	 *     dynamicPresent: boolean,
	 *     groundDrivable: boolean,
	 *     groundSemantic: number,
	 *     staticSemantic: number,
	 *     dynamicSemantic: number
	 * }}
	 */
	function decodeMetadata(metadata) {
		return {
			groundPresent: hasGround(metadata),
			staticPresent: hasStatic(metadata),
			dynamicPresent: hasDynamic(metadata),

			groundDrivable: isGroundDrivable(metadata),

			groundSemantic: getGroundSemantic(metadata),

			staticSemantic: getStaticSemantic(metadata),

			dynamicSemantic: getDynamicSemantic(metadata),
		};
	}

	// ========================================================
	// Cell payload helpers
	// ========================================================

	/**
	 * Read ground Z.
	 *
	 * Stored as uint16 centimeters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getGroundZ(frame, index) {
		const offset = index * CELL_DATA_BYTES;

		return frame.data[offset] | (frame.data[offset + 1] << 8);
	}

	/**
	 * Convert encoded ground Z to meters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getGroundZMeters(frame, index) {
		return getGroundZ(frame, index) * 0.01;
	}

	/**
	 * Get signed int8 from a byte.
	 *
	 * @param {number} value
	 * @returns {number}
	 */
	function signedByte(value) {
		return value & 0x80 ? value - 0x100 : value;
	}

	/**
	 * Get ground delta minimum.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getGroundDeltaMin(frame, index) {
		return signedByte(frame.data[index * CELL_DATA_BYTES + 2]);
	}

	/**
	 * Get ground delta maximum.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getGroundDeltaMax(frame, index) {
		return signedByte(frame.data[index * CELL_DATA_BYTES + 3]);
	}

	/**
	 * Read an unsigned uint16 from logical cell data.
	 *
	 * @param {Uint8Array} data
	 * @param {number} offset
	 * @returns {number}
	 */
	function readUint16(data, offset) {
		return data[offset] | (data[offset + 1] << 8);
	}

	/**
	 * Get static height minimum.
	 *
	 * Stored as uint16 centimeters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getStaticHeightMin(frame, index) {
		const offset = index * CELL_DATA_BYTES + 4;

		return readUint16(frame.data, offset);
	}

	/**
	 * Get static height maximum.
	 *
	 * Stored as uint16 centimeters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getStaticHeightMax(frame, index) {
		const offset = index * CELL_DATA_BYTES + 6;

		return readUint16(frame.data, offset);
	}

	/**
	 * Get dynamic height minimum.
	 *
	 * Stored as uint16 centimeters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getDynamicHeightMin(frame, index) {
		const offset = index * CELL_DATA_BYTES + 8;

		return readUint16(frame.data, offset);
	}

	/**
	 * Get dynamic height maximum.
	 *
	 * Stored as uint16 centimeters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getDynamicHeightMax(frame, index) {
		const offset = index * CELL_DATA_BYTES + 10;

		return readUint16(frame.data, offset);
	}

	/**
	 * Get static height minimum in meters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getStaticHeightMinMeters(frame, index) {
		return getStaticHeightMin(frame, index) * 0.01;
	}

	/**
	 * Get static height maximum in meters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getStaticHeightMaxMeters(frame, index) {
		return getStaticHeightMax(frame, index) * 0.01;
	}

	/**
	 * Get dynamic height minimum in meters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getDynamicHeightMinMeters(frame, index) {
		return getDynamicHeightMin(frame, index) * 0.01;
	}

	/**
	 * Get dynamic height maximum in meters.
	 *
	 * @param {object} frame
	 * @param {number} index
	 * @returns {number}
	 */
	function getDynamicHeightMaxMeters(frame, index) {
		return getDynamicHeightMax(frame, index) * 0.01;
	}

	// ========================================================
	// Utility
	// ========================================================

	/**
	 * Return a compact description of a decoded frame.
	 *
	 * @param {object} frame
	 *
	 * @returns {{
	 *     occupiedCellCount: number,
	 *     byteLength: number,
	 *     flags: number,
	 *     firstCellId: number|null,
	 *     lastCellId: number|null
	 * }}
	 */
	function getStats(frame) {
		return {
			occupiedCellCount: frame.occupiedCellCount,

			byteLength: frame.data.byteLength,

			flags: frame.flags,

			firstCellId: frame.cellIds.length > 0 ? frame.cellIds[0] : null,

			lastCellId:
				frame.cellIds.length > 0
					? frame.cellIds[frame.cellIds.length - 1]
					: null,
		};
	}

	// ========================================================
	// Public API
	// ========================================================

	globalThis.BB25L = Object.freeze({
		VERSION,

		HEADER_SIZE,
		CELL_DATA_BYTES,

		GROUND_DATA_BYTES,
		STATIC_DATA_BYTES,
		DYNAMIC_DATA_BYTES,
		METADATA_BYTES,

		GROUND_PRESENT_BIT,
		STATIC_PRESENT_BIT,
		DYNAMIC_PRESENT_BIT,

		asUint8Array,

		isBB25L,
		isZstd,

		decompressZstd,

		readHeader,
		decodeBB25L,
		decode,

		load,
		loadRaw,
		loadZstd,

		getCellData,
		findCell,

		getMetadata,
		decodeMetadata,

		hasGround,
		hasStatic,
		hasDynamic,
		isGroundDrivable,

		getGroundSemantic,
		getStaticSemantic,
		getDynamicSemantic,

		getGroundZ,
		getGroundZMeters,

		signedByte,

		getGroundDeltaMin,
		getGroundDeltaMax,

		getStaticHeightMin,
		getStaticHeightMax,
		getStaticHeightMinMeters,
		getStaticHeightMaxMeters,

		getDynamicHeightMin,
		getDynamicHeightMax,
		getDynamicHeightMinMeters,
		getDynamicHeightMaxMeters,

		getStats,
	});
})();
