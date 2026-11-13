import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MaskAttachment, SecondaryMotionParameters } from '../core/effect-package-contract';
import { maskAttachmentTransform } from '../core/mask-attachment';
import { poseFromColumnMajorMatrix, type TrackingPose } from '../core/tracking';
import {
  CANONICAL_FACE_INDICES,
  CANONICAL_FACE_POSITIONS,
  CANONICAL_FACE_TRIANGLE_COUNT,
} from './canonical-face';

/**
 * Rigid 3D mask renderer for both the bundled procedural mask and imported
 * package masks.
 *
 * Everything is attached to the face's facial transformation matrix (not screen
 * coordinates) and rendered into one offscreen transparent WebGL canvas that
 * `src/core/pipeline.ts` composites into the single output canvas. The preview
 * and the virtual camera therefore consume exactly the same frame path whether
 * the mask is bundled or loaded from a validated package GLB. Package masks are
 * loaded with Three.js GLTFLoader into this same scene, with the manifest's
 * declarative attachment applied; no package code is executed.
 *
 * Face occlusion is a depth-only mesh of the same 468-vertex canonical face
 * surface MediaPipe fits when it produces the transformation matrix. It is
 * attached to the same matrix as the mask, renders first, writes depth and not
 * colour, so mask fragments behind the reconstructed face fail the depth test
 * and the underlying video (the real face) shows through. This is real tracked
 * geometry, not a screen-space mask-shape heuristic, and it applies to bundled
 * and imported mask content because both live under the same group.
 *
 * The camera uses MediaPipe's documented 63 degree vertical field-of-view
 * assumption (the same assumption face_geometry uses for the transformation
 * matrix), which is what makes a mask land on the face instead of merely near
 * it.
 *
 * The bundled geometry is built once and re-added on every switch. Replaced
 * GLTF content is disposed before it leaves the scene, and `dispose()` releases
 * the scene and WebGL resources when the app window tears down.
 */

export interface MaskProjection {
  visible: boolean;
  /** Projected canonical face origin (the point the mask is attached to). */
  originX: number;
  originY: number;
  /** Projected centre of the mask's world-space bounding box, in output pixels. */
  centerX: number;
  centerY: number;
  widthPx: number;
  heightPx: number;
  /** Decomposed pose from the same matrix the mask is attached to. */
  pose: TrackingPose | null;
  /** A pixel probe on the mask body, used as exact-colour evidence. */
  probeX: number;
  probeY: number;
  /** Exact colour expected at the probe, or null when the mask has no solid colour. */
  probeColor: { r: number; g: number; b: number } | null;
}

export interface PackageMaskSummary {
  meshes: number;
  materials: number;
  probeColor: { r: number; g: number; b: number } | null;
}

/**
 * A declared movable part resolved against the parsed package GLB. The node's
 * authored orientation is the rest pose; the simulator supplies an angle about
 * `axis` that is applied relative to that pose every rendered frame.
 */
export interface MaskMotionNode {
  node: THREE.Object3D;
  restQuaternion: THREE.Quaternion;
  axis: THREE.Vector3;
  maxAngleRad: number;
}

/**
 * A fully parsed package mask that has not touched the live scene yet. The
 * caller can discard it (stale switch) or commit it atomically (current switch).
 */
export interface ParsedPackageMask {
  /** Detached holder group; the caller owns it until commit/discard. */
  group: THREE.Group;
  summary: PackageMaskSummary;
  probeKind: ProbeKind;
  probeColor: { r: number; g: number; b: number } | null;
  /** Resolved secondary-motion nodes (empty when the package declares none). */
  motionNodes: MaskMotionNode[];
}

const EYE_COLOR = 0x67e8f9;
const EYE_RGB = { r: 0x67, g: 0xe8, b: 0xf9 };
/** Local point on the left eye plate, in canonical face centimetres. */
const EYE_PROBE_LOCAL = new THREE.Vector3(-3.9, 1.8, 6.85);

const EMPTY_PROJECTION: MaskProjection = {
  visible: false,
  originX: 0,
  originY: 0,
  centerX: 0,
  centerY: 0,
  widthPx: 0,
  heightPx: 0,
  pose: null,
  probeX: 0,
  probeY: 0,
  probeColor: null,
};

/** What the current content is, so the probe is computed correctly. */
type ProbeKind = 'eye' | 'material' | 'none';

