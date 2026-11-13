/**
 * The active-effect registry shared by the renderer, the output policy and the
 * check harness. A complete effect is a single selectable definition that may
 * combine a rigid mask and a color treatment; there is deliberately no stacking
 * UI and no per-component selection (ADR-0004).
 */

import {
  buildTreatmentCssFilter,
  effectIdForPackage,
  type FaceDistortionParameters,
  type InstalledEffectPackage,
  type MaskAttachment,
} from './effect-package-contract';
import { COLOR_TREATMENTS, getEffectLabel, type ColorTreatment } from './treatments';

export type EffectSource = 'bundled' | 'package';

export type EffectMask =
  | { kind: 'bundled' }
  | { kind: 'gltf'; packageId: string; assetUrl: string; attachment: MaskAttachment };

export interface EffectDefinition {
  id: string;
  label: string;
  source: EffectSource;
  description: string;
  /** Declarative canvas filter for this complete effect, if any. */
  treatment: ColorTreatment | null;
  /** Bounded face distortion applied around the tracked face, if any. */
  distortion: FaceDistortionParameters | null;
  /** Rigid face-attached mask, bundled or from a package, if any. */
  mask: EffectMask | null;
  /** Package version, for diagnostics on imported effects. */
  packageVersion?: string;
  /** Import timestamp; a re-import changes it, forcing a mask asset reload. */
  packageRevision?: string;
}

export const NO_EFFECT_ID = 'none';
export const BUNDLED_MASK_ID = 'mask';
export const DEFAULT_EFFECT_ID = 'warm';

export const BUNDLED_EFFECT_DEFINITIONS: readonly EffectDefinition[] = [
  {
    id: NO_EFFECT_ID,
    label: getEffectLabel(NO_EFFECT_ID),
    source: 'bundled',
    description: 'Hides the processed output (the opaque paused screen) instead of passing the feed through.',
    treatment: null,
    distortion: null,
    mask: null,
  },
  {
    id: BUNDLED_MASK_ID,
    label: getEffectLabel(BUNDLED_MASK_ID),
    source: 'bundled',
    description: 'Bundled procedural low-poly helmet/visor attached to the tracked face.',
    treatment: null,
    distortion: null,
    mask: { kind: 'bundled' },
  },
  ...COLOR_TREATMENTS.map((treatment): EffectDefinition => ({
    id: treatment.id,
    label: treatment.label,
    source: 'bundled',
    description: treatment.description,
    treatment,
    distortion: null,
    mask: null,
  })),
];

/** Builds the selectable complete effect for one validated package. */
export function packageEffectDefinition(pkg: InstalledEffectPackage): EffectDefinition {
  const id = effectIdForPackage(pkg.id);
  return {
    id,
    label: pkg.name,
    source: 'package',
    description: pkg.description,
    treatment: pkg.treatment
      ? {
          id,
          label: pkg.name,
          description: pkg.description,
          cssFilter: buildTreatmentCssFilter(pkg.treatment),
        }
      : null,
    distortion: pkg.distortion,
    mask: pkg.mask
      ? {
          kind: 'gltf',
          packageId: pkg.id,
          assetUrl: pkg.mask.assetUrl,
          attachment: pkg.mask.attachment,
        }
      : null,
    packageVersion: pkg.version,
    packageRevision: pkg.importedAt,
  };
}

export function packageEffectDefinitions(packages: readonly InstalledEffectPackage[]): EffectDefinition[] {
  return packages.map((pkg) => packageEffectDefinition(pkg));
}

export function allEffectDefinitions(packages: readonly InstalledEffectPackage[]): EffectDefinition[] {
  return [...BUNDLED_EFFECT_DEFINITIONS, ...packageEffectDefinitions(packages)];
}

/**
 * Resolves a selected id. Returns null for an unknown/stale id so the renderer
 * can fall back to the explicit "No effect" paused output instead of rendering
 * an undefined effect.
 */
export function resolveEffect(
  id: string,
  packages: readonly InstalledEffectPackage[],
): EffectDefinition | null {
  return allEffectDefinitions(packages).find((effect) => effect.id === id) ?? null;
}

export interface EffectOption {
  id: string;
  label: string;
  source: EffectSource;
}

export interface EffectOptionGroup {
  label: string;
  options: EffectOption[];
}

/** Selector groups: bundled options first, imported packages second. */
export function effectOptionGroups(packages: readonly InstalledEffectPackage[]): EffectOptionGroup[] {
  const bundled: EffectOption[] = BUNDLED_EFFECT_DEFINITIONS.map((effect) => ({
    id: effect.id,
    label: effect.label,
    source: effect.source,
  }));
  const imported: EffectOption[] = packages.map((pkg) => ({
    id: effectIdForPackage(pkg.id),
    label: `${pkg.name} v${pkg.version}`,
    source: 'package',
  }));
  const groups: EffectOptionGroup[] = [{ label: 'Bundled effects', options: bundled }];
  if (imported.length > 0) groups.push({ label: 'Imported packages', options: imported });
  return groups;
}

/** True when the complete effect draws a face-attached mask. */
export function hasMask(effect: EffectDefinition): boolean {
  return effect.mask !== null;
}

/** True when the complete effect applies a color treatment. */
export function hasTreatment(effect: EffectDefinition): boolean {
  return effect.treatment !== null;
}

/** True when the complete effect declares a bounded face distortion. */
export function hasDistortion(effect: EffectDefinition): boolean {
  return effect.distortion !== null;
}
