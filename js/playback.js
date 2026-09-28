// ============================================================
// Playback
//
// Controls frame progression independently from frame loading.
//
// FrameManager:
//   - loads / buffers frames
//
// Playback:
//   - tracks playback time
//   - determines which frame should be displayed
//   - handles play / pause / seek / loop
// ============================================================

export class Playback {
	constructor({
		frameCount,
		fps,
		onFrame = null,
		onStateChange = null,
		loop = true,
	} = {}) {
		if (!Number.isInteger(frameCount) || frameCount <= 0) {
			throw new Error("Playback requires a positive frameCount.");
		}

		if (!Number.isFinite(fps) || fps <= 0) {
			throw new Error("Playback requires a positive fps.");
		}

		this.frameCount = frameCount;
		this.fps = fps;

		this.loop = loop;

		this.currentFrame = 0;
		this.playing = false;

		this.time = 0.0;

		this.lastTimestamp = null;

		// ========================================================
		// Listeners
		// ========================================================

		this.frameListeners = new Set();
		this.stateListeners = new Set();

		/*
		 * Legacy callback references.
		 *
		 * These are kept separate from the listener sets so
		 * setFrameCallback() cannot accidentally remove other
		 * listeners registered with addFrameListener().
		 */
		this.frameCallback = null;
		this.stateCallback = null;

		if (typeof onFrame === "function") {
			this.frameListeners.add(onFrame);
		}

		if (typeof onStateChange === "function") {
			this.stateListeners.add(onStateChange);
		}
	}

	// ========================================================
	// Playback State
	// ========================================================

	play() {
		if (this.playing) {
			return this;
		}

		this.playing = true;
		this.lastTimestamp = null;

		this._emitState();

		return this;
	}

	pause() {
		if (!this.playing) {
			return this;
		}

		this.playing = false;
		this.lastTimestamp = null;

		this._emitState();

		return this;
	}

	toggle() {
		if (this.playing) {
			return this.pause();
		}

		return this.play();
	}

	isPlaying() {
		return this.playing;
	}

	// ========================================================
	// Frame Position
	// ========================================================

	getFrame() {
		return this.currentFrame;
	}

	getTime() {
		return this.time;
	}

	getDuration() {
		return this.frameCount / this.fps;
	}

	getFrameDuration() {
		return 1.0 / this.fps;
	}

	getProgress() {
		if (this.frameCount <= 1) {
			return 0;
		}

		return this.currentFrame / (this.frameCount - 1);
	}

	// ========================================================
	// Seeking
	// ========================================================

	seekFrame(frameIndex) {
		frameIndex = Math.trunc(frameIndex);

		if (this.loop) {
			frameIndex = this._wrapFrame(frameIndex);
		} else {
			frameIndex = Math.max(0, Math.min(this.frameCount - 1, frameIndex));
		}

		const changed = frameIndex !== this.currentFrame;

		this.currentFrame = frameIndex;
		this.time = this.currentFrame / this.fps;

		if (changed) {
			this._emitFrame();
		}

		return this;
	}

	seekTime(time) {
		if (!Number.isFinite(time)) {
			throw new Error("Playback.seekTime() requires a finite time.");
		}

		if (this.loop) {
			const duration = this.getDuration();

			if (duration > 0) {
				time %= duration;

				if (time < 0) {
					time += duration;
				}
			}
		} else {
			time = Math.max(0, Math.min(this.getDuration(), time));
		}

		const frameIndex = Math.floor(time * this.fps);

		this.time = time;

		return this.seekFrame(frameIndex);
	}

	firstFrame() {
		return this.seekFrame(0);
	}

	lastFrame() {
		return this.seekFrame(this.frameCount - 1);
	}

	// ========================================================
	// Manual Frame Stepping
	// ========================================================

	nextFrame() {
		return this.seekFrame(this.currentFrame + 1);
	}

	previousFrame() {
		return this.seekFrame(this.currentFrame - 1);
	}

