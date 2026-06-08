/**
 * Verifies all relative imports in the published package resolve to real files.
 * Catches "Cannot find module" errors from missing files in the npm tarball.
 *
 * Usage:
 *   node scripts/check-extensions.mjs           # from source (uses npm pack --dry-run)
 *   node scripts/check-extensions.mjs <dir>     # from installed location
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";

const installDir = resolve(process.argv[2] ?? ".");
const fromSource = process.argv[2] == null;

function getFiles() {
  const isSource = (f) =>
    f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mjs");
  if (fromSource) {
    // Use npm pack --dry-run to get exactly the files that would be published.
    // pi-lens ships compiled .js (dist/), so .js must be checked too — not just
    // the .ts/.mjs we used to ship.
    const out = execSync("npm pack --dry-run 2>&1", { encoding: "utf8" });
    return out
      .split("\n")
      .map(l => l.match(/npm notice [\d.]+\w+\s+(.+)/)?.[1]?.trim())
      .filter(f => f && isSource(f))
      .map(f => join(installDir, f));
  }
  // Installed location: walk all .ts/.js/.mjs files
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (isSource(entry)) files.push(full);
    }
  }
  walk(installDir);
  return files;
}

function resolveImport(fromFile, importPath) {
  const base = join(dirname(fromFile), importPath);
  for (const candidate of [
    base,
    base.replace(/\.js$/, ".ts"),   // .js → .ts (TypeScript ESM convention)
    base + ".ts",
    join(base, "index.ts"),
  ]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

const files = getFiles();
console.log(`Checking ${files.length} file(s) in: ${installDir}\n`);

let totalImports = 0;
let failed = 0;
const seen = new Set();

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const relFile = file.slice(installDir.length + 1).replace(/\\/g, "/");
  // Strip comments before matching imports
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(stripped)) !== null) {
    const importPath = match[1];
    const key = `${relFile}:${importPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totalImports++;
    if (!resolveImport(file, importPath)) {
      console.error(`  ✗ ${relFile}`);
      console.error(`      imports '${importPath}' → NOT FOUND`);
      failed++;
    }
  }
}

console.log(`Checked ${totalImports} relative import(s) across ${files.length} file(s).`);
console.log(failed === 0
  ? `\nAll imports resolve OK ✓`
  : `\n${failed} import(s) could not be resolved ✗`);

process.exit(failed > 0 ? 1 : 0);
