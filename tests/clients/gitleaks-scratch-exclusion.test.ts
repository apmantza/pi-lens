/**
 * #1562: gitleaks scanned gitignored scratch (`.pi/greedysearch-sources/`,
 * a pi-ecosystem web-research cache) and served a placeholder curl-doc-example
 * (`-H "Authorization: Bearer YOUR_API_KEY"`) to the agent as a leaked secret.
 *
 * Compounding defects, covered here:
 *   1. Scope: gitleaks's own tree walk (`--source <dir>`) bypassed pi-lens's
 *      shared scratch-tree exclusion because it never routes through
 *      pi-lens's own walker — the generated `--config` (`writeScopedGitleaksConfig`)
 *      and the TS-side backstop (`classifyAndFilterFindings`) both close that gap.
 *   2. Placeholder recognition: `YOUR_API_KEY`-class values must be allowlisted
 *      even OUTSIDE scratch trees (a placeholder in a tracked example file is
 *      just as much a non-finding).
 *
 * The over-correction pin (#1562 design note): an untracked `.env` with a
 * REAL-shaped secret must still be reported — the fix must not become a
 * blanket "respect .gitignore".
 *
 * Review-round fixes folded in here (#1562 second pass):
 *   - F1: the secrets-lane exclusion is the NARROW `SECRETS_LANE_SCRATCH_DIR_NAMES`
 *     tier, not the broad walker-parity `EXCLUDED_DIRS` list — a probe seeded a
 *     real-AWS-shaped secret in 9 walker-only dirs (`dist/`, `vendor/`,
 *     `.vscode/`, `build/`, `out/`, `target/`, `third_party/`, `third-party/`,
 *     `coverage/`) and found the first cut silently dropping all 9.
 *   - F2: a secrets-lane-scratch finding is DEMOTED (`pathStatus: "scratch"`,
 *     surfaced by the adapter as `severity: "info"`/`semantic: "none"`), never
 *     silently DELETED — the observability criterion requires the fourth value
 *     to be reachable.
 *   - F3: the placeholder allowlist's angle-bracket regex now matches the
 *     issue's own literal example, bare `<your-key>` (not just `<your-api-key>`),
 *     and the `xxx` run-of-x regex now matches the issue's literal 3-x example.
 *   - F4: the generated allowlist path regexes accept BOTH `/` and `\`
 *     separators (gitleaks's `File` field preserves the OS-native separator
 *     from Go's directory walk, so a forward-slash-only anchor never matches
 *     on Windows).
 */
import { execFileSync } from "../support/git-fixture-env.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetTrackedFilesCacheForTests } from "../../clients/git-tracked-ignore.js";
import {
	classifyAndFilterFindings,
	type GitleaksFinding,
	PLACEHOLDER_SECRET_REGEXES,
	writeScopedGitleaksConfig,
} from "../../clients/gitleaks-client.js";
import { gitleaksFindingToProjectDiagnostic } from "../../clients/project-diagnostics/runner-adapters/gitleaks.js";
import { getSecretsLaneAllowlistPaths } from "../../clients/scratch-tree-policy.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

function initGitRepo(cwd: string): void {
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
}

function finding(overrides: Partial<GitleaksFinding>): GitleaksFinding {
	return {
		ruleId: "generic-api-key",
		file: "src/config.ts",
		startLine: 1,
		...overrides,
	};
}

beforeEach(() => {
	_resetTrackedFilesCacheForTests();
});
afterEach(() => {
	_resetTrackedFilesCacheForTests();
});

