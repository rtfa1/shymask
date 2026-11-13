import * as THREE from 'three';
import { poseFromColumnMajorMatrix, type TrackingPose } from '../core/tracking';

/**
 * Basic rigid 3D mask renderer.
 *
 * The mask is a small procedural low-poly helmet/visor built from primitives in
 * MediaPipe's canonical face units (centimetres) and attached to the face's
 * facial transformation matrix: no screen-space placement or 2D landmark
 * anchoring. It is rendered into an offscreen WebGL canvas with a transparent
 * clear colour and composited into the single output canvas by the pipeline, so
 * the preview and the virtual camera still consume exactly one frame path.
 *
 * The camera uses MediaPipe's documented 63 degree vertical field-of-view
 * assumption (the same assumption face_geometry uses for the transformation
 * matrix), which is what makes the mask land on the face instead of merely near
 * it. Sixteen-bit colour/RGB evidence and placement numbers are exposed for the
 * public-workflow check.
 *
 * One renderer is created for the renderer process lifetime (the mask canvas is
 * part of the single output path), so there is deliberately no `dispose()`:
 * closing Shymask tears down the window and its WebGL context.
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
  /** A point on the cyan left-eye plate, used as a pixel probe. */
  probeX: number;
  probeY: number;
  /** Exact colour of the eye plate, so the probe is unambiguous in evidence. */
  probeColor: { r: number; g: number; b: number } | null;
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

export class MaskRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group: THREE.Group;
  private visible = false;

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
    this.buildMask();
    this.scene.add(this.group);
  }

  private buildMask(): void {
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
    this.group.add(shell);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(15.2, 4.8, 1.8), visorMaterial);
    visor.position.set(0, 1.5, 5.2);
    this.group.add(visor);

    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.1, 1.4), eyeMaterial);
      eye.position.set(side * 3.9, 1.8, 6.1);
      this.group.add(eye);

      const fin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 5.6, 3.2), sideMaterial);
      fin.position.set(side * 9.4, -0.2, 0.2);
      this.group.add(fin);

      const cheek = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.4, 1.4), trimMaterial);
      cheek.position.set(side * 7.6, -3.4, 4.4);
      this.group.add(cheek);
    }

    const crest = new THREE.Mesh(new THREE.BoxGeometry(1.9, 7.8, 1.7), trimMaterial);
    crest.position.set(0, 7.9, 0.8);
    this.group.add(crest);

    const chin = new THREE.Mesh(new THREE.BoxGeometry(7.2, 1.5, 1.4), eyeMaterial);
    chin.position.set(0, -6.5, 5.2);
    this.group.add(chin);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.25, 3.4, 4), noseMaterial);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -1.8, 6.4);
    this.group.add(nose);
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

    const box = new THREE.Box3().setFromObject(this.group);
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
      ).applyMatrix4(this.group.matrixWorld);
      if (world.z >= -1) inFront = false;
      const screen = this.project(world);
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
    }
    const probeWorld = EYE_PROBE_LOCAL.clone().applyMatrix4(this.group.matrixWorld);
    const probe = this.project(probeWorld);
    const origin = this.project(new THREE.Vector3(0, 0, 0).applyMatrix4(this.group.matrixWorld));
    if (!inFront) {
      this.visible = false;
      this.group.visible = false;
      return { ...EMPTY_PROJECTION };
    }

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
      probeColor: EYE_RGB,
    };
  }

  /** Draws the mask scene into the offscreen canvas; returns render cost in ms. */
  render(): number {
    if (!this.visible) return 0;
    const startedAt = performance.now();
    this.renderer.render(this.scene, this.camera);
    return performance.now() - startedAt;
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
