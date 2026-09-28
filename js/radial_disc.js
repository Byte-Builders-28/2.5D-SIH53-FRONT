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
// This is created ONCE and reused by all five discs.
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

function getSharedGeometry(radialGrid) {
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
// Shader
// ============================================================

const vertexShader = /* glsl */ `

uniform sampler2D uCellLookup;

uniform float uLookupWidth;
uniform float uLookupHeight;

attribute float aCellId;

varying float vPresent;

void main()
{
	float cell = aCellId + 0.5;

	float texX =
		mod(cell, uLookupWidth);

	float texY =
		floor(cell / uLookupWidth);

	vec2 uv =
		vec2(
			texX / uLookupWidth,
			texY / uLookupHeight
		);

	vec4 cellData =
		texture2D(
			uCellLookup,
			uv
		);

	float occupied =
		cellData.r;

	float height =
		cellData.g;

	vPresent = occupied;

	vec3 p = position;

	p.z = height;

	if (occupied < 0.5)
	{
		p =
			vec3(
				0.0,
				0.0,
				-10000.0
			);
	}

	gl_Position =
		projectionMatrix *
		modelViewMatrix *
		vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `

uniform vec3 uColor;

varying float vPresent;

void main()
{
	if (vPresent < 0.5)
	{
		discard;
	}

	gl_FragColor =
		vec4(
			uColor,
			1.0
		);
}
`;

// ============================================================
// RadialDisc
// ============================================================

export class RadialDisc {
	constructor(
		radialGrid,
		{
			color = 0x4488bb,
			position = new THREE.Vector3(),
			rotation = new THREE.Euler(),
			visible = true,
		} = {},
	) {
		this.radialGrid = radialGrid;

		this.lookup = null;
		this.frame = null;

		this.geometry = getSharedGeometry(radialGrid);

		this.material = new THREE.ShaderMaterial({
			vertexShader,
			fragmentShader,

			uniforms: {
				uCellLookup: {
					value: null,
				},

				uLookupWidth: {
					value: 1,
				},

				uLookupHeight: {
					value: 1,
				},

				uColor: {
					value: new THREE.Color(color),
				},
			},

			side: THREE.DoubleSide,
		});

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

	setColor(color) {
		this.material.uniforms.uColor.value.set(color);

		return this;
	}

	setVisible(visible) {
		this.mesh.visible = visible;

		return this;
	}

	// --------------------------------------------------------
	// Create lookup texture for one disc
	// --------------------------------------------------------

	createLookup(frame, selector) {
		const cellCount = this.radialGrid.numCells;

		const width = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt(cellCount))));

		const height = Math.ceil(cellCount / width);

		const pixels = new Float32Array(width * height * 4);

		for (let i = 0; i < frame.occupiedCellCount; i++) {
			const cellId = frame.cellIds[i];

			if (cellId >= cellCount) {
				continue;
			}

			const value = selector(frame, i);

			if (value === null || value === undefined) {
				continue;
			}

			if (!value.present) {
				continue;
			}

			const offset = cellId * 4;

			pixels[offset + 0] = 1.0;
			pixels[offset + 1] = value.z;
			pixels[offset + 2] = 0.0;
			pixels[offset + 3] = 1.0;
		}

		const texture = new THREE.DataTexture(
			pixels,
			width,
			height,
			THREE.RGBAFormat,
			THREE.FloatType,
		);

		texture.needsUpdate = true;

		texture.magFilter = THREE.NearestFilter;

		texture.minFilter = THREE.NearestFilter;

		texture.wrapS = THREE.ClampToEdgeWrapping;

		texture.wrapT = THREE.ClampToEdgeWrapping;

		texture.generateMipmaps = false;

		return {
			texture,
			width,
			height,
		};
	}

	// --------------------------------------------------------
	// Update this disc from one frame
	// --------------------------------------------------------

	update(frame, selector) {
		if (typeof selector !== "function") {
			throw new Error("RadialDisc.update() requires a selector function.");
		}

		const nextLookup = this.createLookup(frame, selector);

		if (this.lookup !== null) {
			this.lookup.texture.dispose();
		}

		this.lookup = nextLookup;
		this.frame = frame;

		this.material.uniforms.uCellLookup.value = nextLookup.texture;

		this.material.uniforms.uLookupWidth.value = nextLookup.width;

		this.material.uniforms.uLookupHeight.value = nextLookup.height;

		return this;
	}

	dispose() {
		if (this.lookup !== null) {
			this.lookup.texture.dispose();
			this.lookup = null;
		}

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
