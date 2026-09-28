import * as THREE from "three";

// ============================================================
// Constants
// ============================================================

const TAU = Math.PI * 2;

// ============================================================
// Radial Band
// ============================================================

export class RadialBand {
	constructor(start, end, radialResolution) {
		this.start = start;
		this.end = end;
		this.radial_resolution = radialResolution;
	}
}

// ============================================================
// Radial Grid
// ============================================================

export class RadialGrid {
	constructor(bands, angularCellFactor = 1.0) {
		this.bands = bands;
		this.angular_cell_factor = angularCellFactor;

		this._validate();
		this._build();
	}

	_validate() {
		let expectedStart = this.bands[0].start;

		for (const band of this.bands) {
			if (Math.abs(band.start - expectedStart) > 1e-6) {
				throw new Error("Radial bands are not continuous.");
			}

			if (band.end <= band.start) {
				throw new Error("Invalid radial band.");
			}

			if (band.radial_resolution <= 0) {
				throw new Error("Invalid radial resolution.");
			}

			expectedStart = band.end;
		}
	}

	_build() {
		this.numCells = 0;

		for (const band of this.bands) {
			const ringCount = Math.ceil(
				(band.end - band.start) / band.radial_resolution,
			);

			const actualResolution = (band.end - band.start) / ringCount;

			const midpoint = band.start + (band.end - band.start) * 0.5;

			const targetTangentialSize = actualResolution * this.angular_cell_factor;

			const angularSectors = Math.max(
				1,
				Math.ceil((2 * Math.PI * midpoint) / targetTangentialSize),
			);

			band.ring_count = ringCount;
			band.actual_resolution = actualResolution;
			band.angular_sectors = angularSectors;
			band.cell_count = ringCount * angularSectors;
			band.cell_offset = this.numCells;

			this.numCells += band.cell_count;
		}
	}

	getCellId(bandIndex, ringIndex, sectorIndex) {
		const band = this.bands[bandIndex];

		return band.cell_offset + ringIndex * band.angular_sectors + sectorIndex;
	}
}

// ============================================================
// Angle Helpers
// ============================================================

function normalizeAngle(angle) {
	angle %= TAU;

	if (angle < 0) {
		angle += TAU;
	}

	return angle;
}

function angleKey(angle) {
	return Math.round(normalizeAngle(angle) * 1e10);
}

function getBandAngles(band) {
	const angles = [];

	for (let sector = 0; sector < band.angular_sectors; sector++) {
		angles.push((sector / band.angular_sectors) * TAU);
	}

	return angles;
}

function mergeAngles(...angleLists) {
	const map = new Map();

	for (const list of angleLists) {
		for (const angle of list) {
			const normalized = normalizeAngle(angle);

			map.set(angleKey(normalized), normalized);
		}
	}

	return [...map.values()].sort((a, b) => a - b);
}

function ringPoint(radius, angle) {
	return {
		x: radius * Math.cos(angle),
		y: radius * Math.sin(angle),
	};
}

// ============================================================
// Shared Radial Disc Geometry
//
// Created ONCE and reused by all discs (both 2D and 3D).
// ============================================================

let sharedGeometry = null;
let sharedGeometryGrid = null;

