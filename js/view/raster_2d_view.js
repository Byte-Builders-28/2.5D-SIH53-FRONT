import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RadialDisc } from "../radial_disc.js";
import { createRasterGrid } from "./raster_view.js";

// ============================================================
// Raster2DView
//
// Flat, top-down, orthographic 2D semantic LiDAR raster.
//
// Architecture:
//   - one RadialDisc mesh (geometry built once, never rebuilt)
//   - per-cell semantic state updated each frame from BB25L
//   - orthographic camera looking straight down (-Z)
//   - OrbitControls: zoom + pan only, no rotation
//
// Cell state mapping:
//   0 = empty    -> transparent (discarded)
//   1 = ground   -> green
//   2 = dynamic  -> red
//   3 = static   -> orange
//
// Semantic priority (static > dynamic > ground > empty):
//   bit 1 (value 2) = static present   -> state 3
//   bit 2 (value 4) = dynamic present  -> state 2
//   bit 0 (value 1) = ground present   -> state 1
// ============================================================

export class Raster2DView {
	// --------------------------------------------------------
	// constructor
	//
	// @param {THREE.Scene}       scene    - shared Three.js scene
	// @param {THREE.WebGLRenderer} renderer - shared WebGL renderer
	// --------------------------------------------------------

	constructor(scene, renderer) {
		this.scene = scene;
		this.renderer = renderer;

		// --------------------------------------------------------
		// Radial grid — same grid definition as the 3D view so
		// cell IDs are identical between both views.
		// --------------------------------------------------------

		this.grid = createRasterGrid();

		// --------------------------------------------------------
		// Flat disc — one mesh, created once.
		// --------------------------------------------------------

		this.disc = new RadialDisc(this.grid);

		this.disc.addTo(this.scene);
		this.disc.setVisible(false); // hidden until this view is active

		// --------------------------------------------------------
		// Orthographic camera
		//
		// Initial frustum is sized to fit the full sensor radius
		// (100 m) with equal XY scale and correct aspect ratio.
		// --------------------------------------------------------

		this.camera = this._createCamera();

		// --------------------------------------------------------
		// Orbit controls — pan and zoom only, no rotation.
		// --------------------------------------------------------

		this.controls = new OrbitControls(this.camera, renderer.domElement);

		this.controls.enableRotate = false;
		this.controls.enablePan = true;
		this.controls.enableZoom = true;

		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;

		this.controls.target.set(0, 0, 0);
		this.controls.update();

		this.visible = false;
	}

	// --------------------------------------------------------
	// Camera factory
	// --------------------------------------------------------

	_createCamera() {
		const w = window.innerWidth;
		const h = window.innerHeight;

		// Half-size of the orthographic frustum in world units.
		// 110 m gives a small margin around the 100 m sensor radius.
		const halfSize = 110;

		const aspect = w / h;

		const camera = new THREE.OrthographicCamera(
			-halfSize * aspect, // left
			halfSize * aspect,  // right
			halfSize,           // top
			-halfSize,          // bottom
			0.1,                // near
			1000,               // far
		);

		// Look straight down the -Z axis.
		camera.position.set(0, 0, 10);
		camera.lookAt(0, 0, 0);

		return camera;
	}

	// --------------------------------------------------------
	// Resize handler
	//
	// Called by the application when the window resizes.
	// --------------------------------------------------------

	onResize() {
		const w = window.innerWidth;
		const h = window.innerHeight;

		const halfSize = 110;
		const aspect = w / h;

		this.camera.left   = -halfSize * aspect;
		this.camera.right  =  halfSize * aspect;
		this.camera.top    =  halfSize;
		this.camera.bottom = -halfSize;

		this.camera.updateProjectionMatrix();
	}

	// --------------------------------------------------------
	// Visibility
	// --------------------------------------------------------

	setVisible(visible) {
		this.visible = visible;

		this.disc.setVisible(visible);

		return this;
	}

	// --------------------------------------------------------
	// Frame Update
	//
	// Decodes the BB25L sparse record into per-cell semantic
	// state and uploads it to the GPU state texture.
	//
	// The mesh and geometry are NOT recreated.
	// --------------------------------------------------------

	update(frame) {
		if (!frame) {
			throw new Error("Raster2DView.update() requires a decoded frame.");
		}

		this.disc.update(frame);

		return this;
	}

	// --------------------------------------------------------
	// Render
	//
	// Called from the animation loop when this view is active.
	// Updates damping controls and renders with the 2D camera.
	// --------------------------------------------------------

	render() {
		this.controls.update();
	}

	// --------------------------------------------------------
	// Grid Information (mirrors RasterView API)
	// --------------------------------------------------------

	getGrid() {
		return this.grid;
	}

	getCellCount() {
		return this.grid.numCells;
	}

	getOccupiedCellCount(frame) {
		return frame?.occupiedCellCount ?? 0;
	}

	// --------------------------------------------------------
	// Disposal
	// --------------------------------------------------------

	dispose() {
		this.disc.dispose();
		this.controls.dispose();
	}
}
