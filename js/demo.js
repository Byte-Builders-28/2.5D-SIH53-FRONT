import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const canvas = document.getElementById("lidar-canvas");

const title = document.getElementById("demo-title");

const cellCountElement = document.getElementById("object-count");

const fpsElement = document.getElementById("fps-val");

const statusText = document.getElementById("status-text");

const statusDot = document.getElementById("status-dot");

const resetButton = document.getElementById("reset-btn");

/* ============================================================
 * Renderer
 * ============================================================ */

const renderer = new THREE.WebGLRenderer({
	canvas,
	antialias: true,
	alpha: false,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

renderer.setClearColor(0x080a0d, 1);

/* ============================================================
 * Scene
 * ============================================================ */

const scene = new THREE.Scene();

scene.background = new THREE.Color(0x080a0d);

/* ============================================================
 * Camera
 * ============================================================ */

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);

camera.position.set(0, 70, 85);

/* ============================================================
 * Controls
 * ============================================================ */

const controls = new OrbitControls(camera, renderer.domElement);

controls.enableDamping = true;

controls.dampingFactor = 0.08;

controls.screenSpacePanning = true;

controls.minDistance = 5;

controls.maxDistance = 300;

controls.target.set(0, 0, 0);

/* ============================================================
 * Simple reference grid
 * ============================================================ */

const grid = new THREE.GridHelper(200, 40, 0x252a30, 0x171b20);

grid.position.y = -0.05;

scene.add(grid);

/* ============================================================
 * LiDAR renderer
 * ============================================================ */

const lidar = new LidarRenderer(THREE, {
	maxRadius: 100,

	groundColor: 0x55cc66,

	staticColor: 0xf2c94c,

	dynamicColor: 0xe74c3c,

	groundScale: 1.0,

	staticScale: 1.0,

	dynamicScale: 1.0,
});

lidar.addToScene(scene);

/* ============================================================
 * Resize
 * ============================================================ */

function resize() {
	const width = canvas.clientWidth;

	const height = canvas.clientHeight;

	if (width <= 0 || height <= 0) {
		return;
	}

	camera.aspect = width / height;

	camera.updateProjectionMatrix();

	renderer.setSize(width, height, false);
}

window.addEventListener("resize", resize);

resize();

/* ============================================================
 * Reset camera
 * ============================================================ */

function resetView() {
	camera.position.set(0, 70, 85);

	controls.target.set(0, 0, 0);

	controls.update();
}

resetButton.addEventListener("click", resetView);

/* ============================================================
 * Load BB25L frame
 * ============================================================ */

async function loadFrame() {
	statusText.textContent = "Loading frame 0000";

	title.textContent = "Loading LiDAR Frame";

	try {
		const response = await fetch("data/raster/frame_0000.bb25l");

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const compressed = new Uint8Array(await response.arrayBuffer());

		console.log("[BB25L] Compressed:", compressed.byteLength, "bytes");

		/*
		 * BB25L.load() automatically detects
		 * the Zstd-compressed BB25L frame.
		 */
		const frame = await BB25L.load("data/raster/frame_0000.bb25l");

		console.log("[BB25L] Frame:", frame);

		console.log("[BB25L] Cell IDs:", frame.cellIds);

		console.log("[BB25L] Data:", frame.data);

		console.log("[BB25L] Occupied:", frame.occupiedCellCount);

		/*
		 * Send decoded data to the renderer.
		 */
		lidar.update({
			cellIds: frame.cellIds,
			data: frame.data,
			occupiedCellCount: frame.occupiedCellCount,
		});

		cellCountElement.textContent = frame.occupiedCellCount.toLocaleString();

		title.textContent = "2.5D LiDAR Raster";

		statusText.textContent = "BB25L Frame Loaded";

		statusDot.classList.add("is-ready");

		/*
		 * Put the camera into a useful
		 * initial position.
		 */
		resetView();

		console.log("[LiDAR] Renderer initialized");
	} catch (error) {
		console.error("[BB25L] Failed to load frame:", error);

		title.textContent = "Frame Load Failed";

		statusText.textContent = error.message;

		statusDot.classList.remove("is-ready");
	}
}

/* ============================================================
 * FPS
 * ============================================================ */

let frames = 0;

let lastFpsTime = performance.now();

function updateFPS(now) {
	frames++;

	const elapsed = now - lastFpsTime;

	if (elapsed >= 500) {
		const fps = (frames * 1000) / elapsed;

		fpsElement.textContent = Math.round(fps);

		frames = 0;

		lastFpsTime = now;
	}
}

/* ============================================================
 * Render loop
 * ============================================================ */

function animate(now) {
	requestAnimationFrame(animate);

	controls.update();

	renderer.render(scene, camera);

	updateFPS(now);
}

requestAnimationFrame(animate);

/* ============================================================
 * Start
 * ============================================================ */

loadFrame();
