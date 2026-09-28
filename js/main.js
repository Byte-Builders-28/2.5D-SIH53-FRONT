import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { FrameManager } from "./frame_manager.js";

import {
	RasterView,
	RASTER_FRAME_COUNT,
	RASTER_FPS,
	RASTER_FRAME_DIRECTORY,
	RASTER_FRAME_PREFIX,
	RASTER_FRAME_EXTENSION,
} from "./view/raster_view.js";

import { Playback } from "./playback.js";
import { ViewManager } from "./view/view_manager.js";

// ============================================================
// Configuration
// ============================================================

const INITIAL_FRAME = 0;

const VIEW_RASTER = "raster";
const VIEW_POINT_CLOUD = "pointCloud";

// ============================================================
// Renderer
// ============================================================

function createRenderer() {
	const renderer = new THREE.WebGLRenderer({
		antialias: true,
	});

	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

	renderer.setSize(window.innerWidth, window.innerHeight);

	return renderer;
}

// ============================================================
// Camera
// ============================================================

function createCamera() {
	const aspect = window.innerWidth / window.innerHeight;

	const camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 500);

	camera.position.set(0, -115, 120);

	camera.lookAt(0, 0, 0);

	return camera;
}

// ============================================================
// Scene
// ============================================================

function createScene() {
	const scene = new THREE.Scene();

	scene.background = new THREE.Color(0x111111);

	return scene;
}

// ============================================================
// Application
// ============================================================

class Application {
	constructor() {
		this.scene = createScene();
		this.camera = createCamera();
		this.renderer = createRenderer();
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);

		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;

		this.controls.target.set(0, 0, 0);

		this.controls.update();
		// ========================================================
		// Frame Manager
		// ========================================================

		this.frameManager = new FrameManager();

		this.frameManager.setSource("raster", {
			frameCount: RASTER_FRAME_COUNT,
			frameDirectory: RASTER_FRAME_DIRECTORY,
			framePrefix: RASTER_FRAME_PREFIX,
			frameExtension: RASTER_FRAME_EXTENSION,
			bufferSize: 4,
		});

		// ========================================================
		// View Manager
		// ========================================================

		this.viewManager = new ViewManager();

		this.rasterView = new RasterView(this.scene);

		this.viewManager.register(VIEW_RASTER, this.rasterView);

		// Point-cloud view will be registered here later.
		//
		// this.pointCloudView = new PointCloudView(this.scene);
		//
		// this.viewManager.register(
		//     VIEW_POINT_CLOUD,
		//     this.pointCloudView,
		// );

		// ========================================================
		// Playback
		// ========================================================

		this.displayRequestId = 0;

		this.playback = new Playback({
			frameCount: RASTER_FRAME_COUNT,
			fps: RASTER_FPS,
			loop: true,

			onFrame: (frameIndex) => {
				console.log("[APP] Displaying frame:", frameIndex);

				this.displayFrame(frameIndex);
			},
		});

		console.log("[APP] Playback:", this.playback);
		console.log("[APP] Frame listeners:", this.playback.frameListeners?.size);

		// ========================================================
		// Events
		// ========================================================

		this._bindEvents();

		// ========================================================
		// Initial View
		// ========================================================

		this.setView(VIEW_RASTER);

		this.playback.seekFrame(INITIAL_FRAME);
	}

	// ========================================================
	// View Switching
	// ========================================================

	setView(name) {
		this.viewManager.setView(name);

		return this;
	}

	getView() {
		return this.viewManager.getActiveViewName();
	}

	// ========================================================
	// Frame Display
	// ========================================================

	async displayFrame(frameIndex) {
		const requestId = ++this.displayRequestId;
		const info = document.getElementById("info");

		try {
			const frame = await this.frameManager.getFrame(frameIndex);

			// A newer frame was requested while this one was loading.
			if (requestId !== this.displayRequestId) {
				return;
			}

			if (!frame) {
				return;
			}

			this.viewManager.update(frame);

			const buffer = this.frameManager.getBufferInfo();

			if (info) {
				info.textContent = [
					"BB25L Raster",
					"----------------------",
					`Frame: ${frameIndex.toString().padStart(4, "0")}`,
					`Occupied cells: ${frame.occupiedCellCount.toLocaleString()}`,
					`Grid cells: ${this.rasterView.getCellCount().toLocaleString()}`,
					`Buffered: ${buffer.buffered
						.map((index) => index.toString().padStart(4, "0"))
						.join(", ")}`,
				].join("\n");
			}
		} catch (error) {
			if (requestId !== this.displayRequestId) {
				return;
			}

			console.error(`[FRAME] Failed to display frame ${frameIndex}:`, error);

			if (info) {
				info.textContent = [
					"ERROR",
					"----------------------",
					`Frame: ${frameIndex.toString().padStart(4, "0")}`,
					error instanceof Error ? error.message : String(error),
				].join("\n");
			}
		}
	}

	// ========================================================
	// Events
	// ========================================================

	_bindEvents() {
		window.addEventListener("resize", () => {
			this._resize();
		});
	}

	_resize() {
		this.camera.aspect = window.innerWidth / window.innerHeight;

		this.camera.updateProjectionMatrix();

		this.renderer.setSize(window.innerWidth, window.innerHeight);
	}

	// ========================================================
	// Animation
	// ========================================================

	start() {
		document.body.appendChild(this.renderer.domElement);

		/*
		 * Playback starts at frame 0, but seekFrame(0) may not
		 * emit a frame event when frame 0 is already current.
		 *
		 * Explicitly load the initial frame here.
		 */
		this.displayFrame(INITIAL_FRAME);

		this.playback.play();

		this._animate();

		return this;
	}

	_animate = (timestamp) => {
		this.playback.update(timestamp);

		this.controls.update();

		this.renderer.render(this.scene, this.camera);

		requestAnimationFrame(this._animate);
	};

	// ========================================================
	// Public Access
	// ========================================================

	getScene() {
		return this.scene;
	}

	getCamera() {
		return this.camera;
	}

	getRenderer() {
		return this.renderer;
	}

	getFrameManager() {
		return this.frameManager;
	}

	getViewManager() {
		return this.viewManager;
	}

	getRasterView() {
		return this.rasterView;
	}

	getPlayback() {
		return this.playback;
	}

	// ========================================================
	// Cleanup
	// ========================================================

	dispose() {
		this.playback.pause();

		this.viewManager.dispose();

		this.frameManager.dispose();

		this.renderer.dispose();
		this.controls.dispose();

		if (this.renderer.domElement.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
	}
}

// ============================================================
// Start
// ============================================================

const app = new Application();

globalThis.app = app;

app.start();