	// ========================================================
	// Update
	//
	// timestamp is expected to come from requestAnimationFrame.
	// ========================================================

	update(timestamp) {
		if (!this.playing) {
			return this;
		}

		if (!Number.isFinite(timestamp)) {
			return this;
		}

		if (this.lastTimestamp === null) {
			this.lastTimestamp = timestamp;
			return this;
		}

		const deltaSeconds = (timestamp - this.lastTimestamp) / 1000.0;

		this.lastTimestamp = timestamp;

		if (deltaSeconds <= 0) {
			return this;
		}

		this.time += deltaSeconds;

		const duration = this.getDuration();

		if (this.loop) {
			if (duration > 0 && this.time >= duration) {
				this.time %= duration;
			}
		} else if (this.time >= duration) {
			this.time = duration;
			this.playing = false;
			this.lastTimestamp = null;

			this._emitState();
		}

		const frameIndex = Math.min(
			this.frameCount - 1,
			Math.floor(this.time * this.fps),
		);

		if (frameIndex !== this.currentFrame) {
			this.currentFrame = frameIndex;

			console.log("[PLAYBACK] Frame:", frameIndex);

			this._emitFrame();
		}

		return this;
	}

	// ========================================================
	// Configuration
	// ========================================================

	setLoop(loop) {
		this.loop = Boolean(loop);

		return this;
	}

	setFrameRate(fps) {
		if (!Number.isFinite(fps) || fps <= 0) {
			throw new Error("Playback.setFrameRate() requires a positive fps.");
		}

		const currentTime = this.time;

		this.fps = fps;
		this.time = currentTime;

		return this;
	}

	// ========================================================
	// Frame Listeners
	// ========================================================

	addFrameListener(callback) {
		if (typeof callback !== "function") {
			throw new Error("Frame listener must be a function.");
		}

		this.frameListeners.add(callback);

		return this;
	}

	removeFrameListener(callback) {
		this.frameListeners.delete(callback);

		return this;
	}

	// ========================================================
	// State Listeners
	// ========================================================

	addStateListener(callback) {
		if (typeof callback !== "function") {
			throw new Error("State listener must be a function.");
		}

		this.stateListeners.add(callback);

		return this;
	}

	removeStateListener(callback) {
		this.stateListeners.delete(callback);

		return this;
	}

	// ========================================================
	// Backwards-Compatible Callback API
	// ========================================================

	setFrameCallback(callback) {
		if (callback !== null && typeof callback !== "function") {
			throw new Error("Frame callback must be a function or null.");
		}

		/*
		 * Remove only the previously registered legacy callback.
		 * Do NOT clear frameListeners because other systems may
		 * have registered independent listeners.
		 */
		if (this.frameCallback !== null) {
			this.frameListeners.delete(this.frameCallback);
		}

		this.frameCallback = callback;

		if (callback !== null) {
			this.frameListeners.add(callback);
		}

		return this;
	}

	setStateCallback(callback) {
		if (callback !== null && typeof callback !== "function") {
			throw new Error("State callback must be a function or null.");
		}

		/*
		 * Remove only the previously registered legacy callback.
		 */
		if (this.stateCallback !== null) {
			this.stateListeners.delete(this.stateCallback);
		}

		this.stateCallback = callback;

		if (callback !== null) {
			this.stateListeners.add(callback);
		}

		return this;
	}

	// ========================================================
	// Internal
	// ========================================================

	_wrapFrame(frameIndex) {
		return ((frameIndex % this.frameCount) + this.frameCount) % this.frameCount;
	}

	_emitFrame() {
		for (const listener of this.frameListeners) {
			listener(this.currentFrame);
		}
	}

	_emitState() {
		const state = {
			playing: this.playing,
			frame: this.currentFrame,
			time: this.time,
			progress: this.getProgress(),
		};

		for (const listener of this.stateListeners) {
			listener(state);
		}
	}
}
