/**
 * Effects are declarative data, not executable effect code
 * (see docs/adr/0004-declarative-effect-packages.md). A color treatment maps to
 * a single canvas filter string; the rigid mask is a bundled procedural effect
 * selected by id. One effect is active at a time.
 */

export type EffectId = 'none' | 'warm' | 'cool' | 'mono' | 'mask';

export interface ColorTreatment {
  /**
   * Bundled treatment id, or the complete-effect id for an imported package's
   * color treatment.
   */
  id: string;
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

/**
 * Canonical bundled selector ids/labels. `effects.ts` builds the behavioural
 * registry (`BUNDLED_EFFECT_DEFINITIONS`) from these labels plus the treatment
 * data, so the selector list is not duplicated; `getEffectLabel` is also the
 * output-policy fallback for a bundled id.
 */
export const EFFECT_OPTIONS: readonly EffectOption[] = [
  { id: 'none', label: 'No effect' },
  { id: 'mask', label: 'Rigid mask' },
  ...COLOR_TREATMENTS.map((treatment) => ({ id: treatment.id as EffectId, label: treatment.label })),
];

export function getTreatment(id: string): ColorTreatment | null {
  if (id === 'none' || id === 'mask') return null;
  return COLOR_TREATMENTS.find((treatment) => treatment.id === id) ?? null;
}

export function getEffectLabel(id: string): string {
  return EFFECT_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

/** True for the bundled rigid-mask effect (no color filter, needs a pose). */
export function isMaskEffect(id: string): boolean {
  return id === 'mask';
}
