/**
 * File Role Classification for pi-lens
 *
 * Classifies files by their structural role in the project so runners
 * can skip checks that don't apply (e.g. no complexity checks on generated
 * files, no logic-density checks on re-export barrels).
 */

import { basename, dirname, win32 } from "node:path";
import { isGeneratedOrArtifact } from "./generated-artifacts.js";
import { isWindowsPath } from "./path-utils.js";

// --- Types ---

export type FileRole =
	| "source" // Regular application source
	| "test" // Test / spec file
	| "init" // Module entry point (index.ts, __init__.py, mod.rs)
	| "re-export" // Pure re-export barrel (only export * / export { } from)
	| "generated" // Auto-generated code — do not lint
	| "config" // Build / tool configuration
	| "stub" // Type-only declaration file (.d.ts or interface-heavy)
	| "migration"; // Database migration

// --- Detection ---

const RE_EXPORT_LINE =
	/^export\s+(type\s+)?\*\s+from\s+|^export\s*\{[^}]*\}\s+from\s+/;

function isReExportBarrel(content: string): boolean {
	const lines = content
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(
			(l) =>
				l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
		);
	return lines.length > 0 && lines.every((l) => RE_EXPORT_LINE.test(l));
}

function isTypeStub(content: string): boolean {
	const lines = content
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(
			(l) =>
				l &&
				!l.startsWith("//") &&
				!l.startsWith("*") &&
				!l.startsWith("/*") &&
				l !== "{" &&
				l !== "}",
		);
	if (lines.length < 4) return false;
	const typeOnlyLines = lines.filter(
		(l) =>
			/^(export\s+)?(interface|type|abstract\s+class|declare\s+(class|function|const|var|let|module|namespace|enum))\s+/.test(
				l,
			) ||
			/^(import\s+type\s+|import\s+\{)/.test(l) ||
			/^export\s+type\s+\{/.test(l),
	);
	return typeOnlyLines.length / lines.length >= 0.75;
}

/**
 * Classify the structural role of a file. Pass `content` for higher
 * accuracy (enables generated-code detection, barrel detection, etc.).
 *
 * `detectFileRole` is platform-native by design — normal same-OS paths
 * (POSIX on Linux, win32 on Windows) go through the module-default
 * `basename`/`dirname`, unchanged from before. But a WINDOWS-SHAPED path
 * (drive letter or UNC prefix, per `isWindowsPath`) is parsed with
 * `path.win32.basename`/`dirname` regardless of the running OS (refs #1152,
 * the #1150 class): on Linux the module-default `dirname` finds no `/` in a
 * `C:\...` path, collapses to `"."`, and the dir-based branches below
 * (`/tests/`, `/spec/`, …) silently misclassify. On win32 this branch is a
 * no-op — `win32.basename`/`dirname` already equal the module default there
 * — so native Windows classification is unchanged.
 */
export function detectFileRole(filePath: string, content?: string): FileRole {
	const windowsShaped = isWindowsPath(filePath);
	const rawBase = windowsShaped ? win32.basename(filePath) : basename(filePath);
	const base = rawBase.toLowerCase();
	const dir = (windowsShaped ? win32.dirname(filePath) : dirname(filePath))
		.replace(/\\/g, "/")
		.toLowerCase();

	// --- Test ---
	// Suffix conventions informed by the test-runner table
	// (SOURCE_TO_TEST_PATTERNS + RUNNERS kinds in
	// clients/test-runner-client.ts); hand-written, not iterated from it —
	// see #2928 for the single-classifier fold:
	// - `_test.` infix: Go (`*_test.go`), pytest (`*_test.py`), ExUnit
	//   (`*_test.exs`), Dart (`*_test.dart`). The underscore anchor keeps
	//   this precise: `contest.py` and `latest.ts` do not match.
	// - `_spec.` infix: RSpec (`*_spec.rb`).
	// - CamelCase `*Test(s).<ext>` suffix, matched case-SENSITIVELY on the
	//   raw basename: JUnit/Surefire (`*Test.java`, `*TestCase.java`),
	//   Kotlin (`*Test.kt`), dotnet (`*Test.cs`/`*Tests.cs`), PHPUnit
	//   (`*Test.php`). Case matters: Surefire's `*Test.java` does not match
	//   `contest.java`, so neither do we.
	if (
		base.includes(".test.") ||
		base.includes(".spec.") ||
		base.includes("_test.") ||
		base.includes("_spec.") ||
		base.startsWith("test_") ||
		base.startsWith("spec_") ||
		/(Test|Tests|TestCase)\.(java|kt|kts|cs|fs|php)$/.test(rawBase) ||
		dir.includes("/__tests__/") ||
		dir.includes("/test/") ||
		dir.includes("/tests/") ||
		dir.includes("/spec/") ||
		dir.includes("/specs/") ||
		/[/_-]tests?\/?$/.test(dir) ||
		/[/_-]specs?\/?$/.test(dir)
	)
		return "test";

	// --- Generated/artifact markers (path/name/header-based) ---
	if (
		isGeneratedOrArtifact(filePath, { content, includeDeclarations: false })
	) {
		return "generated";
	}

	// --- Migrations ---
	// Normalize separators before regex so the pattern works on Windows too
	const forwardDir = dir.replace(/\\/g, "/");
	if (
		forwardDir.includes("/migrations/") ||
		forwardDir.includes("/migration/") ||
		/\/\d{4,}_[a-z]/.test(forwardDir + "/" + base)
	)
		return "migration";

	// --- Config ---
	if (
		base.endsWith(".config.ts") ||
		base.endsWith(".config.js") ||
		base.endsWith(".config.mjs") ||
		base.endsWith(".config.cjs") ||
		base === "vite.config.ts" ||
		base === "jest.config.ts" ||
		base === "jest.config.js" ||
		base === "webpack.config.js" ||
		base === "rollup.config.js" ||
		base === "tailwind.config.js" ||
		base === "tailwind.config.ts" ||
		base === "next.config.js" ||
		base === "next.config.mjs"
	)
		return "config";

	// --- Type stubs ---
	if (base.endsWith(".d.ts")) return "stub";
	if (content && isTypeStub(content)) return "stub";

	// --- Init / barrel ---
	const isIndexFile =
		base === "index.ts" ||
		base === "index.tsx" ||
		base === "index.js" ||
		base === "index.mjs" ||
		base === "index.cjs" ||
		base === "index.jsx" ||
		base === "__init__.py" ||
		base === "mod.rs";

	if (isIndexFile) {
		if (content && isReExportBarrel(content)) return "re-export";
		return "init";
	}

	return "source";
}
