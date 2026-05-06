import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const repoRoot = process.cwd();
const packageRoot = path.join(repoRoot, 'packages', 'codex-gateway');
const sourceRoot = path.join(packageRoot, 'src');
const legacyShimFiles = new Map([
  ['src/providers/openai_compatible/responses_adapter.ts', "export * from '../../../packages/codex-gateway/src/converters/responses_adapter.js';"],
  ['src/providers/openai_compatible/responses_adapter_server.ts', "export * from '../../../packages/codex-gateway/src/server/responses_adapter_server.js';"],
  ['src/providers/openai_compatible/capability_presets.ts', "export * from '../../../packages/codex-gateway/src/capabilities/capability_presets.js';"],
  ['src/providers/shared/thinking_policy.ts', "export * from '../../../packages/codex-gateway/src/capabilities/thinking_policy.js';"],
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
];

const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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
    failures.push(`missing legacy Codex Gateway shim: ${relativePath}`);
    continue;
  }
  const actualContent = normalizeText(fs.readFileSync(absolutePath, 'utf8'));
  if (actualContent !== expectedContent) {
    failures.push(
      `${relativePath} must remain a pure re-export shim pointing into packages/codex-gateway`,
    );
  }
}

if (failures.length > 0) {
  console.error('Codex Gateway package boundary check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Codex Gateway package boundary check passed.');
