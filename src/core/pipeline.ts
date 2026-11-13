import type { ColorTreatment } from './treatments';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface FrameStats {
  renderCostMs: number;
  meanRgb: Rgb;
}

/**
 * The one canvas that produces every visible output frame. Processed frames,
 * the rigid mask composite and the opaque paused screen are all drawn here; the
 * virtual webcam publishes this same canvas instead of introducing a second
 * path. Keeping the mask as an offscreen WebGL canvas that is composited with
 * `drawImage` means the preview and camera cannot diverge.
 */
export interface ProcessedFrameOptions {
  /** The replay frame, or the distortion renderer canvas when one is used. */
  source: CanvasImageSource;
  treatment: ColorTreatment | null;
  overlay?: HTMLCanvasElement | null;
  /**
   * Distorted full-frame canvas produced from the same source frame. When
   * supplied it takes the source's place so the treatment and mask composite
   * still happen in this one pipeline.
   */
  warpedFrame?: CanvasImageSource | null;
}

export class PreviewPipeline {
  private readonly context: CanvasRenderingContext2D;
  private readonly sampleCanvas: HTMLCanvasElement;
  private readonly sampleContext: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D context is unavailable.');
    this.context = context;

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = 16;
    this.sampleCanvas.height = 9;
    const sampleContext = this.sampleCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!sampleContext) throw new Error('Canvas 2D sampling context is unavailable.');
    this.sampleContext = sampleContext;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /**
   * Draws the replay frame with an optional declarative colour treatment and an
   * optional transparent overlay (the rigid mask). Both effects share the same
   * output canvas and the same single frame path.
   */
  renderProcessedFrame(options: ProcessedFrameOptions): FrameStats {
    const startedAt = performance.now();
    this.context.save();
    this.context.filter = options.treatment?.cssFilter ?? 'none';
    this.context.drawImage(options.warpedFrame ?? options.source, 0, 0, this.width, this.height);
    this.context.restore();

    if (options.overlay) {
      this.context.save();
      this.context.filter = 'none';
      this.context.drawImage(options.overlay, 0, 0, this.width, this.height);
      this.context.restore();
    }
    return this.finishFrame(startedAt);
  }

  renderPausedScreen(title: string): FrameStats {
    const startedAt = performance.now();
    this.context.save();
    this.context.filter = 'none';
    this.context.fillStyle = '#0a0d12';
    this.context.fillRect(0, 0, this.width, this.height);
    this.context.fillStyle = '#f4f6f8';
    this.context.textAlign = 'center';
    this.context.textBaseline = 'middle';
    this.context.font = '600 72px "Segoe UI", system-ui, sans-serif';
    this.context.fillText(title, this.width / 2, this.height / 2);
    this.context.restore();
    return this.finishFrame(startedAt);
  }

  /**
   * Copies the current output canvas as top-down RGBA. This is the exact frame
   * the preview displays (processed or opaque paused screen); the main process
   * forwards it to the Windows virtual camera transport.
   */
  readOutputRgba(): ArrayBuffer {
    const image = this.context.getImageData(0, 0, this.width, this.height);
    return image.data.buffer;
  }

  /** Reads one output pixel for public diagnostics/evidence (0,0 is top-left). */
  readPixel(x: number, y: number): Rgb | null {
    const px = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    try {
      const data = this.context.getImageData(px, py, 1, 1).data;
      return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
    } catch {
      return null;
    }
  }

  private finishFrame(startedAt: number): FrameStats {
    return {
      renderCostMs: performance.now() - startedAt,
      meanRgb: this.meanRgb(),
    };
  }

  /** Cheap 16x9 downscale sample used only for public diagnostics. */
  private meanRgb(): Rgb {
    this.sampleContext.drawImage(this.canvas, 0, 0, this.sampleCanvas.width, this.sampleCanvas.height);
    const pixels = this.sampleContext.getImageData(0, 0, this.sampleCanvas.width, this.sampleCanvas.height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const count = pixels.length / 4;
    for (let index = 0; index < pixels.length; index += 4) {
      r += pixels[index] ?? 0;
      g += pixels[index + 1] ?? 0;
      b += pixels[index + 2] ?? 0;
    }
    return {
      r: Math.round(r / count),
      g: Math.round(g / count),
      b: Math.round(b / count),
    };
  }
}
