import type { MaskAttachment } from './effect-package-contract';

/**
 * Renderer transform for a validated mask attachment.
 *
 * Validation bounds the values in centimetres/degrees; this pure conversion is
 * the single place that turns the declarative manifest numbers into the units
 * Three.js expects (radians), so the attachment behavior can be unit-tested
 * without a WebGL context.
 */
export interface MaskAttachmentTransform {
  position: readonly [number, number, number];
  /** Euler rotation in radians, three.js XYZ order. */
  rotationRad: readonly [number, number, number];
  scale: number;
}

export function maskAttachmentTransform(attachment: MaskAttachment): MaskAttachmentTransform {
  const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  return {
    position: attachment.position,
    rotationRad: [
      degreesToRadians(attachment.rotationDeg[0]),
      degreesToRadians(attachment.rotationDeg[1]),
      degreesToRadians(attachment.rotationDeg[2]),
    ],
    scale: attachment.scale,
  };
}