export class MaskRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Static description of the depth-only occluder, for diagnostics. */
  readonly occluderTriangles = CANONICAL_FACE_TRIANGLE_COUNT;
  readonly occluderVertices = CANONICAL_FACE_POSITIONS.length / 3;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  /** Attached to the face transformation matrix. */
  private readonly group: THREE.Group;
  /** Holds the active mask content (bundled meshes or a loaded package scene). */
  private readonly content: THREE.Group;
  /** Built once; removed/re-added by reference so a switch never rebuilds it. */
  private readonly bundled: THREE.Group;
  /** Depth-only canonical face mesh; hides mask fragments behind the face. */
  private readonly occluder: THREE.Mesh;
  private occluderEnabled = true;
  private visible = false;
  private probeKind: ProbeKind = 'eye';
  private materialProbeColor: { r: number; g: number; b: number } | null = null;
  private motionNodes: MaskMotionNode[] = [];
  /** Scratch objects reused every frame; no per-frame allocation. */
  private readonly motionQuaternion = new THREE.Quaternion();
  private disposed = false;
  private readonly loader = new GLTFLoader();

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(63, width / height, 1, 10000);
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(30, 45, 80);
    this.scene.add(key);

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.content = new THREE.Group();
    this.bundled = this.buildBundledMask();
    this.content.add(this.bundled);
    this.probeKind = 'eye';
    this.materialProbeColor = null;
    this.occluder = this.buildFaceOccluder();
    // The depth-only face renders before the mask content in the same group, so
    // its depth is already in the buffer when mask fragments are depth-tested.
    this.group.add(this.occluder);
    this.group.add(this.content);
    this.scene.add(this.group);
  }

  /**
   * Builds the invisible depth-only face mesh from the canonical MediaPipe face
   * model. `colorWrite: false` means it contributes only depth; `DoubleSide` is
   * deliberate because the canonical surface is open and winding is less
   * important than reliably writing the nearest face surface.
   */
  private buildFaceOccluder(): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...CANONICAL_FACE_POSITIONS], 3));
    geometry.setIndex([...CANONICAL_FACE_INDICES]);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'face-occluder';
    mesh.renderOrder = -1;
    mesh.visible = this.occluderEnabled;
    return mesh;
  }

  /** Enables/disables the depth-only face occluder (diagnostic comparison). */
  setOcclusionEnabled(enabled: boolean): void {
    this.occluderEnabled = enabled;
    this.occluder.visible = enabled;
  }

  get occlusionEnabled(): boolean {
    return this.occluderEnabled;
  }

  /** Restores the bundled procedural mask (used when switching back to it). */
  setBundledMask(): void {
    if (this.content.children.includes(this.bundled)) {
      this.probeKind = 'eye';
      this.materialProbeColor = null;
      this.motionNodes = [];
      return;
    }
    this.disposeContent();
    this.content.add(this.bundled);
    this.probeKind = 'eye';
    this.materialProbeColor = null;
    this.motionNodes = [];
  }

  /** Builds the procedural mask geometry/material graph exactly once. */
  private buildBundledMask(): THREE.Group {
    const bundled = new THREE.Group();
    bundled.name = 'bundled-mask';
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f6fa3,
      roughness: 0.5,
      metalness: 0.2,
      flatShading: true,
    });
    const trimMaterial = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.4,
      metalness: 0.2,
      flatShading: true,
    });
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      roughness: 0.45,
      metalness: 0.15,
      flatShading: true,
    });
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b1320,
      roughness: 0.3,
      metalness: 0.45,
    });
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: EYE_COLOR });
    const noseMaterial = new THREE.MeshBasicMaterial({ color: 0x0ea5b7 });

    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(9.5, 1), shellMaterial);
    shell.scale.set(1.02, 1.16, 0.92);
    shell.position.set(0, 0.6, -2.4);
    bundled.add(shell);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(15.2, 4.8, 1.8), visorMaterial);
    visor.position.set(0, 1.5, 5.2);
    bundled.add(visor);

    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.1, 1.4), eyeMaterial);
      eye.position.set(side * 3.9, 1.8, 6.1);
      bundled.add(eye);

      const fin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 5.6, 3.2), sideMaterial);
      fin.position.set(side * 9.4, -0.2, 0.2);
      bundled.add(fin);

      const cheek = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.4, 1.4), trimMaterial);
      cheek.position.set(side * 7.6, -3.4, 4.4);
      bundled.add(cheek);
    }

    const crest = new THREE.Mesh(new THREE.BoxGeometry(1.9, 7.8, 1.7), trimMaterial);
    crest.position.set(0, 7.9, 0.8);
    bundled.add(crest);

    const chin = new THREE.Mesh(new THREE.BoxGeometry(7.2, 1.5, 1.4), eyeMaterial);
    chin.position.set(0, -6.5, 5.2);
    bundled.add(chin);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.25, 3.4, 4), noseMaterial);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -1.8, 6.4);
    bundled.add(nose);
    return bundled;
  }

  /**
   * Parses a validated package GLB into a detached group without touching the
   * live scene, so a caller whose switch token went stale can discard it.
   * Only validated `.glb` bytes reach this method; no package code is evaluated.
   */
  async parseGltfModel(
    data: ArrayBuffer,
    attachment: MaskAttachment,
    secondaryMotion: SecondaryMotionParameters | null = null,
  ): Promise<ParsedPackageMask> {
    const gltf = await new Promise<THREE.Group>((resolve, reject) => {
      this.loader.parse(
        data,
        '',
        (result: { scene: THREE.Group }) => resolve(result.scene),
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });

    const transform = maskAttachmentTransform(attachment);
    const holder = new THREE.Group();
    holder.name = 'package-mask';
    holder.position.fromArray(transform.position);
    holder.rotation.set(transform.rotationRad[0], transform.rotationRad[1], transform.rotationRad[2]);
    holder.scale.setScalar(transform.scale);
    holder.add(gltf);

    let meshes = 0;
    let materials = 0;
    let probeColor: { r: number; g: number; b: number } | null = null;
    gltf.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes += 1;
      const rawMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of rawMaterials) {
        if (material) materials += 1;
        const color = (material as THREE.MeshBasicMaterial | undefined)?.color;
        if (probeColor || !color) continue;
        const hex = color.getHexString(THREE.SRGBColorSpace);
        probeColor = {
          r: Number.parseInt(hex.slice(0, 2), 16),
          g: Number.parseInt(hex.slice(2, 4), 16),
          b: Number.parseInt(hex.slice(4, 6), 16),
        };
      }
    });
    const motionNodes: MaskMotionNode[] = [];
    for (const part of secondaryMotion?.parts ?? []) {
      const matches: THREE.Object3D[] = [];
      gltf.traverse((object: THREE.Object3D) => {
        if (object.name === part.node) matches.push(object);
      });
      if (matches.length !== 1) {
        throw new Error(
          `the declared movable part node "${part.node}" must exist exactly once in the mask GLB; found ${matches.length}`,
        );
      }
      const node = matches[0] as THREE.Object3D;
      motionNodes.push({
        node,
        restQuaternion: node.quaternion.clone(),
        axis:
          part.axis === 'x'
            ? new THREE.Vector3(1, 0, 0)
            : part.axis === 'y'
              ? new THREE.Vector3(0, 1, 0)
              : new THREE.Vector3(0, 0, 1),
        maxAngleRad: (part.maxAngleDeg * Math.PI) / 180,
      });
    }
    return {
      group: holder,
      summary: { meshes, materials, probeColor },
      probeKind: probeColor ? 'material' : 'none',
      probeColor,
      motionNodes,
    };
  }

  /**
   * Applies one simulated angle per declared movable part, relative to the
   * node's authored orientation plus the declared rest offset. Angles are
   * clamped to the validated part bound as defense in depth; the simulator
   * already enforces the same bound.
   */
  setSecondaryMotionAngles(anglesRad: readonly number[]): void {
    for (const [index, motion] of this.motionNodes.entries()) {
      const angle = Math.max(
        -motion.maxAngleRad,
        Math.min(motion.maxAngleRad, anglesRad[index] ?? 0),
      );
      this.motionQuaternion.setFromAxisAngle(motion.axis, angle);
      motion.node.quaternion.copy(motion.restQuaternion).multiply(this.motionQuaternion);
    }
  }

  /**
   * Atomically replaces the live content with a parsed package mask. Called only
   * after the caller re-checked its switch token; no await may separate the
   * token check from this synchronous swap.
   */
  commitGltfModel(content: ParsedPackageMask): void {
    this.disposeContent();
    this.content.add(content.group);
    this.probeKind = content.probeKind;
    this.materialProbeColor = content.probeColor;
    this.motionNodes = content.motionNodes;
  }

  /** Releases an uncommitted parse (for example a switch superseded mid-load). */
  discardGltfModel(content: ParsedPackageMask): void {
    this.disposeObjectResources(content.group);
  }

  /** Releases the mask scene's geometries, materials, textures and WebGL context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeContent();
    this.disposeObjectResources(this.bundled);
    this.occluder.geometry.dispose();
    (this.occluder.material as THREE.Material).dispose();
    this.visible = false;
    this.group.visible = false;
    this.scene.clear();
    this.renderer.dispose();
  }

  /** Disposes everything under `content` except the reusable bundled graph. */
  private disposeContent(): void {
    this.motionNodes = [];
    for (const child of [...this.content.children]) {
      if (child !== this.bundled) this.disposeObjectResources(child);
      this.content.remove(child);
    }
  }

  private disposeObjectResources(root: THREE.Object3D): void {
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    root.traverse((object: THREE.Object3D) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const rawMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of rawMaterials) {
        if (!material) continue;
        materials.add(material);
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  }

  /**
   * Attaches the mask to a MediaPipe facial transformation matrix (column-major,
   * metres/centimetres in the canonical model). Passing null hides it.
   */
  setPose(matrix: number[] | null): MaskProjection {
    const pose = matrix ? poseFromColumnMajorMatrix(matrix) : null;
    if (!matrix || matrix.length < 16 || !pose) {
      this.visible = false;
      this.group.visible = false;
      return { ...EMPTY_PROJECTION };
    }

    this.group.matrix.fromArray(matrix);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.visible = true;
    this.visible = true;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    // Box3.setFromObject returns a world-space box (it applies matrixWorld), so
    // the corners must not be transformed a second time. Only the mask content
    // is measured: the depth-only face occluder is not part of the mask's
    // reported bounds or probe.
    const box = new THREE.Box3().setFromObject(this.content);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let inFront = true;
    for (const corner of CORNERS) {
      const world = new THREE.Vector3(
        corner[0] ? box.max.x : box.min.x,
        corner[1] ? box.max.y : box.min.y,
        corner[2] ? box.max.z : box.min.z,
      );
      if (world.z >= -1) inFront = false;
      const screen = this.project(world);
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
    }
    if (!inFront) {
      this.visible = false;
      this.group.visible = false;
      return { ...EMPTY_PROJECTION };
    }

    const origin = this.project(new THREE.Vector3(0, 0, 0).applyMatrix4(this.group.matrixWorld));
    const probeWorld =
      this.probeKind === 'eye'
        ? EYE_PROBE_LOCAL.clone().applyMatrix4(this.group.matrixWorld)
        : box.getCenter(new THREE.Vector3());
    const probe = this.project(probeWorld);
    return {
      visible: true,
      originX: origin.x,
      originY: origin.y,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      widthPx: maxX - minX,
      heightPx: maxY - minY,
      pose,
      probeX: probe.x,
      probeY: probe.y,
      probeColor: this.probeKind === 'eye' ? EYE_RGB : this.materialProbeColor,
    };
  }

  /** Draws the mask scene into the offscreen canvas; returns render cost in ms. */
  render(): number {
    if (!this.visible) return 0;
    const startedAt = performance.now();
    this.renderer.render(this.scene, this.camera);
    return performance.now() - startedAt;
  }

  /**
   * Projects the origin of a raw tracker matrix without changing the rendered
   * scene. Smoothing evidence compares this raw origin with the rendered mask
   * origin to measure the offset the filter introduced.
   */
  projectMatrixOrigin(matrix: ArrayLike<number>): { x: number; y: number } | null {
    if (matrix.length < 16) return null;
    const world = new THREE.Vector3(
      matrix[12] as number,
      matrix[13] as number,
      matrix[14] as number,
    );
    return this.project(world);
  }

  private project(world: THREE.Vector3): { x: number; y: number } {
    const projected = world.clone().project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * this.canvas.width,
      y: ((1 - projected.y) / 2) * this.canvas.height,
    };
  }
}

const CORNERS: ReadonlyArray<readonly [boolean, boolean, boolean]> = [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, false, true],
  [true, false, true],
  [false, true, true],
  [true, true, true],
];
