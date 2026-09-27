/* ============================================================
 * lidar-renderer.js
 *
 * Three.js renderer for BB25L radial LiDAR data.
 *
 * Input:
 *
 *   {
 *       cellIds: Uint32Array,
 *       data: Uint8Array,
 *       occupiedCellCount: number
 *   }
 *
 * data contains exactly 10 bytes per occupied cell:
 *
 *   0-1 : ground Z uint16
 *   2   : ground delta min
 *   3   : ground delta max
 *   4   : static min
 *   5   : static max
 *   6   : dynamic min
 *   7   : dynamic max
 *   8-9 : metadata uint16
 *
 * ============================================================ */

class LidarRenderer {
	constructor(THREE, options = {}) {
		this.THREE = THREE;

		this.options = {
			maxRadius: 100.0,

			groundColor: 0x55cc66,
			staticColor: 0xf2a33a,
			dynamicColor: 0xe74c3c,

			groundHeightScale: 1.0,
			staticHeightScale: 1.0,
			dynamicHeightScale: 1.0,

			...options,
		};

		this.cellCount = 0;
		this.topology = null;

		this.geometry = null;

		this.groundMesh = null;
		this.staticMesh = null;
		this.dynamicMesh = null;

		this.groundMaterial = null;
		this.staticMaterial = null;
		this.dynamicMaterial = null;

		this.groundTexture = null;
		this.staticTexture = null;
		this.dynamicTexture = null;

		this._build();
	}

	/* ========================================================
	 * Topology
	 * ======================================================== */

	/*
	 * The topology MUST come from the same RadialGrid used by
	 * the C++ rasterizer.
	 *
	 * topology:
	 *
	 * {
	 *     cellCount,
	 *     x0,
	 *     y0,
	 *     x1,
	 *     y1,
	 *     x2,
	 *     y2,
	 *     x3,
	 *     y3
	 * }
	 *
	 * Each array has cellCount entries.
	 */
	setTopology(topology) {
		if (!topology) {
			throw new Error("Radial topology is required");
		}

		if (!Number.isInteger(topology.cellCount) || topology.cellCount <= 0) {
			throw new Error("Invalid topology.cellCount");
		}

		this.topology = topology;

		this._rebuildGeometry();
		this._rebuildMaterials();

		return this;
	}

	/* ========================================================
	 * Scene
	 * ======================================================== */

	addToScene(scene) {
		if (!this.groundMesh) {
			throw new Error("Call setTopology() before addToScene()");
		}

		scene.add(this.groundMesh);
		scene.add(this.staticMesh);
		scene.add(this.dynamicMesh);

		return this;
	}

	removeFromScene(scene) {
		if (!scene) {
			return;
		}

		scene.remove(this.groundMesh);
		scene.remove(this.staticMesh);
		scene.remove(this.dynamicMesh);
	}

	/* ========================================================
	 * Raster update
	 * ======================================================== */

	update(frame) {
		if (!this.topology) {
			throw new Error("Radial topology has not been set");
		}

		const cellIds = frame.cellIds;
		const data = frame.data;

		const occupied = frame.occupiedCellCount ?? cellIds.length;

		if (!(cellIds instanceof Uint32Array)) {
			throw new TypeError("frame.cellIds must be Uint32Array");
		}

		/*
		 * bb25l.js should return the reconstructed
		 * 10-byte records as a flat Uint8Array:
		 *
		 *   M * 10
		 */
		if (!(data instanceof Uint8Array)) {
			throw new TypeError("frame.data must be Uint8Array");
		}

		if (data.length !== occupied * 10) {
			throw new Error(
				`Invalid BB25L data size: ` +
					`${data.length}, expected ${occupied * 10}`,
			);
		}

		this._disposeTextures();

		const ground = new Uint8Array(this.topology.cellCount * 4);

		const staticLayer = new Uint8Array(this.topology.cellCount * 4);

		const dynamicLayer = new Uint8Array(this.topology.cellCount * 4);

		for (let i = 0; i < occupied; i++) {
			const cellId = cellIds[i];

			if (cellId >= this.topology.cellCount) {
				console.warn(`[LiDAR] Invalid cell ID ${cellId}`);

				continue;
			}

			const src = i * 10;

			const metadata = data[src + 8] | (data[src + 9] << 8);

			const groundPresent = (metadata & 1) !== 0;

			const staticPresent = (metadata & 2) !== 0;

			const dynamicPresent = (metadata & 4) !== 0;

			/*
			 * Ground
			 */

			if (groundPresent) {
				const dst = cellId * 4;

				ground[dst + 0] = data[src + 0];

				ground[dst + 1] = data[src + 1];

				ground[dst + 2] = data[src + 2];

				ground[dst + 3] = data[src + 3];
			}

			/*
			 * Static
			 */

			if (staticPresent) {
				const dst = cellId * 4;

				staticLayer[dst + 0] = data[src + 4];

				staticLayer[dst + 1] = data[src + 5];

				staticLayer[dst + 2] = 255;

				staticLayer[dst + 3] = (metadata >> 7) & 0x07;
			}

			/*
			 * Dynamic
			 */

			if (dynamicPresent) {
				const dst = cellId * 4;

				dynamicLayer[dst + 0] = data[src + 6];

				dynamicLayer[dst + 1] = data[src + 7];

				dynamicLayer[dst + 2] = 255;

				dynamicLayer[dst + 3] = (metadata >> 10) & 0x07;
			}
		}

		this.groundTexture = this._createTexture(ground);

		this.staticTexture = this._createTexture(staticLayer);

		this.dynamicTexture = this._createTexture(dynamicLayer);

		this.groundMaterial.uniforms.uRaster.value = this.groundTexture;

		this.staticMaterial.uniforms.uRaster.value = this.staticTexture;

		this.dynamicMaterial.uniforms.uRaster.value = this.dynamicTexture;

		console.log("[LiDAR] Uploaded:", occupied.toLocaleString(), "cells");
	}

