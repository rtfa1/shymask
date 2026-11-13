import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { TrackerInfo } from '../core/bridge';
import { poseFromColumnMajorMatrix, TRACKING_LIMITS, type TrackingSample } from '../core/tracking';

export interface DetectedTracking extends TrackingSample {
  /** First face bounding box in normalized frame coordinates. */
  faceBbox: { x: number; y: number; width: number; height: number } | null;
  /** MediaPipe facial transformation matrix (column-major) for the first face. */
  matrix: number[] | null;
}

/**
 * MediaPipe logs this informational line through console.error. The check
 * harness treats renderer console errors as failures, and this line is not an
 * error, so only that exact informational prefix is suppressed. Every other
 * console error still reaches the console and the check.
 */
const INFORMATIONAL_LOG_PREFIXES = ['INFO: Created TensorFlow Lite'];
let logFilterInstalled = false;

function installInformationalLogFilter(): void {
  if (logFilterInstalled) return;
  logFilterInstalled = true;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const text = args.map((value) => String(value)).join(' ');
    if (INFORMATIONAL_LOG_PREFIXES.some((prefix) => text.startsWith(prefix))) return;
    originalError(...args);
  };
}

/**
 * Thin wrapper around the MediaPipe Face Landmarker. It owns the model/runtime
 * lifetime and converts one detection into the plain sample the portable
 * tracking state machine consumes. The tracker never touches camera APIs: the
 * only source is the validated replay <video> element. One tracker lives for the
 * renderer process lifetime, so its resources are released when the window is
 * torn down and the class exposes no separate teardown path.
 */
export class FaceTracker {
  private constructor(private readonly landmarker: FaceLandmarker) {}

  static async create(info: TrackerInfo): Promise<FaceTracker> {
    if (info.state !== 'ready' || !info.wasmBaseUrl || !info.modelUrl) {
      throw new Error(info.message ?? 'Face-tracker assets are unavailable.');
    }
    installInformationalLogFilter();
    const fileset = await FilesetResolver.forVisionTasks(info.wasmBaseUrl);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: info.modelUrl, delegate: 'GPU' },
      runningMode: 'VIDEO',
      // Two faces are requested on purpose: the policy needs to distinguish
      // exactly one face from more than one, and the second face must be
      // detected rather than silently ignored.
      numFaces: 2,
      minFaceDetectionConfidence: TRACKING_LIMITS.minFaceDetectionConfidence,
      minFacePresenceConfidence: TRACKING_LIMITS.minFacePresenceConfidence,
      minTrackingConfidence: TRACKING_LIMITS.minTrackingConfidence,
      outputFacialTransformationMatrixes: true,
    });
    return new FaceTracker(landmarker);
  }

  /**
   * Runs one VIDEO-mode inference for the current replay frame. `timestampMs`
   * must be monotonically increasing across loop seams; the replay clock's
   * loop-aware processing timestamp provides that.
   */
  detect(video: HTMLVideoElement, timestampMs: number): DetectedTracking {
    const frame = this.landmarker.detectForVideo(video, timestampMs);
    const faces = frame.faceLandmarks;
    const first = faces[0];
    const matrixData = frame.facialTransformationMatrixes?.[0]?.data;
    const matrix = matrixData ? Array.from(matrixData) : null;
    const pose = matrix ? poseFromColumnMajorMatrix(matrix) : null;
    let faceBbox: DetectedTracking['faceBbox'] = null;
    if (first && first.length > 0) {
      let minX = 1;
      let minY = 1;
      let maxX = 0;
      let maxY = 0;
      for (const point of first) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      faceBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return {
      faceCount: faces.length,
      landmarkCount: first?.length ?? 0,
      hasTransform: matrix !== null,
      faceWidthRatio: faceBbox?.width ?? 0,
      pose,
      faceBbox,
      matrix,
    };
  }
}
