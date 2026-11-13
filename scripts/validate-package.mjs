#!/usr/bin/env node
/**
 * Creator/AI-harness entry point: validates one effect package with the same
 * pure validator the app imports with, and prints the structured result.
 *
 *   npm run build
 *   npm run validate:package -- fixtures/packages/guard-visor.zip
 *
 * Exits 0 for a valid package, 1 for a rejected package, 2 for usage/setup
 * errors. This is intentionally read-only: it does not install the package.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fileArgument = process.argv[2];
if (!fileArgument) {
  console.error('usage: npm run validate:package -- <path-to-effect-package.zip>');
  process.exit(2);
}
const compiledValidator = path.join(root, 'dist', 'src', 'core', 'effect-package.js');
if (!existsSync(compiledValidator)) {
  console.error('The compiled validator is missing. Run `npm run build` first.');
  process.exit(2);
}
const file = path.resolve(fileArgument);
if (!existsSync(file)) {
  console.error(`No such package file: ${file}`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { validateEffectPackage } = require(compiledValidator);

const result = validateEffectPackage(readFileSync(file));
if (result.ok) {
  const pkg = result.package;
  console.log(
    JSON.stringify(
      {
        ok: true,
        file,
        package: {
          id: pkg.manifest.id,
          name: pkg.manifest.name,
          version: pkg.manifest.version,
          schemaVersion: pkg.manifest.schemaVersion,
          effect: {
            mask: pkg.manifest.mask ?? null,
            faceDistortion: pkg.manifest.faceDistortion ?? null,
            secondaryMotion: pkg.manifest.secondaryMotion ?? null,
            colorTreatment: pkg.manifest.colorTreatment ?? null,
          },
          assets: [...pkg.assets.keys()],
          complexity: pkg.complexity,
        },
        warnings: pkg.warnings,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
console.log(
  JSON.stringify(
    {
      ok: false,
      file,
      errors: result.errors,
      warnings: result.warnings,
    },
    null,
    2,
  ),
);
process.exit(1);