	clear() {
		this._disposeTextures();

		if (this.groundMaterial) {
			this.groundMaterial.uniforms.uRaster.value = null;
		}

		if (this.staticMaterial) {
			this.staticMaterial.uniforms.uRaster.value = null;
		}

		if (this.dynamicMaterial) {
			this.dynamicMaterial.uniforms.uRaster.value = null;
		}
	}

	/* ========================================================
	 * Geometry
	 * ======================================================== */

	_rebuildGeometry() {
		const THREE = this.THREE;
		const topology = this.topology;

		if (this.geometry) {
			this.geometry.dispose();
		}

		const cellCount = topology.cellCount;

		const positions = new Float32Array(cellCount * 4 * 3);

		const cellIds = new Float32Array(cellCount * 4);

		const indices = new Uint32Array(cellCount * 6);

		for (let cell = 0; cell < cellCount; cell++) {
			const p = cell * 12;

			positions[p + 0] = topology.x0[cell];

			positions[p + 1] = topology.y0[cell];

			positions[p + 2] = 0;

			positions[p + 3] = topology.x1[cell];

			positions[p + 4] = topology.y1[cell];

			positions[p + 5] = 0;

			positions[p + 6] = topology.x2[cell];

			positions[p + 7] = topology.y2[cell];

			positions[p + 8] = 0;

			positions[p + 9] = topology.x3[cell];

			positions[p + 10] = topology.y3[cell];

			positions[p + 11] = 0;

			const c = cell * 4;

			cellIds[c + 0] = cell;

			cellIds[c + 1] = cell;

			cellIds[c + 2] = cell;

			cellIds[c + 3] = cell;

			const index = cell * 6;

			const base = cell * 4;

			indices[index + 0] = base + 0;

			indices[index + 1] = base + 1;

			indices[index + 2] = base + 2;

			indices[index + 3] = base + 0;

			indices[index + 4] = base + 2;

			indices[index + 5] = base + 3;
		}

		this.geometry = new THREE.BufferGeometry();

		this.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);

		this.geometry.setAttribute(
			"aCellId",
			new THREE.BufferAttribute(cellIds, 1),
		);

		this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

		this.geometry.computeBoundingSphere();

