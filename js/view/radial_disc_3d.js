import * as THREE from "three";
import { getSharedGeometry } from "../radial_disc.js";

// ============================================================
// RadialDisc3D
//
// 3D-specific radial disc renderer.
//
// Identical to the original RadialDisc implementation but
// kept separate so RadialDisc itself can become flat.
//
// Responsibilities:
//   - height-displaced vertex rendering
//   - per-disc occupied/height lookup texture
//   - single solid color per disc
//
// Used exclusively by RasterView for the five height layers:
//   ground, staticMin, staticMax, dynamicMin, dynamicMax
// ============================================================

// ============================================================
// Shader — height displacement
// ============================================================

const vertexShader3D = /* glsl */ `

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

	// Height displacement — this is the 3D-specific behavior.
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

const fragmentShader3D = /* glsl */ `

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
// RadialDisc3D
// ============================================================

export class RadialDisc3D {
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

		// Reuse the shared geometry from radial_disc.js.
		this.geometry = getSharedGeometry(radialGrid);

		this.material = new THREE.ShaderMaterial({
			vertexShader: vertexShader3D,
			fragmentShader: fragmentShader3D,

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
			throw new Error("RadialDisc3D.update() requires a selector function.");
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
