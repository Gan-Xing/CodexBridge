import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const repoRoot = process.cwd();
const packageRoot = path.join(repoRoot, 'packages', 'codex-native-api');
const sourceRoot = path.join(packageRoot, 'src');
const legacyShimFiles = new Map([
  ['src/providers/codex/native_api_continuation_registry.ts', "export * from '../../../packages/codex-native-api/src/native_api_continuation_registry.js';"],
  ['src/providers/codex/native_api_server.ts', "export * from '../../../packages/codex-native-api/src/native_api_server.js';"],
  ['src/providers/codex/native_api_service.ts', "export * from '../../../packages/codex-native-api/src/native_api_service.js';"],
  ['src/providers/codex/native_api_side_task_router.ts', "export * from '../../../packages/codex-native-api/src/native_api_side_task_router.js';"],
  ['src/providers/codex/native_api_types.ts', "export * from '../../../packages/codex-native-api/src/native_api_types.js';"],
  ['src/providers/codex/native_runtime.ts', "export * from '../../../packages/codex-native-api/src/native_runtime.js';"],
]);
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const forbiddenPathParts = [
  `${path.sep}src${path.sep}core${path.sep}`,
  `${path.sep}src${path.sep}platforms${path.sep}`,
  `${path.sep}src${path.sep}runtime${path.sep}`,
  `${path.sep}src${path.sep}store${path.sep}`,
  `${path.sep}src${path.sep}i18n${path.sep}`,
  `${path.sep}src${path.sep}cli.ts`,
  `${path.sep}src${path.sep}providers${path.sep}codex${path.sep}`,
];

const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listTypeScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRelativeImport(fromFile, specifier) {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  if (path.extname(resolved)) {
    return resolved;
  }
  return `${resolved}.ts`;
}

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

const failures = [];

for (const file of listTypeScriptFiles(sourceRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const forbidden of forbiddenPathParts) {
    if (text.includes(forbidden.replaceAll(path.sep, '/')) || text.includes(forbidden)) {
      failures.push(`${path.relative(repoRoot, file)} references forbidden CodexBridge path ${forbidden}`);
    }
  }

  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) {
      continue;
    }
    if (specifier.startsWith('.')) {
      const resolved = resolveRelativeImport(file, specifier);
      if (!isInside(resolved, packageRoot)) {
        failures.push(`${path.relative(repoRoot, file)} imports outside package: ${specifier}`);
      }
      continue;
    }
    if (!nodeBuiltins.has(specifier)) {
      failures.push(`${path.relative(repoRoot, file)} imports external module: ${specifier}`);
    }
  }
}

for (const [relativePath, expectedContent] of legacyShimFiles) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing legacy Codex Native API shim: ${relativePath}`);
    continue;
  }
  const actualContent = normalizeText(fs.readFileSync(absolutePath, 'utf8'));
  if (actualContent !== expectedContent) {
    failures.push(
      `${relativePath} must remain a pure re-export shim pointing into packages/codex-native-api`,
    );
  }
}

if (failures.length > 0) {
  console.error('Codex Native API package boundary check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Codex Native API package boundary check passed.');