describe("classifyAndFilterFindings — secrets-lane scratch exclusion (#1562)", () => {
	it("demotes (does not delete) a finding under .pi/greedysearch-sources/** (the doc-example fixture from the incident)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-scratch-");
		try {
			const findings = [
				finding({
					file: ".pi/greedysearch-sources/cline-api-docs.md",
					secret: "YOUR_API_KEY",
					match: '-H "Authorization: Bearer YOUR_API_KEY"',
				}),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("scratch");
		} finally {
			env.cleanup();
		}
	});

	it("demotes findings under other pi-ecosystem/agent scratch trees (.claude/, node_modules/)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-scratch2-");
		try {
			const findings = [
				finding({ file: ".claude/scratch/notes.md" }),
				finding({ file: "node_modules/some-pkg/README.md" }),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(2);
			expect(result.every((f) => f.pathStatus === "scratch")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// #1562 review-round F1 pin: these 9 dirs are WALKER-ONLY exclusions (real
	// leak surfaces — build output, vendored source, editor config), NOT
	// secrets-lane scratch. A finding under any of them must survive with
	// normal (non-"scratch") classification, exactly like an ordinary source
	// file.
	it("does NOT demote findings under walker-only dirs (dist/vendor/.vscode/build/out/target/third_party/third-party/coverage)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-walkeronly-");
		try {
			initGitRepo(env.tmpDir);
			const walkerOnlyPaths = [
				"dist/config.js",
				"vendor/lib/keys.go",
				".vscode/launch.json",
				"build/bundle.js",
				"out/main.js",
				"target/release/config.rs",
				"third_party/lib/secrets.py",
				"third-party/lib/secrets.py",
				"coverage/lcov-report/index.html",
			];
			const findings = walkerOnlyPaths.map((file) => finding({ file }));
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(walkerOnlyPaths.length);
			for (const f of result) {
				expect(f.pathStatus).not.toBe("scratch");
			}
		} finally {
			env.cleanup();
		}
	});

	it("keeps a finding in an untracked operational .env with a real-shaped secret (over-correction pin)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-env-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(
				path.join(env.tmpDir, ".env"),
				"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
			);
			// .env is untracked (never committed) — the exact case gitleaks must
			// still catch. No .gitignore entry either, so it's plain-untracked.
			const findings = [
				finding({
					file: ".env",
					ruleId: "aws-secret-key",
					secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				}),
			];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].file).toBe(".env");
			expect(result[0].pathStatus).toBe("untracked");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a finding in an untracked-but-gitignored .env and labels it 'ignored', not 'scratch'", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-env-ignored-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(path.join(env.tmpDir, ".gitignore"), ".env\n");
			execFileSync("git", ["add", ".gitignore"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "add gitignore"], {
				cwd: env.tmpDir,
			});
			fs.writeFileSync(
				path.join(env.tmpDir, ".env"),
				"SOME_SERVICE_SECRET=not-a-real-secret-just-test-fixture-data\n",
			);
			const findings = [finding({ file: ".env", ruleId: "stripe-key" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("ignored");
		} finally {
			env.cleanup();
		}
	});

	it("labels a finding inside a nested repository without claiming it for the parent", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-nested-repo-");
		try {
			initGitRepo(env.tmpDir);
			const nested = path.join(env.tmpDir, "submodule");
			fs.mkdirSync(nested, { recursive: true });
			initGitRepo(nested);
			fs.writeFileSync(path.join(nested, ".env"), "SECRET=real-shaped-value\n");

			const result = await classifyAndFilterFindings(
				[finding({ file: "submodule/.env" })],
				env.tmpDir,
			);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("nested-repository");
		} finally {
			env.cleanup();
		}
	});

	it("labels a tracked finding 'tracked'", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-tracked-");
		try {
			initGitRepo(env.tmpDir);
			fs.writeFileSync(
				path.join(env.tmpDir, "config.ts"),
				"export const key = 'placeholder';\n",
			);
			execFileSync("git", ["add", "config.ts"], { cwd: env.tmpDir });
			execFileSync("git", ["commit", "-q", "-m", "add config"], {
				cwd: env.tmpDir,
			});
			const findings = [finding({ file: "config.ts" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBe("tracked");
		} finally {
			env.cleanup();
		}
	});

	it("leaves pathStatus undefined (fail-open) when git degrades (no repo)", async () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-nogit-");
		try {
			// No `git init` — git ls-files fails, both sets resolve undefined.
			const findings = [finding({ file: "config.ts" })];
			const result = await classifyAndFilterFindings(findings, env.tmpDir);
			expect(result).toHaveLength(1);
			expect(result[0].pathStatus).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("gitleaksFindingToProjectDiagnostic — pathStatus observability (#1562)", () => {
	it("appends the git status to the diagnostic message when pathStatus is set", () => {
		const diag = gitleaksFindingToProjectDiagnostic(
			"/repo",
			finding({ file: ".env", pathStatus: "untracked" }),
		);
		expect(diag.message).toContain("[git: untracked]");
	});

	it("omits the status suffix when pathStatus is undefined (git degraded)", () => {
		const diag = gitleaksFindingToProjectDiagnostic("/repo", finding({}));
		expect(diag.message).not.toContain("[git:");
	});

	// #1562 review-round F2: a demoted "scratch" finding must never read as a
	// blocking secret alarm, while still being present (reachable) for an
	// audit read.
	it("demotes a pathStatus:'scratch' finding to info/none, never blocking", () => {
		const diag = gitleaksFindingToProjectDiagnostic(
			"/repo",
			finding({
				file: ".pi/greedysearch-sources/doc.md",
				pathStatus: "scratch",
			}),
		);
		expect(diag.severity).toBe("info");
		expect(diag.semantic).toBe("none");
		expect(diag.message).toContain("[git: scratch]");
	});

	it.each(["ignored", "nested-repository"] as const)(
		"demotes a pathStatus:'%s' finding to info/none",
		(pathStatus) => {
			const diag = gitleaksFindingToProjectDiagnostic(
				"/repo",
				finding({ file: ".env", pathStatus }),
			);
			expect(diag.severity).toBe("info");
			expect(diag.semantic).toBe("none");
			expect(diag.message).toContain(`[git: ${pathStatus}]`);
		},
	);

	it.each(["tracked", "untracked", undefined] as const)(
		"keeps a pathStatus:'%s' finding blocking (error/blocking)",
		(pathStatus) => {
			const diag = gitleaksFindingToProjectDiagnostic(
				"/repo",
				finding({ file: ".env", pathStatus }),
			);
			expect(diag.severity).toBe("error");
			expect(diag.semantic).toBe("blocking");
		},
	);
});

describe("writeScopedGitleaksConfig — placeholder allowlist + secrets-lane paths (#1562)", () => {
	let outDir: string;

	beforeEach(() => {
		outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gitleaks-cfg-"));
	});
	afterEach(() => {
		removeTempDirSync(outDir);
	});

	it("extends gitleaks defaults when no local .gitleaks.toml exists", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-nolocal-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("useDefault = true");
		} finally {
			env.cleanup();
		}
	});

	it("extends the project's own .gitleaks.toml by path when present", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-local-");
		try {
			const localConfigPath = path.join(env.tmpDir, ".gitleaks.toml");
			fs.writeFileSync(localConfigPath, 'title = "custom"\n');
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).not.toContain("useDefault = true");
			expect(toml).toContain(JSON.stringify(localConfigPath));
		} finally {
			env.cleanup();
		}
	});

	it("includes an allowlist path pattern for every secrets-lane scratch directory (the narrow list, not the walker-parity one)", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-paths-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("[allowlist]");
			expect(toml).toContain("paths = [");
			for (const pattern of getSecretsLaneAllowlistPaths()) {
				expect(toml).toContain(JSON.stringify(pattern));
			}
		} finally {
			env.cleanup();
		}
	});

	it("does NOT include allowlist path patterns for walker-only dirs (dist/vendor/.vscode/…) — #1562 review-round F1", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-nowalker-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			const pathsBlock = toml.match(/paths = \[([\s\S]*?)\n\]/)?.[1] ?? "";
			expect(pathsBlock.length).toBeGreaterThan(0);
			for (const walkerOnlyName of [
				"dist",
				"vendor",
				".vscode",
				"build",
				"out",
				"target",
				"third_party",
				"third-party",
				"coverage",
			]) {
				expect(pathsBlock).not.toContain(walkerOnlyName);
			}
		} finally {
			env.cleanup();
		}
	});

	it("includes placeholder-secret regexes covering the YOUR_API_KEY class", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-regex-");
		try {
			const configPath = writeScopedGitleaksConfig(outDir, env.tmpDir);
			const toml = fs.readFileSync(configPath, "utf-8");
			expect(toml).toContain("regexes = [");
			for (const pattern of PLACEHOLDER_SECRET_REGEXES) {
				expect(toml).toContain(JSON.stringify(pattern));
			}
		} finally {
			env.cleanup();
		}
	});

	it("the placeholder-secret regex set matches the issue's literal acceptance examples (YOUR_API_KEY / <your-key> / xxx), but never a real-shaped secret", () => {
		const stripped = PLACEHOLDER_SECRET_REGEXES.map((p) =>
			p.replace(/^\(\?i\)/, ""),
		);
		const regexes = stripped.map((p) => new RegExp(p, "i"));
		expect(regexes.some((r) => r.test("YOUR_API_KEY"))).toBe(true);
		// #1562 review-round F3: the issue's own literal example is bare
		// `<your-key>` (no "api" infix) — the weaker `<your-api-key>` used to
		// be the only variant covered.
		expect(regexes.some((r) => r.test("<your-key>"))).toBe(true);
		expect(regexes.some((r) => r.test("<your-api-key>"))).toBe(true);
		// #1562 review-round F3: the issue's own literal example is the
		// 3-character run "xxx", not a 6+ character one.
		expect(regexes.some((r) => r.test("xxx"))).toBe(true);
		expect(regexes.some((r) => r.test("xxxxxxxxxxxx"))).toBe(true);
		// Must NOT match a real-shaped secret.
		expect(
			regexes.some((r) => r.test("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")),
		).toBe(false);
	});

	// #1562 review-round F4: gitleaks preserves the OS-native separator from
	// Go's directory walk on `File` — a forward-slash-only anchor never
	// matches on Windows. Assert the generated regex source itself accepts a
	// backslash-separated path, independent of the TOML/JSON round-trip.
	it("the generated allowlist path regexes match a backslash-separated (Windows-shaped) finding path", () => {
		const env = setupTestEnvironment("pi-lens-gitleaks-cfg-winsep-");
		try {
			writeScopedGitleaksConfig(outDir, env.tmpDir);
			const patterns = getSecretsLaneAllowlistPaths().map((p) => new RegExp(p));
			const winPath = ".pi\\greedysearch-sources\\cline-api-docs.md";
			expect(patterns.some((r) => r.test(winPath))).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
