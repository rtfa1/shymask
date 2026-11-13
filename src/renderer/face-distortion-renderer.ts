import * as THREE from 'three';
import type { FaceDistortionGeometry } from '../core/face-distortion';

/**
 * Fixed-shader renderer for the declarative face-distortion effect.
 *
 * The package cannot supply shader code or geometry. This renderer uploads the
 * current replay frame as a texture and applies one of two fixed radial
 * mappings (`bulge` / `pinch`) inside the ellipse computed from the tracked
 * face box. Everything outside the ellipse is a pass-through of the same
 * source frame, so no raw source frame is ever drawn by the shared pipeline
 * when the distortion effect is active: the pipeline composites this full-frame
 * canvas as the processed frame.
 *
 * Like the mask renderer, this is an offscreen WebGL canvas, not a second
 * publication path: `src/core/pipeline.ts` draws it into the single 1280x720
 * output canvas that the preview and virtual camera share.
 */

const VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * The fixed radial warp. `uWarpFactor` is signed: positive samples closer to
 * the ellipse centre (bulge/magnify), negative samples farther from it
 * (pinch/shrink). The falloff is 1 at the centre and 0 with a zero gradient at
 * the ellipse edge, so the warp blends continuously into the untouched frame.
 */
const FRAGMENT_SHADER = `
  uniform sampler2D uFrame;
  uniform vec2 uCenter;
  uniform vec2 uRadius;
  uniform float uWarpFactor;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv - uCenter;
    vec2 q = p / max(uRadius, vec2(1e-5));
    float r2 = dot(q, q);
    if (r2 >= 1.0) {
      gl_FragColor = texture2D(uFrame, vUv);
      return;
    }
    float falloff = (1.0 - r2) * (1.0 - r2);
    vec2 uv = uCenter + p * (1.0 - uWarpFactor * falloff);
    gl_FragColor = texture2D(uFrame, clamp(uv, vec2(0.0), vec2(1.0)));
  }
`;

export class FaceDistortionRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private readonly plane: THREE.Mesh;
  private frameTexture: THREE.Texture | null = null;
  private frameSource: HTMLVideoElement | null = null;
  private disposed = false;

  constructor(width: number, height: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 1);
    // The shader performs a raw texture blit into this canvas, which the shared
    // pipeline then draws with the declarative treatment filter.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFrame: { value: null },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uRadius: { value: new THREE.Vector2(0.25, 0.25) },
        uWarpFactor: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.plane.frustumCulled = false;
    this.scene.add(this.plane);
  }

  /** Uploads the per-frame warp ellipse and bounded strength. */
  setGeometry(geometry: FaceDistortionGeometry): void {
    // The tracked face box is normalized top-down (0 = top), while the quad's
    // UV space has v = 1 at the top of the frame; flip only the centre so the
    // ellipse lands on the same face pixels the diagnostic reports.
    (this.material.uniforms.uCenter?.value as THREE.Vector2).set(geometry.centerX, 1 - geometry.centerY);
    (this.material.uniforms.uRadius?.value as THREE.Vector2).set(geometry.radiusX, geometry.radiusY);
    this.material.uniforms.uWarpFactor!.value = geometry.warpFactor;
  }

  /** Renders the distorted full frame into this renderer's offscreen canvas. */
  render(video: HTMLVideoElement): number {
    if (this.disposed) return 0;
    this.ensureFrameTexture(video);
    const startedAt = performance.now();
    // The replay can be held on a paused frame, where no new video-frame
    // callback fires; forcing the upload keeps the texture on the exact frame
    // the mask pose and the pipeline composite were sampled from.
    if (this.frameTexture) this.frameTexture.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    return performance.now() - startedAt;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameTexture?.dispose();
    this.frameTexture = null;
    this.frameSource = null;
    this.plane.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
    this.renderer.dispose();
  }

  private ensureFrameTexture(video: HTMLVideoElement): void {
    if (this.frameSource === video && this.frameTexture) return;
    this.frameTexture?.dispose();
    // VideoTexture uses the proven texImage2D video upload path (a plain Texture
    // with a video image takes the texStorage2D path, which is meant for static
    // images). `needsUpdate` is also forced per processed frame so a held frame
    // is uploaded exactly.
    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    this.frameTexture = texture;
    this.frameSource = video;
    this.material.uniforms.uFrame!.value = texture;
  }
}
