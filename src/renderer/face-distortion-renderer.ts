import * as THREE from 'three';
import {
  faceDistortionContains,
  distortionRenderable,
  type DistortionRenderHealth,
  type FaceDistortionGeometry,
  type FrameDeltaStats,
} from '../core/face-distortion';

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
 *
 * A lost WebGL context makes the renderer non-drawable (`isDrawable()` false and
 * `render()` null) instead of silently returning a stale canvas. The caller then
 * reports an undrawable frame, the existing 250 ms guard hides the output, and
 * the pipeline never falls back to the raw replay frame.
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

/** Identity blit used only for the deterministic warp-delta diagnostic. */
const IDENTITY_FRAGMENT_SHADER = `
  uniform sampler2D uFrame;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(uFrame, vUv);
  }
`;

const METRIC_WIDTH = 64;
const METRIC_HEIGHT = 36;

/** Zeroed diagnostic result for a non-drawable renderer. */
const EMPTY_DELTA: FrameDeltaStats = {
  sampledPixels: 0,
  insidePixels: 0,
  meanAbsDiff: 0,
  changedInsidePct: 0,
  changedOutsidePct: 0,
};

export class FaceDistortionRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private readonly identityMaterial: THREE.ShaderMaterial;
  private readonly plane: THREE.Mesh;
  private readonly frameUniform: { value: THREE.Texture | null };
  private readonly warpTarget: THREE.WebGLRenderTarget;
  private readonly identityTarget: THREE.WebGLRenderTarget;
  private readonly warpPixels = new Uint8Array(METRIC_WIDTH * METRIC_HEIGHT * 4);
  private readonly identityPixels = new Uint8Array(METRIC_WIDTH * METRIC_HEIGHT * 4);
  private frameTexture: THREE.Texture | null = null;
  private frameSource: HTMLVideoElement | null = null;
  private disposed = false;
  /** Set from the canvas `webglcontextlost` event until a restore event. */
  private contextLost = false;
  /**
   * The WEBGL_lose_context extension is cached before a loss: WebGL returns
   * null from getExtension() once the context is lost, so re-querying it after
   * the failure would make a diagnostic restore impossible.
   */
  private contextExtension: WEBGL_lose_context | null | undefined = undefined;

  /**
   * Marks the renderer non-drawable as soon as the context is lost. Preventing
   * the default lets the browser attempt a restore; either way no frame is
   * composited while the canvas is invalid. Three.js also listens for these
   * events and re-initialises its state on restore, so only our flag and the
   * frame texture (whose GPU contents are gone) are cleared here.
   */
  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.frameTexture = null;
    this.frameSource = null;
    this.frameUniform.value = null;
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
  };

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
    this.frameUniform = { value: null };
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFrame: this.frameUniform,
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uRadius: { value: new THREE.Vector2(0.25, 0.25) },
        uWarpFactor: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.identityMaterial = new THREE.ShaderMaterial({
      uniforms: { uFrame: this.frameUniform },
      vertexShader: VERTEX_SHADER,
      fragmentShader: IDENTITY_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.plane.frustumCulled = false;
    this.scene.add(this.plane);
    const targetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.warpTarget = new THREE.WebGLRenderTarget(METRIC_WIDTH, METRIC_HEIGHT, targetOptions);
    this.identityTarget = new THREE.WebGLRenderTarget(METRIC_WIDTH, METRIC_HEIGHT, targetOptions);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
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

  /** True when the offscreen context can draw a trustworthy frame. */
  isDrawable(): boolean {
    const gl = this.renderer.getContext();
    const health: DistortionRenderHealth = {
      disposed: this.disposed,
      contextLost: this.contextLost,
      glContextLost: gl.isContextLost(),
    };
    return distortionRenderable(health);
  }

  get contextIsLost(): boolean {
    return this.contextLost || this.renderer.getContext().isContextLost();
  }

  /**
   * Diagnostic-only failure injection: loses this renderer's WebGL context so
   * the public workflow can prove the output hides instead of compositing a
   * stale frame. Returns false when the browser has no WEBGL_lose_context.
   */
  loseContext(): boolean {
    const extension = this.getContextExtension();
    if (!extension) return false;
    extension.loseContext();
    return true;
  }

  /** Diagnostic-only recovery attempt; the browser must support restore. */
  restoreContext(): boolean {
    const extension = this.getContextExtension();
    if (!extension) return false;
    extension.restoreContext();
    return true;
  }

  private getContextExtension(): WEBGL_lose_context | null {
    if (this.contextExtension === undefined) {
      this.contextExtension = this.renderer.getContext().getExtension('WEBGL_lose_context');
    }
    return this.contextExtension;
  }

  /**
   * Renders the distorted full frame into this renderer's offscreen canvas and
   * returns the main-thread WebGL submission time (`performance.now()` around
   * `renderer.render()`), or null when the renderer cannot draw.
   *
   * This is submission cost only: there is no GPU sync or readback, so the GPU
   * cost lands later in the compositor and is not part of this number. Do not
   * report it as the total warp cost.
   *
   * `warp: false` is the public A/B diagnostic: it draws the same uploaded
   * frame through the identity shader instead of the warp, keeping the effect
   * active and the output path identical apart from the warp term.
   */
  render(video: HTMLVideoElement, options: { warp?: boolean } = {}): number | null {
    if (!this.isDrawable()) return null;
    this.ensureFrameTexture(video);
    const startedAt = performance.now();
    // The replay can be held on a paused frame, where no new video-frame
    // callback fires; forcing the upload keeps the texture on the exact frame
    // the mask pose and the pipeline composite were sampled from.
    if (this.frameTexture) this.frameTexture.needsUpdate = true;
    this.renderer.setRenderTarget(null);
    this.plane.material = options.warp === false ? this.identityMaterial : this.material;
    this.renderer.render(this.scene, this.camera);
    this.plane.material = this.material;
    return performance.now() - startedAt;
  }

  /**
   * Deterministic warp-delta diagnostic: renders the same uploaded frame
   * texture once through the identity shader and once through the warp shader
   * into two 64x36 targets, then compares them. Because both passes share the
   * texture and resolution, the outside-ellipse difference is zero apart from
   * GPU rounding and the inside difference is the warp itself; this avoids
   * comparing an HTML video frame with a WebGL canvas through different
   * resamplers. Called at most every 200 ms, after `render()` uploaded the frame.
   */
  measureWarpDelta(geometry: FaceDistortionGeometry): FrameDeltaStats {
    if (!this.isDrawable()) {
      return { ...EMPTY_DELTA };
    }
    this.plane.material = this.material;
    this.renderer.setRenderTarget(this.warpTarget);
    this.renderer.render(this.scene, this.camera);
    this.plane.material = this.identityMaterial;
    this.renderer.setRenderTarget(this.identityTarget);
    this.renderer.render(this.scene, this.camera);
    this.plane.material = this.material;
    this.renderer.setRenderTarget(null);
    this.renderer.readRenderTargetPixels(this.warpTarget, 0, 0, METRIC_WIDTH, METRIC_HEIGHT, this.warpPixels);
    this.renderer.readRenderTargetPixels(this.identityTarget, 0, 0, METRIC_WIDTH, METRIC_HEIGHT, this.identityPixels);

    const sampledPixels = METRIC_WIDTH * METRIC_HEIGHT;
    let totalDiff = 0;
    let insidePixels = 0;
    let insideChanged = 0;
    let outsideChanged = 0;
    for (let index = 0; index < sampledPixels; index += 1) {
      const offset = index * 4;
      const redDiff = Math.abs((this.warpPixels[offset] ?? 0) - (this.identityPixels[offset] ?? 0));
      const greenDiff = Math.abs((this.warpPixels[offset + 1] ?? 0) - (this.identityPixels[offset + 1] ?? 0));
      const blueDiff = Math.abs((this.warpPixels[offset + 2] ?? 0) - (this.identityPixels[offset + 2] ?? 0));
      totalDiff += redDiff + greenDiff + blueDiff;
      const x = (index % METRIC_WIDTH + 0.5) / METRIC_WIDTH;
      // Render-target row 0 is the bottom of the frame; the ellipse uses the
      // top-down normalized coordinates of the tracked face box.
      const y = 1 - (Math.floor(index / METRIC_WIDTH) + 0.5) / METRIC_HEIGHT;
      const changed = Math.max(redDiff, greenDiff, blueDiff) > 8;
      if (faceDistortionContains(geometry, x, y)) {
        insidePixels += 1;
        if (changed) insideChanged += 1;
      } else if (changed) {
        outsideChanged += 1;
      }
    }
    const outsidePixels = sampledPixels - insidePixels;
    return {
      sampledPixels,
      insidePixels,
      meanAbsDiff: totalDiff / (sampledPixels * 3),
      changedInsidePct: insidePixels > 0 ? (insideChanged / insidePixels) * 100 : 0,
      changedOutsidePct: outsidePixels > 0 ? (outsideChanged / outsidePixels) * 100 : 0,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.frameTexture?.dispose();
    this.frameTexture = null;
    this.frameSource = null;
    this.warpTarget.dispose();
    this.identityTarget.dispose();
    this.plane.geometry.dispose();
    this.material.dispose();
    this.identityMaterial.dispose();
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
    this.frameUniform.value = texture;
  }
}
