// ============================================================
// Frame Manager
// ============================================================

const BB25L = globalThis.BB25L;

// ============================================================
// Frame Manager
// ============================================================

export class FrameManager {
	constructor() {
		this.sources = new Map();
		this.activeSource = null;
	}

	// ========================================================
	// Source Management
	// ========================================================

	setSource(name, config) {
		if (!name) {
			throw new Error("FrameManager source name is required");
		}

		const {
			frameCount,
			frameDirectory,
			framePrefix = "",
			frameExtension = "",
			bufferSize = 4,
		} = config;

		if (!Number.isInteger(frameCount) || frameCount <= 0) {
			throw new Error(`Invalid frameCount for source "${name}": ${frameCount}`);
		}

		if (!frameDirectory) {
			throw new Error(`Missing frameDirectory for source "${name}"`);
		}

		if (typeof framePrefix !== "string") {
			throw new Error(`Invalid framePrefix for source "${name}"`);
		}

		if (typeof frameExtension !== "string") {
			throw new Error(`Invalid frameExtension for source "${name}"`);
		}

		const source = {
			name,
			frameCount,
			frameDirectory: frameDirectory.replace(/\/+$/, ""),
			framePrefix,
			frameExtension,
			bufferSize: Math.max(1, Math.trunc(bufferSize)),
			frames: new Map(),
			loading: new Map(),
			currentIndex: null,
		};

		this.sources.set(name, source);

		if (this.activeSource === null) {
			this.activeSource = name;
		}

		return this;
	}

	getSource(name = this.activeSource) {
		if (!name) {
			return null;
		}

		return this.sources.get(name) ?? null;
	}

	requireSource(name = this.activeSource) {
		const source = this.getSource(name);

		if (!source) {
			throw new Error(`Unknown FrameManager source: ${name}`);
		}

		return source;
	}

	setActiveSource(name) {
		this.requireSource(name);

		this.activeSource = name;

		return this;
	}

	// ========================================================
	// Frame Naming
	// ========================================================

	frameName(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		const frameNumber = String(normalizedIndex).padStart(4, "0");

		return source.framePrefix + frameNumber + source.frameExtension;
	}

	frameUrl(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		return source.frameDirectory + "/" + this.frameName(index, source.name);
	}

	// ========================================================
	// Index Helpers
	// ========================================================

	normalizeIndex(index, source = this.requireSource()) {
		index = Math.trunc(Number(index));

		if (!Number.isFinite(index)) {
			throw new Error(`Invalid frame index: ${index}`);
		}

		if (index < 0 || index >= source.frameCount) {
			throw new RangeError(
				`Frame index ${index} is outside range 0-${source.frameCount - 1}`,
			);
		}

		return index;
	}

	nextIndex(index, source = this.requireSource()) {
		const normalizedIndex = this.normalizeIndex(index, source);
		const next = normalizedIndex + 1;

		if (next < source.frameCount) {
			return next;
		}

		return 0;
	}

	// ========================================================
	// Frame State
	// ========================================================

	has(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		return source.frames.has(normalizedIndex);
	}

	isLoading(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		return source.loading.has(normalizedIndex);
	}

	get(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		return source.frames.get(normalizedIndex) ?? null;
	}

	// ========================================================
	// Loading
	// ========================================================

	async loadFrame(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		// Already decoded.
		const cached = source.frames.get(normalizedIndex);

		if (cached) {
			return cached;
		}

		// Already being fetched/decoded.
		const existingLoad = source.loading.get(normalizedIndex);

		if (existingLoad) {
			return existingLoad;
		}

		if (!globalThis.BB25L) {
			throw new Error(
				"BB25L is not available. Make sure fzstd.js and bb25l.js are loaded before main.js.",
			);
		}

		const url = this.frameUrl(normalizedIndex, source.name);

		console.log(`[FRAME] Loading ${url}`);

		const promise = globalThis.BB25L.load(url)
			.then((frame) => {
				source.frames.set(normalizedIndex, frame);
				source.loading.delete(normalizedIndex);

				this.trimBuffer(source);

				return frame;
			})
			.catch((error) => {
				source.loading.delete(normalizedIndex);
				throw error;
			});

		source.loading.set(normalizedIndex, promise);

		return promise;
	}

	// ========================================================
	// Current Frame
	// ========================================================

	async setCurrent(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		const frame = await this.loadFrame(normalizedIndex, source.name);

		source.currentIndex = normalizedIndex;

		this.trimBuffer(source);
		this.queueLookahead(normalizedIndex, source.name);

		return frame;
	}

	async getCurrent(sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		if (source.currentIndex === null) {
			return null;
		}

		return this.get(source.currentIndex, source.name);
	}

	getCurrentIndex(sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		return source.currentIndex;
	}

	async getFrame(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		const frame = await this.loadFrame(normalizedIndex, source.name);

		source.currentIndex = normalizedIndex;

		this.trimBuffer(source);
		this.queueLookahead(normalizedIndex, source.name);

		return frame;
	}

	async ensure(index, sourceName = this.activeSource) {
		return this.getFrame(index, sourceName);
	}

	// ========================================================
	// Prefetch
	// ========================================================

	prefetch(index, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(index, source);

		if (
			source.frames.has(normalizedIndex) ||
			source.loading.has(normalizedIndex)
		) {
			return;
		}

		this.loadFrame(normalizedIndex, source.name).catch((error) => {
			console.warn(
				`[FRAME] Prefetch failed for frame ${normalizedIndex}:`,
				error,
			);
		});
	}

	queueLookahead(currentIndex, sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);
		const normalizedIndex = this.normalizeIndex(currentIndex, source);

		for (let offset = 1; offset < source.bufferSize; offset++) {
			const index = (normalizedIndex + offset) % source.frameCount;

			this.prefetch(index, source.name);
		}
	}

	// ========================================================
	// Buffer Management
	// ========================================================

	trimBuffer(source = this.requireSource()) {
		if (source.currentIndex === null) {
			return;
		}

		const keep = new Set();

		for (let offset = 0; offset < source.bufferSize; offset++) {
			const index = (source.currentIndex + offset) % source.frameCount;

			keep.add(index);
		}

		for (const index of source.frames.keys()) {
			if (!keep.has(index)) {
				source.frames.delete(index);
			}
		}
	}

	getBufferedIndices(sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		return [...source.frames.keys()].sort((a, b) => a - b);
	}

	getBufferInfo(sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		return {
			source: source.name,
			currentIndex: source.currentIndex,
			bufferSize: source.bufferSize,
			buffered: this.getBufferedIndices(source.name),
			loading: [...source.loading.keys()].sort((a, b) => a - b),
		};
	}

	// ========================================================
	// Cleanup
	// ========================================================

	clear(sourceName = this.activeSource) {
		const source = this.requireSource(sourceName);

		source.frames.clear();
		source.loading.clear();
		source.currentIndex = null;

		return this;
	}

	dispose() {
		for (const source of this.sources.values()) {
			source.frames.clear();
			source.loading.clear();
		}

		this.sources.clear();
		this.activeSource = null;
	}
}