function createGeometry(radialGrid) {
	const positions = [];
	const triangleCellIds = [];

	function addVertex(x, y, cellId) {
		positions.push(x, y, 0);
		triangleCellIds.push(cellId);
	}

	function addTriangle(a, b, c, cellId) {
		addVertex(a.x, a.y, cellId);
		addVertex(b.x, b.y, cellId);
		addVertex(c.x, c.y, cellId);
	}

	function buildFirstBand() {
		const band = radialGrid.bands[0];

		const outerRadius = band.actual_resolution;
		const angles = getBandAngles(band);

		for (let sector = 0; sector < band.angular_sectors; sector++) {
			const next = (sector + 1) % band.angular_sectors;

			const p0 = ringPoint(outerRadius, angles[sector]);

			const p1 = ringPoint(outerRadius, angles[next]);

			const cellId = radialGrid.getCellId(0, 0, sector);

			addTriangle({ x: 0, y: 0 }, p0, p1, cellId);
		}
	}

	function buildNativeBand(bandIndex) {
		const band = radialGrid.bands[bandIndex];
		const angles = getBandAngles(band);

		for (let ring = 0; ring < band.ring_count; ring++) {
			const innerRadius = band.start + ring * band.actual_resolution;

			const outerRadius = innerRadius + band.actual_resolution;

			for (let sector = 0; sector < band.angular_sectors; sector++) {
				if (bandIndex === 0 && ring === 0) {
					continue;
				}

				const next = (sector + 1) % band.angular_sectors;

				const a = ringPoint(innerRadius, angles[sector]);

				const b = ringPoint(outerRadius, angles[sector]);

				const c = ringPoint(outerRadius, angles[next]);

				const d = ringPoint(innerRadius, angles[next]);

				const cellId = radialGrid.getCellId(bandIndex, ring, sector);

				addTriangle(a, b, c, cellId);

				addTriangle(a, c, d, cellId);
			}
		}
	}

	function buildBandTransition(bandIndex) {
		const innerBand = radialGrid.bands[bandIndex];

		const outerBand = radialGrid.bands[bandIndex + 1];

		const radius = innerBand.end;

		const innerAngles = getBandAngles(innerBand);

		const outerAngles = getBandAngles(outerBand);

		const angles = mergeAngles(innerAngles, outerAngles);

		for (let i = 0; i < angles.length; i++) {
			const angle0 = angles[i];

			const angle1 = i + 1 < angles.length ? angles[i + 1] : angles[0] + TAU;

			const midpoint = (angle0 + angle1) * 0.5;

			const normalizedMid = normalizeAngle(midpoint);

			const sector = Math.min(
				innerBand.angular_sectors - 1,
				Math.floor((normalizedMid / TAU) * innerBand.angular_sectors),
			);

			const cellId = radialGrid.getCellId(
				bandIndex,
				innerBand.ring_count - 1,
				sector,
			);

			const p0 = ringPoint(radius, angle0);

			const p1 = ringPoint(radius, angle1);

			const innerRadius = radius - innerBand.actual_resolution;

			const center = ringPoint(innerRadius, normalizedMid);

			addTriangle(center, p0, p1, cellId);
		}
	}

	buildFirstBand();

	for (let bandIndex = 0; bandIndex < radialGrid.bands.length; bandIndex++) {
		buildNativeBand(bandIndex);
	}

	for (
		let bandIndex = 0;
		bandIndex < radialGrid.bands.length - 1;
		bandIndex++
	) {
		buildBandTransition(bandIndex);
	}

	const geometry = new THREE.BufferGeometry();

	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3),
	);

	geometry.setAttribute(
		"aCellId",
		new THREE.Float32BufferAttribute(triangleCellIds, 1),
	);

	geometry.computeBoundingSphere();

	return geometry;
}

export function getSharedGeometry(radialGrid) {
	if (sharedGeometry !== null && sharedGeometryGrid === radialGrid) {
		return sharedGeometry;
	}

	if (sharedGeometry !== null) {
		sharedGeometry.dispose();
	}

	sharedGeometry = createGeometry(radialGrid);

	sharedGeometryGrid = radialGrid;

	return sharedGeometry;
}

// ============================================================
// Flat Shader
//
// RadialDisc is now fundamentally flat.
//
// Responsibilities:
//   - fixed radial geometry (XY only)
//   - cell IDs via aCellId
//   - per-cell semantic state lookup (0=empty,1=ground,
//     2=dynamic,3=static)
//   - semantic color mapping in fragment shader
//
// There is NO height lookup and NO vertex displacement.
// The 3D height-displacement behavior lives in RadialDisc3D
// (js/view/radial_disc_3d.js), which is used only by
// RasterView.
// ============================================================

const vertexShader = /* glsl */ `

uniform sampler2D uCellState;

uniform float uStateWidth;
uniform float uStateHeight;

attribute float aCellId;

varying float vState;

void main()
{
	float cell = aCellId + 0.5;

	float texX =
		mod(cell, uStateWidth);

	float texY =
		floor(cell / uStateWidth);

	vec2 uv =
		vec2(
			texX / uStateWidth,
			texY / uStateHeight
		);

	// State is stored in the red channel as a normalised value.
	// Values: 0=empty, 1=ground, 2=dynamic, 3=static
	// We store them as 0.0 / 85.0/255.0 / 170.0/255.0 / 1.0
	// using Uint8 so multiply back: round(r * 255) / 85.
	// Simpler: store raw 0..3 in float texture (RGBA Float).
	vState = texture2D(uCellState, uv).r;

	// Flat geometry — no height displacement.
	vec3 p = position;

	gl_Position =
		projectionMatrix *
		modelViewMatrix *
		vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `

varying float vState;