		this.cellCount = cellCount;
	}

	/* ========================================================
	 * Materials
	 * ======================================================== */

	_rebuildMaterials() {
		if (this.groundMaterial) {
			this.groundMaterial.dispose();
		}

		if (this.staticMaterial) {
			this.staticMaterial.dispose();
		}

		if (this.dynamicMaterial) {
			this.dynamicMaterial.dispose();
		}

		this.groundMaterial = this._createGroundMaterial();

		this.staticMaterial = this._createObstacleMaterial(
			this.options.staticColor,
			this.options.staticHeightScale,
		);

		this.dynamicMaterial = this._createObstacleMaterial(
			this.options.dynamicColor,
			this.options.dynamicHeightScale,
		);

		this.groundMesh = new this.THREE.Mesh(this.geometry, this.groundMaterial);

		this.staticMesh = new this.THREE.Mesh(this.geometry, this.staticMaterial);

		this.dynamicMesh = new this.THREE.Mesh(this.geometry, this.dynamicMaterial);

		this.groundMesh.name = "BB25L_Ground";

		this.staticMesh.name = "BB25L_Static";

		this.dynamicMesh.name = "BB25L_Dynamic";

		this.groundMesh.frustumCulled = true;

		this.staticMesh.frustumCulled = true;

		this.dynamicMesh.frustumCulled = true;
	}

	_createGroundMaterial() {
		const THREE = this.THREE;

		return new THREE.ShaderMaterial({
			uniforms: {
				uRaster: {
					value: null,
				},

				uRasterWidth: {
					value: this._textureWidth(),
				},

				uRasterHeight: {
					value: this._textureHeight(),
				},

				uColor: {
					value: new THREE.Color(this.options.groundColor),
				},

				uHeightScale: {
					value: this.options.groundHeightScale,
				},
			},

			vertexShader: `
                precision highp float;

                attribute float aCellId;

                uniform sampler2D uRaster;
                uniform float uRasterWidth;
                uniform float uRasterHeight;
                uniform float uHeightScale;

                varying float vPresent;

                vec4 readRaster(float id)
                {
                    float x =
                        mod(id, uRasterWidth);

                    float y =
                        floor(id / uRasterWidth);

                    vec2 uv =
                        vec2(
                            (x + 0.5) / uRasterWidth,
                            (y + 0.5) / uRasterHeight
                        );

                    return texture2D(
                        uRaster,
                        uv
                    );
                }

                void main()
                {
                    vec4 cell =
                        readRaster(aCellId);

                    vPresent =
                        cell.a > 0.0 ||
                        cell.r > 0.0 ||
                        cell.g > 0.0
                            ? 1.0
                            : 0.0;

                    float z =
                        (
                            cell.r +
                            cell.g * 256.0
                        ) * 0.01;

                    vec3 p =
                        position;

                    p.z =
                        z * uHeightScale;

                    gl_Position =
                        projectionMatrix *
                        modelViewMatrix *
                        vec4(p, 1.0);
                }
            `,

			fragmentShader: `
                precision highp float;

                uniform vec3 uColor;

                varying float vPresent;

                void main()
                {
                    if (vPresent < 0.5) {
                        discard;
                    }

                    gl_FragColor =
                        vec4(
                            uColor,
                            0.72
                        );
                }
            `,

			transparent: true,
			depthWrite: true,
			side: THREE.DoubleSide,
		});
	}

	_createObstacleMaterial(color, heightScale) {
		const THREE = this.THREE;

		return new THREE.ShaderMaterial({
			uniforms: {
				uRaster: {
					value: null,
				},

				uRasterWidth: {
					value: this._textureWidth(),
				},

				uRasterHeight: {
					value: this._textureHeight(),
				},

				uHeightScale: {
					value: heightScale,
				},

				uColor: {
					value: new THREE.Color(color),
				},
			},

			vertexShader: `
                precision highp float;

                attribute float aCellId;

                uniform sampler2D uRaster;
                uniform float uRasterWidth;
                uniform float uRasterHeight;
                uniform float uHeightScale;

                varying float vPresent;

                vec4 readRaster(float id)
                {
                    float x =
                        mod(id, uRasterWidth);

                    float y =
                        floor(id / uRasterWidth);

                    vec2 uv =
                        vec2(
                            (x + 0.5) / uRasterWidth,
                            (y + 0.5) / uRasterHeight
                        );

                    return texture2D(
                        uRaster,
                        uv
                    );
                }

                void main()
                {
                    vec4 cell =
                        readRaster(aCellId);

                    vPresent =
                        cell.b > 0.5
                            ? 1.0
                            : 0.0;

                    /*
                     * Max obstacle height in centimeters.
                     */
                    float z =
                        cell.g * 0.01;

                    vec3 p =
                        position;

                    p.z =
                        z * uHeightScale;

                    gl_Position =
                        projectionMatrix *
                        modelViewMatrix *
                        vec4(p, 1.0);
                }
            `,

			fragmentShader: `
                precision highp float;

                uniform vec3 uColor;

                varying float vPresent;

                void main()
                {
                    if (vPresent < 0.5) {
                        discard;
                    }

                    gl_FragColor =
                        vec4(
                            uColor,
                            0.78
                        );
                }
            `,

			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
		});
	}

	/* ========================================================
	 * Texture
	 * ======================================================== */

	_textureWidth() {
		return 4096;
	}

	_textureHeight() {
		return Math.ceil(this.cellCount / this._textureWidth());
	}

	_createTexture(data) {
		const THREE = this.THREE;

		const width = this._textureWidth();

		const height = this._textureHeight();

		const textureData = new Uint8Array(width * height * 4);

		textureData.set(data);

		const texture = new THREE.DataTexture(
			textureData,
			width,
			height,
			THREE.RGBAFormat,
			THREE.UnsignedByteType,
		);

		texture.minFilter = THREE.NearestFilter;

		texture.magFilter = THREE.NearestFilter;

		texture.wrapS = THREE.ClampToEdgeWrapping;

		texture.wrapT = THREE.ClampToEdgeWrapping;

		texture.generateMipmaps = false;

		texture.needsUpdate = true;

		return texture;
	}

	_disposeTextures() {
		if (this.groundTexture) {
			this.groundTexture.dispose();
			this.groundTexture = null;
		}

		if (this.staticTexture) {
			this.staticTexture.dispose();
			this.staticTexture = null;
		}

		if (this.dynamicTexture) {
			this.dynamicTexture.dispose();
			this.dynamicTexture = null;
		}
	}

	dispose() {
		this._disposeTextures();

		if (this.geometry) {
			this.geometry.dispose();
		}

		if (this.groundMaterial) {
			this.groundMaterial.dispose();
		}

		if (this.staticMaterial) {
			this.staticMaterial.dispose();
		}

		if (this.dynamicMaterial) {
			this.dynamicMaterial.dispose();
		}
	}
}

globalThis.LidarRenderer = LidarRenderer;
