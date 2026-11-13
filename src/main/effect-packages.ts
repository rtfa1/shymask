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

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

interface ImportMetadata {
  importedAt: string;
  sourceFileName: string;
}

function safeJoin(root: string, segments: readonly string[]): string | null {
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || /[\\/]/.test(segment)) return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
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
  constructor(
    readonly rootDir: string,
    private readonly assetUrlBase: string,
  ) {}

  /**
   * Re-reads and re-validates every stored package. A package that no longer
   * validates is ignored with a warning instead of being loaded.
   */
  list(): EffectPackageList {
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
        this.extractAssets(directory, validation.package.assets);
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
    const tempDirectory = path.join(this.rootDir, `.import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const targetDirectory = path.join(this.rootDir, manifest.id);
    try {
      mkdirSync(tempDirectory, { recursive: true });
      writeFileSync(path.join(tempDirectory, 'package.zip'), bytes);
      this.extractAssets(tempDirectory, validation.package.assets);
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
    return `Mask: ${complexity.triangles} triangles, ${complexity.meshes} mesh(es), ${complexity.materials} material(s); archive ${complexity.archiveBytes} bytes.`;
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

  /** Writes only the validated, declared asset entries under `<dir>/assets`. */
  private extractAssets(directory: string, assets: ReadonlyMap<string, Uint8Array>): void {
    const assetsRoot = path.join(directory, 'assets');
    rmSync(assetsRoot, { recursive: true, force: true });
    mkdirSync(assetsRoot, { recursive: true });
    for (const [name, data] of assets) {
      const target = safeJoin(directory, name.split('/'));
      if (!target) throw new Error(`Refusing to extract unsafe asset path "${name}".`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  }

  private rejected(message: string, issues: ImportEffectPackageResult['issues']): ImportEffectPackageResult {
    return { status: 'rejected', message, issues, list: this.list() };
  }

  private failed(message: string): ImportEffectPackageResult {
    return { status: 'failed', message, issues: [], list: this.list() };
  }
}