void main()
{
	// Round to nearest integer state.
	int state = int(vState + 0.5);

	// 0 = empty -> discard (transparent)
	if (state == 0)
	{
		discard;
	}

	vec3 color;

	// 1 = ground  -> green
	// 2 = dynamic -> red
	// 3 = static  -> orange
	if (state == 1)
	{
		color = vec3(0.13, 0.70, 0.17);
	}
	else if (state == 2)
	{
		color = vec3(0.90, 0.18, 0.18);
	}
	else
	{
		color = vec3(1.00, 0.60, 0.10);
	}

	gl_FragColor =
		vec4(color, 1.0);
}
`;

// ============================================================
// RadialDisc
//
// Flat 2D radial disc renderer.
// Geometry is fixed (generated once, never rebuilt per frame).
// Only the per-cell state texture is updated each frame.
// ============================================================

export class RadialDisc {
	constructor(
		radialGrid,
		{
			position = new THREE.Vector3(),
			rotation = new THREE.Euler(),
			visible = true,
		} = {},
	) {
		this.radialGrid = radialGrid;

		const cellCount = radialGrid.numCells;

		// --------------------------------------------------------
		// Fixed geometry — generated once from the shared pool.
		// --------------------------------------------------------

		this.geometry = getSharedGeometry(radialGrid);

		// --------------------------------------------------------
		// Per-cell state array (CPU side).
		// Updated each frame from the BB25L sparse record.
		// 0 = empty, 1 = ground, 2 = dynamic, 3 = static
		// --------------------------------------------------------

		this.cellState = new Float32Array(cellCount);

		// --------------------------------------------------------
		// GPU state texture — reused every frame, never recreated.
		// --------------------------------------------------------

		const stateWidth = Math.min(
			1024,
			Math.max(1, Math.ceil(Math.sqrt(cellCount))),
		);
		const stateHeight = Math.ceil(cellCount / stateWidth);

		// Float RGBA texture; only the R channel is used.
		const statePixels = new Float32Array(stateWidth * stateHeight * 4);

		this.stateTexture = new THREE.DataTexture(
			statePixels,
			stateWidth,
			stateHeight,
			THREE.RGBAFormat,
			THREE.FloatType,
		);

		this.stateTexture.magFilter = THREE.NearestFilter;
		this.stateTexture.minFilter = THREE.NearestFilter;
		this.stateTexture.wrapS = THREE.ClampToEdgeWrapping;
		this.stateTexture.wrapT = THREE.ClampToEdgeWrapping;
		this.stateTexture.generateMipmaps = false;

		this._stateWidth = stateWidth;
		this._stateHeight = stateHeight;
		this._statePixels = statePixels;

		// --------------------------------------------------------
		// Material
		// --------------------------------------------------------

		this.material = new THREE.ShaderMaterial({
			vertexShader,
			fragmentShader,

			uniforms: {
				uCellState: {
					value: this.stateTexture,
				},

				uStateWidth: {
					value: stateWidth,
				},

				uStateHeight: {
					value: stateHeight,
				},
			},

			side: THREE.DoubleSide,
			transparent: false,
		});

		// --------------------------------------------------------
		// Mesh — one mesh, never recreated.
		// --------------------------------------------------------

		this.mesh = new THREE.Mesh(this.geometry, this.material);

		this.mesh.position.copy(position);
		this.mesh.rotation.copy(rotation);
		this.mesh.visible = visible;
	}

	addTo(scene) {
		scene.add(this.mesh);

		return this;
	}

	removeFrom(scene) {
		scene.remove(this.mesh);

		return this;
	}

	setPosition(x, y, z = 0) {
		this.mesh.position.set(x, y, z);

		return this;
	}

	setRotation(x, y, z) {
		this.mesh.rotation.set(x, y, z);

		return this;
	}

	setVisible(visible) {
		this.mesh.visible = visible;

		return this;
	}

	// --------------------------------------------------------
	// Update from one BB25L frame
	//
	// Semantic priority: static > dynamic > ground > empty
	//
	// Metadata bits (BB25L):
	//   bit 0 = ground present
	//   bit 1 = static present
	//   bit 2 = dynamic present
	// --------------------------------------------------------

	update(frame) {
		if (!frame) {
			throw new Error("RadialDisc.update() requires a decoded frame.");
		}

		const cellCount = this.radialGrid.numCells;
		const cellState = this.cellState;
		const pixels = this._statePixels;

		// Reset all cells to empty.
		cellState.fill(0);

		// Iterate over occupied cells in the sparse frame.
		for (let i = 0; i < frame.occupiedCellCount; i++) {
			const cellId = frame.cellIds[i];

			if (cellId >= cellCount) {
				continue;
			}

			const metadata = BB25L.getMetadata(frame, i);

			// Semantic priority: static (bit 1) > dynamic (bit 2) > ground (bit 0)
			if (metadata & 2) {
				// static present
				cellState[cellId] = 3;
			} else if (metadata & 4) {
				// dynamic present
				cellState[cellId] = 2;
			} else if (metadata & 1) {
				// ground present
				cellState[cellId] = 1;
			}
			// else: remains 0 (empty)
		}

		// Copy cellState into the RGBA pixel buffer (R channel only).
		for (let c = 0; c < cellCount; c++) {
			pixels[c * 4] = cellState[c];
			// G, B, A channels are unused (left at 0).
		}

		// Upload updated state to GPU.
		this.stateTexture.needsUpdate = true;

		return this;
	}

	dispose() {
		this.stateTexture.dispose();

		this.material.dispose();

		this.mesh.geometry = null;
		this.mesh.material = null;
	}
}

// ============================================================
// Shared geometry cleanup
// ============================================================

export function disposeRadialDiscGeometry() {
	if (sharedGeometry !== null) {
		sharedGeometry.dispose();
		sharedGeometry = null;
		sharedGeometryGrid = null;
	}
}
