import * as THREE from "three";

// ============================================================
// PointCloudView
//
// Renders a LiDAR point cloud using THREE.Points.
//
// Design constraints (from spec):
//   - ONE BufferGeometry, allocated once.
//   - ONE Float32Array (capacity = maxPoints * 3), allocated once.
//   - ONE BufferAttribute, allocated once.
//   - ONE PointsMaterial, allocated once.
//   - ONE THREE.Points, allocated once.
//   - Per-frame: only copy XYZ data + needsUpdate + setDrawRange.
//   - No BB25L dependency.
//   - No Zstandard dependency.
//   - No FrameManager dependency.
//   - No Playback dependency.
//   - Receives a pre-decoded { positions, pointCount } frame.
// ============================================================

// Default maximum point count matches the Python generator cap.
const DEFAULT_MAX_POINTS = 50_000;

export class PointCloudView {
	/**
	 * @param {THREE.Scene} scene
	 * @param {object}      [options]
	 * @param {number}      [options.maxPoints=50000] – GPU buffer capacity.
	 * @param {number}      [options.pointSize=1.5]   – rendered point size.
	 * @param {number}      [options.color=0xffffff]  – point color.
	 */
	constructor(scene, { maxPoints = DEFAULT_MAX_POINTS, pointSize = 1.5, color = 0xffffff } = {}) {
		this.scene     = scene;
		this.maxPoints = maxPoints;

		// --------------------------------------------------------
		// Current render state (updated each frame).
		// --------------------------------------------------------

		this.currentPointCount = 0;
		this.visible           = false;

		// --------------------------------------------------------
		// GPU resources – allocated ONCE.
		// --------------------------------------------------------

		// Pre-allocate a flat XYZ float buffer for the maximum
		// expected point count.  This buffer lives for the entire
		// playback session.
		this.positions = new Float32Array(maxPoints * 3);

		// Wrap the buffer in a BufferAttribute.
		// usage = THREE.DynamicDrawUsage tells the GPU driver that
		// this buffer will be updated frequently.
		this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
		this.positionAttribute.setUsage(THREE.DynamicDrawUsage);

		// Create the geometry and attach the attribute.
		this.geometry = new THREE.BufferGeometry();
		this.geometry.setAttribute("position", this.positionAttribute);

		// Start with zero visible points.
		this.geometry.setDrawRange(0, 0);

		// Single-colour point material.  No RGB attributes because
		// the source .bin files contain only XYZ.
		this.material = new THREE.PointsMaterial({
			color: color,
			size:  pointSize,
			sizeAttenuation: true,
		});

		// The single THREE.Points object that lives for the entire
		// playback session.
		this.points = new THREE.Points(this.geometry, this.material);
		this.points.frustumCulled = false; // cloud may extend far from origin
		this.points.visible = false;       // hidden until this view is active

		// Add to scene immediately (visibility controlled by .visible flag).
		this.scene.add(this.points);
	}

	// --------------------------------------------------------
	// Scene management
	// --------------------------------------------------------

	addToScene(scene) {
		const targetScene = scene || this.scene;

		if (!this.points.parent) {
			targetScene.add(this.points);
		}

		return this;
	}

	removeFromScene(scene) {
		const targetScene = scene || this.scene;

		targetScene.remove(this.points);

		return this;
	}

	// --------------------------------------------------------
	// Visibility
	// --------------------------------------------------------

	setVisible(visible) {
		this.visible        = visible;
		this.points.visible = visible;

		return this;
	}

	// --------------------------------------------------------
	// Frame update
	//
	// @param {object} frame
	//   frame.positions   – Float32Array of XYZ values from the
	//                       point-cloud decoder.
	//   frame.pointCount  – number of valid points in positions.
	//
	// Contract:
	//   - The same GPU buffer, attribute, geometry, and points
	//     object are reused every call.
	//   - Only the buffer content, needsUpdate flag, and draw
	//     range change between frames.
	// --------------------------------------------------------

	update(frame) {
		if (!frame) {
			throw new Error("PointCloudView.update() requires a decoded frame.");
		}

		const { positions, pointCount } = frame;

		if (!positions || !(positions instanceof Float32Array)) {
			throw new Error(
				"PointCloudView.update(): frame.positions must be a Float32Array.",
			);
		}

		if (!Number.isInteger(pointCount) || pointCount < 0) {
			throw new Error(
				`PointCloudView.update(): invalid pointCount: ${pointCount}`,
			);
		}

		if (pointCount > this.maxPoints) {
			throw new Error(
				`PointCloudView.update(): pointCount (${pointCount}) exceeds ` +
					`maxPoints (${this.maxPoints}).`,
			);
		}

		// Copy the decoded XYZ data into the pre-allocated GPU buffer.
		// We copy only the used portion (pointCount * 3 floats).
		// Old data beyond pointCount is never read because setDrawRange
		// limits the draw call precisely.
		this.positions.set(positions.subarray(0, pointCount * 3));

		// Inform Three.js that the position data has changed.
		this.positionAttribute.needsUpdate = true;

		// Update the draw range so that only valid points are rendered.
		// Stale data from a previous, larger frame is NOT drawn.
		this.geometry.setDrawRange(0, pointCount);

		this.currentPointCount = pointCount;

		return this;
	}

	// --------------------------------------------------------
	// Accessors
	// --------------------------------------------------------

	getPointCount() {
		return this.currentPointCount;
	}

	getMaxPoints() {
		return this.maxPoints;
	}

	// --------------------------------------------------------
	// Disposal
	//
	// Releases GPU memory for the geometry and material.
	//
	// Does NOT dispose:
	//   - renderer
	//   - camera
	//   - controls
	//   - scene
	// Those belong to the application infrastructure.
	// --------------------------------------------------------

	dispose() {
		this.scene.remove(this.points);

		this.geometry.dispose();
		this.material.dispose();
	}
}
