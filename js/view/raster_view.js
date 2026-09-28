import { RadialBand, RadialGrid } from "../radial_disc.js";
import { RadialDisc3D } from "./radial_disc_3d.js";

// ============================================================
// Configuration
// ============================================================

export const RASTER_FRAME_COUNT = 992;
export const RASTER_FPS = 25;

export const RASTER_FRAME_DIRECTORY = "/data/raster";
export const RASTER_FRAME_PREFIX = "frame_";
export const RASTER_FRAME_EXTENSION = ".bb25l";

// ============================================================
// Radial Grid
// ============================================================

export function createRasterGrid() {
	return new RadialGrid(
		[
			new RadialBand(0.0, 10.0, 0.3),
			new RadialBand(10.0, 30.0, 0.45),
			new RadialBand(30.0, 60.0, 0.7),
			new RadialBand(60.0, 100.0, 1.0),
		],
		1.0,
	);
}

// ============================================================
// Layer Selectors
//
// These selectors feed the 3D height-displacement renderer.
// They extract a single Z value per disc per occupied cell.
// ============================================================

function groundSelector(frame, index) {
	const metadata = BB25L.getMetadata(frame, index);

	if (!BB25L.hasGround(metadata)) {
		return null;
	}

	return {
		present: true,
		z: BB25L.getGroundZMeters(frame, index),
	};
}

function staticMinSelector(frame, index) {
	const metadata = BB25L.getMetadata(frame, index);

	if (!BB25L.hasStatic(metadata)) {
		return null;
	}

	return {
		present: true,
		z: BB25L.getStaticHeightMinMeters(frame, index),
	};
}

function staticMaxSelector(frame, index) {
	const metadata = BB25L.getMetadata(frame, index);

	if (!BB25L.hasStatic(metadata)) {
		return null;
	}

	return {
		present: true,
		z: BB25L.getStaticHeightMaxMeters(frame, index),
	};
}

function dynamicMinSelector(frame, index) {
	const metadata = BB25L.getMetadata(frame, index);

	if (!BB25L.hasDynamic(metadata)) {
		return null;
	}

	return {
		present: true,
		z: BB25L.getDynamicHeightMinMeters(frame, index),
	};
}

function dynamicMaxSelector(frame, index) {
	const metadata = BB25L.getMetadata(frame, index);

	if (!BB25L.hasDynamic(metadata)) {
		return null;
	}

	return {
		present: true,
		z: BB25L.getDynamicHeightMaxMeters(frame, index),
	};
}

// ============================================================
// Raster View
//
// 3D height-displaced raster using five RadialDisc3D layers:
//   ground      - ground Z surface
//   staticMin   - bottom of static objects
//   staticMax   - top of static objects
//   dynamicMin  - bottom of dynamic objects
//   dynamicMax  - top of dynamic objects
// ============================================================

export class RasterView {
	constructor(scene) {
		this.scene = scene;

		this.grid = createRasterGrid();

		this.ground = new RadialDisc3D(this.grid, {
			color: 0x4488bb,
		});

		this.staticMin = new RadialDisc3D(this.grid, {
			color: 0x777777,
		});

		this.staticMax = new RadialDisc3D(this.grid, {
			color: 0xbbbbbb,
		});

		this.dynamicMin = new RadialDisc3D(this.grid, {
			color: 0xcc6633,
		});

		this.dynamicMax = new RadialDisc3D(this.grid, {
			color: 0xffaa44,
		});

		this.discs = [
			this.ground,
			this.staticMin,
			this.staticMax,
			this.dynamicMin,
			this.dynamicMax,
		];

		this.visible = true;

		this.addToScene();
	}

	// --------------------------------------------------------
	// Scene
	// --------------------------------------------------------

	addToScene() {
		for (const disc of this.discs) {
			disc.addTo(this.scene);
		}

		return this;
	}

	removeFromScene() {
		for (const disc of this.discs) {
			disc.removeFrom(this.scene);
		}

		return this;
	}

	// --------------------------------------------------------
	// Visibility
	// --------------------------------------------------------

	setVisible(visible) {
		this.visible = visible;

		for (const disc of this.discs) {
			disc.setVisible(visible);
		}

		return this;
	}

	// --------------------------------------------------------
	// Frame Update
	// --------------------------------------------------------

	update(frame) {
		if (!frame) {
			throw new Error("RasterView.update() requires a decoded frame.");
		}

		this.ground.update(frame, groundSelector);

		this.staticMin.update(frame, staticMinSelector);
		this.staticMax.update(frame, staticMaxSelector);

		this.dynamicMin.update(frame, dynamicMinSelector);
		this.dynamicMax.update(frame, dynamicMaxSelector);

		return this;
	}

	// --------------------------------------------------------
	// Grid Information
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
		for (const disc of this.discs) {
			disc.dispose();
		}

		this.discs.length = 0;
	}
}

// ============================================================
// Debug
// ============================================================

export function logRasterGrid(grid) {
	console.log("[RADIAL GRID]");

	for (let i = 0; i < grid.bands.length; i++) {
		const band = grid.bands[i];

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

	console.log(`[RADIAL GRID] Total cells: ${grid.numCells}`);
}
