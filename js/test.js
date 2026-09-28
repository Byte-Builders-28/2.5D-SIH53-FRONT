import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
	RadialBand,
	RadialGrid,
	RadialDisc,
	groundSelector,
} from "./radial_disc.js";

// ============================================================
// Configuration
// ============================================================

const FRAME_COUNT = 992;
const FPS = 25;
const FRAME_INTERVAL = 1000 / FPS;

const FRAME_DIRECTORY = "./data/raster";
const FRAME_PREFIX = "frame_0";
const FRAME_EXTENSION = ".bb25l";

// ============================================================
// Radial Grid
// ============================================================

const radialGrid = new RadialGrid(
	[
		new RadialBand(0.0, 10.0, 0.3),
		new RadialBand(10.0, 30.0, 0.45),
		new RadialBand(30.0, 60.0, 0.7),
		new RadialBand(60.0, 100.0, 1.0),
	],
	1.0,
);

console.log("[RADIAL GRID]");

for (let i = 0; i < radialGrid.bands.length; i++) {
	const band = radialGrid.bands[i];

	console.log(
		`B${i}: ` +
			`${band.start.toFixed(2)}-` +
			`${band.end.toFixed(2)} m | ` +
			`dr=${band.actual_resolution.toFixed(3)} | ` +
			`rings=${band.ring_count} | ` +
			`sectors=${band.angular_sectors} | ` +
			`cells=${band.cell_count} | ` +
			`offset=${band.cell_offset}`,
	);
}

console.log(`[RADIAL GRID] Total cells: ${radialGrid.numCells}`);

// ============================================================
// Scene
// ============================================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(
	55,
	window.innerWidth / window.innerHeight,
	0.1,
	500,
);

camera.position.set(0, -115, 120);

const renderer = new THREE.WebGLRenderer({
	antialias: true,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// ============================================================
// Controls
// ============================================================

const controls = new OrbitControls(camera, renderer.domElement);

controls.target.set(0, 0, 0);
controls.update();

// ============================================================
// Frame Helpers
// ============================================================

function frameName(frameIndex) {
	return (
		FRAME_PREFIX + frameIndex.toString().padStart(3, "0") + FRAME_EXTENSION
	);
}

function frameUrl(frameIndex) {
	return `${FRAME_DIRECTORY}/${frameName(frameIndex)}`;
}

function updateInfo(frameIndex, frame, status = "Playing") {
	const info = document.getElementById("info");

	if (!info) {
		return;
	}

	info.textContent = [
		"BB25L Ground",
		"----------------------",
		`Status: ${status}`,
		`Frame: ${frameIndex.toString().padStart(3, "0")} / 991`,
		`Time: ${(frameIndex / FPS).toFixed(2)} s`,
		`FPS: ${FPS}`,
		`Grid cells: ${radialGrid.numCells.toLocaleString()}`,
		`Occupied cells: ${frame.occupiedCellCount.toLocaleString()}`,
	].join("\n");
}

// ============================================================
// Frame Loading
// ============================================================

async function loadFrame(frameIndex) {
	const url = frameUrl(frameIndex);

	console.log(`[FRAME] Loading ${url}`);

	const frame = await BB25L.load(url);

	console.log(
		`[FRAME] ${frameIndex.toString().padStart(3, "0")}`,
		BB25L.getStats(frame),
	);

	return frame;
}

// ============================================================
// Ground
// ============================================================

const ground = new RadialDisc(radialGrid, {
	color: 0x4488bb,
});

ground.addTo(scene);

// ============================================================
// Playback State
// ============================================================

let currentFrame = 0;
let currentData = null;

let nextFrame = null;
let nextFrameIndex = -1;

let loadingFrame = null;
let loadingFrameIndex = -1;

let lastFrameTime = performance.now();
let playbackStarted = false;

// ============================================================
// Preload
// ============================================================

function preloadFrame(frameIndex) {
	if (frameIndex < 0 || frameIndex >= FRAME_COUNT) {
		return;
	}

	if (nextFrameIndex === frameIndex && nextFrame !== null) {
		return;
	}

	if (loadingFrameIndex === frameIndex) {
		return;
	}

	loadingFrameIndex = frameIndex;

	loadingFrame = loadFrame(frameIndex)
		.then((frame) => {
			nextFrame = frame;
			nextFrameIndex = frameIndex;
		})
		.catch((error) => {
			console.error(`[FRAME] Failed to load ${frameName(frameIndex)}`, error);
		})
		.finally(() => {
			loadingFrame = null;
			loadingFrameIndex = -1;
		});
}

// ============================================================
// Apply Frame
// ============================================================

function applyFrame(frameIndex, frame) {
	ground.update(frame, groundSelector);

	currentFrame = frameIndex;
	currentData = frame;

	updateInfo(frameIndex, frame, "Playing");

	const nextIndex = (frameIndex + 1) % FRAME_COUNT;

	nextFrame = null;
	nextFrameIndex = -1;

	preloadFrame(nextIndex);
}

// ============================================================
// Start Playback
// ============================================================

async function startPlayback() {
	updateInfo(
		0,
		{
			occupiedCellCount: 0,
		},
		"Loading...",
	);

	currentData = await loadFrame(0);

	applyFrame(0, currentData);

	playbackStarted = true;
	lastFrameTime = performance.now();

	preloadFrame(1);
}

// ============================================================
// Playback
// ============================================================

async function updatePlayback(now) {
	if (!playbackStarted) {
		return;
	}

	if (now - lastFrameTime < FRAME_INTERVAL) {
		return;
	}

	/*
	 * Keep the playback clock at exactly 25 FPS.
	 * If rendering stalls for a short period, catch up without
	 * creating multiple frame updates in one render tick.
	 */
	lastFrameTime += FRAME_INTERVAL;

	const targetFrame = (currentFrame + 1) % FRAME_COUNT;

	if (nextFrame !== null && nextFrameIndex === targetFrame) {
		const frame = nextFrame;

		applyFrame(targetFrame, frame);
		return;
	}

	/*
	 * The next frame was not ready yet.
	 *
	 * Do not block rendering. Keep displaying the current frame
	 * and make sure the required frame is loading.
	 */
	preloadFrame(targetFrame);
}

// ============================================================
// Resize
// ============================================================

window.addEventListener("resize", () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// Render Loop
// ============================================================

function animate(now) {
	requestAnimationFrame(animate);

	updatePlayback(now);

	renderer.render(scene, camera);
}

// ============================================================
// Start
// ============================================================

try {
	await startPlayback();
	requestAnimationFrame(animate);
} catch (error) {
	console.error(error);

	document.getElementById("info").textContent = "ERROR\n\n" + error.message;
}
