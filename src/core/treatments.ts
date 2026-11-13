/**
 * Color treatments are declarative data, not executable effect code
 * (see docs/adr/0004-declarative-effect-packages.md). Each entry maps to a
 * single canvas filter string applied to the same replay frame that later
 * slices will feed from a physical camera and publish to the virtual webcam.
 */

export type EffectId = 'none' | 'warm' | 'cool' | 'mono';

export interface ColorTreatment {
  id: Exclude<EffectId, 'none'>;
  label: string;
  description: string;
  /** CSS filter expression applied while drawing the frame. */
  cssFilter: string;
}

export const COLOR_TREATMENTS: readonly ColorTreatment[] = [
  {
    id: 'warm',
    label: 'Warm tint',
    description: 'Amber shift with lifted saturation.',
    cssFilter: 'sepia(0.55) saturate(1.6) contrast(1.05) brightness(1.02)',
  },
  {
    id: 'cool',
    label: 'Cool tint',
    description: 'Blue shift produced by rotating a sepia base.',
    cssFilter: 'sepia(0.55) hue-rotate(170deg) saturate(1.8) brightness(1.02)',
  },
  {
    id: 'mono',
    label: 'Monochrome',
    description: 'Grayscale with added contrast.',
    cssFilter: 'grayscale(1) contrast(1.2)',
  },
];

export interface EffectOption {
  id: EffectId;
  label: string;
}

export const EFFECT_OPTIONS: readonly EffectOption[] = [
  { id: 'none', label: 'No effect' },
  ...COLOR_TREATMENTS.map((treatment) => ({ id: treatment.id, label: treatment.label })),
];

export function getTreatment(id: EffectId): ColorTreatment | null {
  if (id === 'none') return null;
  return COLOR_TREATMENTS.find((treatment) => treatment.id === id) ?? null;
}

export function getEffectLabel(id: EffectId): string {
  return EFFECT_OPTIONS.find((option) => option.id === id)?.label ?? id;
}
