import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME_ROOTS = ["clients", "commands"];
const RUNTIME_FILES = ["index.ts"];

function walkTsFiles(dir: string, files: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "tests") continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkTsFiles(fullPath, files);
			continue;
		}
		if (entry.isFile() && fullPath.endsWith(".ts")) {
			files.push(fullPath);
		}
	}
}

function getRuntimeFiles(): string[] {
	const files: string[] = [];
	for (const root of RUNTIME_ROOTS) {
		walkTsFiles(path.join(REPO_ROOT, root), files);
	}
	for (const file of RUNTIME_FILES) {
		files.push(path.join(REPO_ROOT, file));
	}
	return files;
}

function getBareImports(filePath: string): string[] {
	const source = fs.readFileSync(filePath, "utf8");
	const matches = source.matchAll(
		/(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g,
	);
	const imports: string[] = [];
	for (const match of matches) {
		const specifier = match[1] || match[2];
		if (!specifier) continue;
		if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
			continue;
		}
		if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/i.test(specifier)) {
			continue;
		}
		imports.push(specifier);
	}
	return imports;
}

function toPackageName(specifier: string): string {
	if (specifier.startsWith("@")) {
		return specifier.split("/").slice(0, 2).join("/");
	}
	return specifier.split("/")[0];
}

describe("runtime dependency manifest", () => {
	it("declares every bare runtime import outside devDependencies", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};

		const declared = new Set<string>([
			...Object.keys(packageJson.dependencies ?? {}),
			...Object.keys(packageJson.optionalDependencies ?? {}),
			...Object.keys(packageJson.peerDependencies ?? {}),
		]);

		const missing = new Map<string, Set<string>>();
		for (const filePath of getRuntimeFiles()) {
			for (const specifier of getBareImports(filePath)) {
				const pkgName = toPackageName(specifier);
				if (declared.has(pkgName)) continue;
				const existing = missing.get(pkgName) ?? new Set<string>();
				existing.add(path.relative(REPO_ROOT, filePath));
				missing.set(pkgName, existing);
			}
		}

		expect(
			[...missing.entries()].map(([pkgName, files]) => ({
				pkgName,
				files: [...files].sort(),
			})),
		).toEqual([]);
	});
});
