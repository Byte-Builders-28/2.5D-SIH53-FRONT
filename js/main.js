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

import { Raster2DView } from "./view/raster_2d_view.js";

import { PointCloudView } from "./view/point_cloud_view.js";

import {
	loadPointCloudFrame,
	PC_FRAME_COUNT,
	PC_FRAME_DIRECTORY,
	PC_FRAME_PREFIX,
	PC_FRAME_EXTENSION,
	PC_MAX_POINTS,
} from "./point_cloud_decoder.js";

import { Playback } from "./playback.js";
import { ViewManager } from "./view/view_manager.js";

// ============================================================
// Configuration
// ============================================================

const INITIAL_FRAME = 0;

const VIEW_RASTER    = "raster";
const VIEW_RASTER_2D = "raster2d";
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
// 3D Camera (perspective, for RasterView)
// ============================================================

function createCamera3D() {
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
		this.scene    = createScene();
		this.renderer = createRenderer();

		// ========================================================
		// 3D camera + controls (perspective, used by RasterView)
		// ========================================================

		this.camera3D = createCamera3D();

		this.controls3D = new OrbitControls(this.camera3D, this.renderer.domElement);

		this.controls3D.enableDamping = true;
		this.controls3D.dampingFactor = 0.08;

		this.controls3D.target.set(0, 0, 0);
		this.controls3D.update();

		// Active camera starts as the 3D perspective camera.
		this.activeCamera   = this.camera3D;
		this.activeControls = this.controls3D;

		// ========================================================
		// Frame Manager
		// ========================================================

		this.frameManager = new FrameManager();

		this.frameManager.setSource("raster", {
			frameCount:      RASTER_FRAME_COUNT,
			frameDirectory:  RASTER_FRAME_DIRECTORY,
			framePrefix:     RASTER_FRAME_PREFIX,
			frameExtension:  RASTER_FRAME_EXTENSION,
			bufferSize:      4,
			// No decoder supplied → FrameManager uses BB25L (legacy path).
		});

		// Point-cloud source – uses the injected Zstd XYZ decoder.
		this.frameManager.setSource("pointCloud", {
			frameCount:      PC_FRAME_COUNT,
			frameDirectory:  PC_FRAME_DIRECTORY,
			framePrefix:     PC_FRAME_PREFIX,
			frameExtension:  PC_FRAME_EXTENSION,
			bufferSize:      4,
			maxPoints:       PC_MAX_POINTS,
			// Injected decoder: fetch + Zstd decompress + Float32 XYZ.
			decoder:         (url) => loadPointCloudFrame(url, { maxPoints: PC_MAX_POINTS }),
		});

		// ========================================================
		// View Manager
		// ========================================================

		this.viewManager = new ViewManager();

		// 3D raster view — height-displaced five-layer renderer.
		this.rasterView = new RasterView(this.scene);

		this.viewManager.register(VIEW_RASTER, this.rasterView);

		// 2D raster view — flat top-down semantic renderer.
		this.raster2DView = new Raster2DView(this.scene, this.renderer);

		this.viewManager.register(VIEW_RASTER_2D, this.raster2DView);

		// Point-cloud view — 3D LiDAR point cloud (THREE.Points).
		this.pointCloudView = new PointCloudView(this.scene, {
			maxPoints: PC_MAX_POINTS,
			pointSize: 1.5,
			color:     0xffffff,
		});

		this.viewManager.register(VIEW_POINT_CLOUD, this.pointCloudView);

		// ========================================================
		// Playback
		// ========================================================

		this.displayRequestId = 0;

		this.playback = new Playback({
			frameCount: RASTER_FRAME_COUNT,
			fps:        RASTER_FPS,
			loop:       true,

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

		// Swap camera and controls based on active view.
		if (name === VIEW_RASTER_2D) {
			// 2D view uses the orthographic camera owned by Raster2DView.
			this.activeCamera   = this.raster2DView.camera;
			this.activeControls = this.raster2DView.controls;

			// Disable the 3D perspective controls while 2D is active.
			this.controls3D.enabled = false;
		} else {
			// All other views (3D raster, point cloud, …) use the
			// shared perspective camera.
			this.activeCamera   = this.camera3D;
			this.activeControls = this.controls3D;

			// Re-enable the 3D controls.
			this.controls3D.enabled = true;
		}

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

		// Determine which data source corresponds to the active view.
		const activeView = this.viewManager.getActiveViewName();
		const sourceName = activeView === VIEW_POINT_CLOUD ? "pointCloud" : "raster";

		try {
			const frame = await this.frameManager.getFrame(frameIndex, sourceName);

			// A newer frame was requested while this one was loading.
			if (requestId !== this.displayRequestId) {
				return;
			}

			if (!frame) {
				return;
			}

			this.viewManager.update(frame);

			const buffer = this.frameManager.getBufferInfo(sourceName);

			if (info) {
				if (activeView === VIEW_POINT_CLOUD) {
					info.textContent = [
						"Point Cloud",
						"----------------------",
						`Frame:    ${frameIndex.toString().padStart(4, "0")}`,
						`Points:   ${frame.pointCount.toLocaleString()}`,
						`Buffered: ${buffer.buffered
							.map((index) => index.toString().padStart(4, "0"))
							.join(", ")}`,
					].join("\n");
				} else {
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
		// Update 3D perspective camera.
		this.camera3D.aspect = window.innerWidth / window.innerHeight;
		this.camera3D.updateProjectionMatrix();

		// Update 2D orthographic camera.
		this.raster2DView.onResize();

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

		// Update only the currently-active controls so damping
		// does not interfere with the inactive view's controls.
		this.activeControls.update();

		// Render with whichever camera is currently active.
		this.renderer.render(this.scene, this.activeCamera);

		requestAnimationFrame(this._animate);
	};

	// ========================================================
	// Public Access
	// ========================================================

	getScene() {
		return this.scene;
	}

	getCamera() {
		return this.activeCamera;
	}

	getCamera3D() {
		return this.camera3D;
	}

	getCamera2D() {
		return this.raster2DView.camera;
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

	getRaster2DView() {
		return this.raster2DView;
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

		this.controls3D.dispose();

		if (this.renderer.domElement.parentNode) {
			this.renderer.domElement.parentNode.removeChild(
				this.renderer.domElement,
			);
		}
	}
}

// ============================================================
// Start
// ============================================================

const app = new Application();

globalThis.app = app;

app.start();
