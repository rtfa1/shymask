import { faceDistortionContains, type FaceDistortionGeometry } from './face-distortion';
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
 * Diagnostic measurement of the face-distortion path: a low-resolution
 * comparison between the untouched replay frame and the distorted frame for
 * the same presented source frame. It proves pixels really changed and that the
 * change is localized to the tracked face ellipse, without claiming what the
 * warped pixel "should" look like.
 */
export interface FrameDeltaStats {
  /** Number of low-resolution samples compared. */
  sampledPixels: number;
  /** Samples whose normalized coordinates fall inside the warp ellipse. */
  insidePixels: number;
  /** Mean absolute per-channel difference over all samples (0-255). */
  meanAbsDiff: number;
  /** Percentage of inside-ellipse samples whose max channel diff exceeds 8. */
  changedInsidePct: number;
  /** Percentage of outside-ellipse samples whose max channel diff exceeds 8. */
  changedOutsidePct: number;
}

/**
 * The one canvas that produces every visible output frame. Processed frames,
 * the rigid mask composite and the opaque paused screen are all drawn here; the
 * virtual webcam publishes this same canvas instead of introducing a second
 * path. Keeping the mask as an offscreen WebGL canvas that is composited with
 * `drawImage` means the preview and camera cannot diverge.
 */
export class PreviewPipeline {
  private readonly context: CanvasRenderingContext2D;
  private readonly sampleCanvas: HTMLCanvasElement;
  private readonly sampleContext: CanvasRenderingContext2D;
  private readonly compareReferenceCanvas: HTMLCanvasElement;
  private readonly compareReferenceContext: CanvasRenderingContext2D;
  private readonly compareProcessedCanvas: HTMLCanvasElement;
  private readonly compareProcessedContext: CanvasRenderingContext2D;

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

    this.compareReferenceCanvas = document.createElement('canvas');
    this.compareReferenceCanvas.width = 64;
    this.compareReferenceCanvas.height = 36;
    const compareReferenceContext = this.compareReferenceCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    if (!compareReferenceContext) throw new Error('Canvas 2D comparison context is unavailable.');
    this.compareReferenceContext = compareReferenceContext;

    this.compareProcessedCanvas = document.createElement('canvas');
    this.compareProcessedCanvas.width = 64;
    this.compareProcessedCanvas.height = 36;
    const compareProcessedContext = this.compareProcessedCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    if (!compareProcessedContext) throw new Error('Canvas 2D comparison context is unavailable.');
    this.compareProcessedContext = compareProcessedContext;
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
   * output canvas and the same single frame path. `warpedFrame`, when supplied,
   * is the distorted full-frame canvas produced by the face-distortion renderer
   * from the same source frame; it takes the source's place so the treatment and
   * mask composite still happen in this one pipeline.
   */
  renderProcessedFrame(
    source: CanvasImageSource,
    treatment: ColorTreatment | null,
    overlay: HTMLCanvasElement | null = null,
    warpedFrame: CanvasImageSource | null = null,
  ): FrameStats {
    const startedAt = performance.now();
    this.context.save();
    this.context.filter = treatment?.cssFilter ?? 'none';
    this.context.drawImage(warpedFrame ?? source, 0, 0, this.width, this.height);
    this.context.restore();

    if (overlay) {
      this.context.save();
      this.context.filter = 'none';
      this.context.drawImage(overlay, 0, 0, this.width, this.height);
      this.context.restore();
    }
    return this.finishFrame(startedAt);
  }

  /**
   * Compares the reference replay frame with the distorted frame for the same
   * presented frame at 64x36 and reports how much changed, split by the warp
   * ellipse. The diagnostic is deliberately low resolution: it is evidence that
   * the distortion path changes real output pixels and follows the face region,
   * not a per-pixel quality metric.
   */
  measureFrameDelta(
    reference: CanvasImageSource,
    processed: CanvasImageSource,
    treatment: ColorTreatment | null,
    geometry: FaceDistortionGeometry,
  ): FrameDeltaStats {
    this.drawInto(this.compareReferenceContext, reference, treatment);
    this.drawInto(this.compareProcessedContext, processed, treatment);
    const referencePixels = this.compareReferenceContext.getImageData(
      0,
      0,
      this.compareReferenceCanvas.width,
      this.compareReferenceCanvas.height,
    ).data;
    const processedPixels = this.compareProcessedContext.getImageData(
      0,
      0,
      this.compareProcessedCanvas.width,
      this.compareProcessedCanvas.height,
    ).data;
    const width = this.compareReferenceCanvas.width;
    const height = this.compareReferenceCanvas.height;
    let totalDiff = 0;
    let insidePixels = 0;
    let insideChanged = 0;
    let outsideChanged = 0;
    const sampledPixels = width * height;
    for (let index = 0; index < sampledPixels; index += 1) {
      const offset = index * 4;
      const redDiff = Math.abs((referencePixels[offset] ?? 0) - (processedPixels[offset] ?? 0));
      const greenDiff = Math.abs((referencePixels[offset + 1] ?? 0) - (processedPixels[offset + 1] ?? 0));
      const blueDiff = Math.abs((referencePixels[offset + 2] ?? 0) - (processedPixels[offset + 2] ?? 0));
      totalDiff += redDiff + greenDiff + blueDiff;
      const x = (index % width + 0.5) / width;
      const y = (Math.floor(index / width) + 0.5) / height;
      const inside = faceDistortionContains(geometry, x, y);
      const changed = Math.max(redDiff, greenDiff, blueDiff) > 8;
      if (inside) {
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

  private drawInto(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    treatment: ColorTreatment | null,
  ): void {
    context.save();
    context.filter = treatment?.cssFilter ?? 'none';
    context.drawImage(source, 0, 0, context.canvas.width, context.canvas.height);
    context.restore();
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
