/**
 * Persisted store for imported, validated effect packages.
 *
 * Each installed package lives under `<root>/<package-id>/` as:
 *   package.zip   the exact archive that was validated at import
 *   import.json   { importedAt, sourceFileName } (local metadata only)
 *   assets/...    the declared assets, extracted from the validated archive
 *
 * The archive is kept so the store re-validates with the same pure validator on
 * every launch (tamper detection, no drift between import and load). Extraction
 * writes only entries the validated manifest declared, and reuses the same
 * traversal guard as the asset protocol. The renderer only ever receives plain
 * descriptor data, never archive bytes or executable content.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateEffectPackage, type ValidatedEffectPackage } from '../core/effect-package';
import {
  DEFAULT_MASK_ATTACHMENT,
  PACKAGE_SAFETY_LIMITS,
  type EffectPackageList,
  type ImportEffectPackageResult,
  type InstalledEffectPackage,
  type RemoveEffectPackageResult,
} from '../core/effect-package-contract';
import { safeJoinForWrite } from './safe-path';

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const IMPORT_TEMP_PREFIX = '.import-';

interface ImportMetadata {
  importedAt: string;
  sourceFileName: string;
}

function readImportMetadata(directory: string): ImportMetadata {
  const file = path.join(directory, 'import.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ImportMetadata>;
    return {
      importedAt: typeof parsed.importedAt === 'string' ? parsed.importedAt : new Date(0).toISOString(),
      sourceFileName: typeof parsed.sourceFileName === 'string' ? parsed.sourceFileName : 'unknown.zip',
    };
  } catch {
    return { importedAt: new Date(0).toISOString(), sourceFileName: 'unknown.zip' };
  }
}

export class EffectPackageStore {
  /** Crash-leftover temp directories are removed once per store lifetime. */
  private cleanedStaleImports = false;

  constructor(
    readonly rootDir: string,
    private readonly assetUrlBase: string,
  ) {}

  /**
   * Re-reads and re-validates every stored package. A package that no longer
   * validates is ignored with a warning instead of being loaded. Declared
   * assets are extracted once at import; a list call only restores one whose
   * size no longer matches, so a normal list does not rewrite the extracted
   * files.
   */
  list(): EffectPackageList {
    this.cleanStaleImports();
    const warnings: string[] = [];
    const packages: InstalledEffectPackage[] = [];
    if (!existsSync(this.rootDir)) return { packages, warnings };
    let entries;
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch (cause) {
      return { packages, warnings: [`The effect-package store could not be read: ${(cause as Error).message}`] };
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PACKAGE_ID_PATTERN.test(entry.name)) continue;
      const directory = path.join(this.rootDir, entry.name);
      const archivePath = path.join(directory, 'package.zip');
      if (!existsSync(archivePath)) {
        warnings.push(`Imported effect "${entry.name}" is missing its stored archive and was ignored.`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(archivePath);
      } catch (cause) {
        warnings.push(`Imported effect "${entry.name}" could not be read: ${(cause as Error).message}`);
        continue;
      }
      const validation = validateEffectPackage(bytes);
      if (!validation.ok) {
        const first = validation.errors[0];
        warnings.push(
          `Imported effect "${entry.name}" failed revalidation and was ignored (${first?.code ?? 'invalid'}): ${first?.message ?? 'unknown error'}`,
        );
        continue;
      }
      if (validation.package.manifest.id !== entry.name) {
        warnings.push(
          `Imported effect "${entry.name}" declares a different id ("${validation.package.manifest.id}") and was ignored.`,
        );
        continue;
      }
      try {
        this.ensureAssets(directory, validation.package.assets);
      } catch (cause) {
        warnings.push(`Imported effect "${entry.name}" could not be staged: ${(cause as Error).message}`);
        continue;
      }
      packages.push(this.describe(directory, validation.package));
    }
    packages.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { packages, warnings };
  }

  importArchive(filePath: string): ImportEffectPackageResult {
    let bytes: Uint8Array;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) {
        return this.failed(`Import failed: ${filePath} is not a file.`);
      }
      if (stats.size > PACKAGE_SAFETY_LIMITS.maxArchiveBytes) {
        return this.rejected(
          `Import rejected (archive-too-large): the archive is ${stats.size} bytes; the safety limit is ${PACKAGE_SAFETY_LIMITS.maxArchiveBytes} bytes.`,
          [{ severity: 'error', code: 'archive-too-large', message: 'The package archive is larger than the import safety limit.' }],
        );
      }
      bytes = readFileSync(filePath);
    } catch (cause) {
      return this.failed(`Import failed: the selected file could not be read: ${(cause as Error).message}`);
    }

    const validation = validateEffectPackage(bytes);
    if (!validation.ok) {
      const first = validation.errors[0];
      const extra = validation.errors.length > 1 ? ` (${validation.errors.length - 1} more issue(s))` : '';
      return this.rejected(
        `Import rejected (${first?.code ?? 'invalid'}): ${first?.message ?? 'the package is invalid.'}${extra}`,
        validation.errors,
      );
    }

    const manifest = validation.package.manifest;
    const existed = existsSync(path.join(this.rootDir, manifest.id, 'package.zip'));
    const tempDirectory = path.join(
      this.rootDir,
      `${IMPORT_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const targetDirectory = path.join(this.rootDir, manifest.id);
    try {
      mkdirSync(tempDirectory, { recursive: true });
      writeFileSync(path.join(tempDirectory, 'package.zip'), bytes);
      this.ensureAssets(tempDirectory, validation.package.assets);
      const metadata: ImportMetadata = {
        importedAt: new Date().toISOString(),
        sourceFileName: path.basename(filePath),
      };
      writeFileSync(path.join(tempDirectory, 'import.json'), `${JSON.stringify(metadata, null, 2)}\n`);
      rmSync(targetDirectory, { recursive: true, force: true });
      renameSync(tempDirectory, targetDirectory);
    } catch (cause) {
      rmSync(tempDirectory, { recursive: true, force: true });
      return this.failed(`Import failed while storing the validated package: ${(cause as Error).message}`);
    }

    const installed = this.describe(targetDirectory, validation.package);
    const list = this.list();
    const warnings = [...validation.package.warnings.map((warning) => `${warning.code}: ${warning.message}`), ...list.warnings];
    return {
      status: 'imported',
      message: `${existed ? 'Replaced' : 'Imported'} "${manifest.name}" v${manifest.version} (${manifest.id}) from ${path.basename(filePath)}. ${this.describeComplexity(installed)}`,
      issues: validation.package.warnings,
      package: installed,
      list: { packages: list.packages, warnings },
    };
  }

  remove(id: string): RemoveEffectPackageResult {
    if (typeof id !== 'string' || !PACKAGE_ID_PATTERN.test(id)) {
      return { removed: false, message: 'Remove failed: invalid package id.', list: this.list() };
    }
    const directory = path.join(this.rootDir, id);
    if (!existsSync(directory)) {
      return { removed: false, message: `The imported effect "${id}" is not installed.`, list: this.list() };
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cause) {
      return { removed: false, message: `Remove failed: ${(cause as Error).message}`, list: this.list() };
    }
    return {
      removed: true,
      message: `Removed the imported effect "${id}". The output returns to the no-effect paused screen unless another effect is selected.`,
      list: this.list(),
    };
  }

  private describeComplexity(installed: InstalledEffectPackage): string {
    const complexity = installed.complexity;
    const distortion = installed.distortion ? `face distortion ${installed.distortion.mode}` : 'no face distortion';
    const motion = installed.secondaryMotion
      ? `${installed.secondaryMotion.parts.length} movable part(s)`
      : 'no movable parts';
    return `Mask: ${complexity.triangles} triangles, ${complexity.meshes} mesh(es), ${complexity.materials} material(s); ${distortion}; ${motion}; archive ${complexity.archiveBytes} bytes.`;
  }

  private describe(directory: string, validated: ValidatedEffectPackage): InstalledEffectPackage {
    const manifest = validated.manifest;
    const metadata = readImportMetadata(directory);
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      treatment: manifest.colorTreatment ?? null,
      distortion: manifest.faceDistortion ?? null,
      secondaryMotion: manifest.secondaryMotion ?? null,
      mask: manifest.mask
        ? {
            asset: manifest.mask.asset,
            assetUrl: `${this.assetUrlBase}/${manifest.id}/${manifest.mask.asset}`,
            attachment: manifest.mask.attachment ?? DEFAULT_MASK_ATTACHMENT,
          }
        : null,
      complexity: validated.complexity,
      importedAt: metadata.importedAt,
      sourceFileName: metadata.sourceFileName,
    };
  }

  /**
   * Ensures the validated, declared asset entries exist under `<dir>/assets`.
   * Extraction happens once at import; a list/revalidation only restores an
   * asset whose size no longer matches (missing, truncated or replaced), so a
   * normal call never rewrites the store.
   */
  private ensureAssets(directory: string, assets: ReadonlyMap<string, Uint8Array>): void {
    const assetsRoot = path.join(directory, 'assets');
    mkdirSync(assetsRoot, { recursive: true });
    for (const [name, data] of assets) {
      const target = safeJoinForWrite(directory, name.split('/'));
      if (!target) throw new Error(`Refusing to extract unsafe asset path "${name}".`);
      mkdirSync(path.dirname(target), { recursive: true });
      let existingBytes = -1;
      try {
        existingBytes = statSync(target).size;
      } catch {
        // Missing assets are written below.
      }
      if (existingBytes === data.length) continue;
      writeFileSync(target, data);
    }
    // A re-import may declare a different asset file; drop anything else so the
    // store keeps exactly the validated, declared assets.
    const declared = new Set([...assets.keys()].map((name) => path.basename(name)));
    for (const entry of readdirSync(assetsRoot, { withFileTypes: true })) {
      if (entry.isFile() && declared.has(entry.name)) continue;
      rmSync(path.join(assetsRoot, entry.name), { recursive: true, force: true });
    }
  }

  /**
   * Removes `.import-*` directories left by a crash between temp creation and
   * the atomic rename. The store is single-process, so any such directory at
   * first use is stale rather than an in-flight import.
   */
  private cleanStaleImports(): void {
    if (this.cleanedStaleImports) return;
    this.cleanedStaleImports = true;
    if (!existsSync(this.rootDir)) return;
    let entries;
    try {
      entries = readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(IMPORT_TEMP_PREFIX)) continue;
      try {
        rmSync(path.join(this.rootDir, entry.name), { recursive: true, force: true });
      } catch {
        // A stale temp directory that cannot be removed is reported by the
        // normal store warnings only if it later affects an import.
      }
    }
  }

  private rejected(message: string, issues: ImportEffectPackageResult['issues']): ImportEffectPackageResult {
    return { status: 'rejected', message, issues, list: this.list() };
  }

  private failed(message: string): ImportEffectPackageResult {
    return { status: 'failed', message, issues: [], list: this.list() };
  }
}
