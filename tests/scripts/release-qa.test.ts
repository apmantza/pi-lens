// flake-shape: real-process-spawn — three spawns, each pinning something no
// in-process double can reach. (1) `npm pack` of a two-line fixture package
// whose `prepare` writes through `os.homedir()`: the F1 defect was npm
// IGNORING the env it was handed, so an assertion on scratchEnv()'s OUTPUT
// passed throughout the defect's life (#2619 review N1). (2) a `node -e` child
// reporting what IT resolved for HOME/PI_LENS_INSTALL_LOG — `os.homedir()` in
// the test process can only ever report the ambient home. (3) the real
// release-qa CLI, run out of a throwaway dirty tree, because main()'s CALL to
// the dirty-checkout refusal is reachable only through the process entry
// point (#2619 review N3, MP-E).
/**
 * #2606 — the release-QA runner's pure core.
 *
 * The runner's value is entirely in its bookkeeping: which rows exist, what
 * outcome each one earned, and whether the arithmetic adds up. #2587 is the
 * recurrence it guards — four shipped skills that nothing ever asked a real pi
 * about, invisible because coverage was claimed rather than counted.
 *
 * These cases hold the decisions that can turn a run dishonest:
 *   - a polled row whose cap expired reads UNTESTED, never PASS;
 *   - a row with no probe reads UNTESTED, so it is arithmetic rather than
 *     silence;
 *   - a run where pi could not boot reads BLOCKED with NO ship verdict;
 *   - the four outcomes must partition the DISCOVERED set, not merely each
 *     other, so a row that fell out of the loop is an ARITHMETIC MISMATCH;
 *   - the matrix document and the runner's probe map are one list, not two.
 *
 * Deliberately NOT here: anything that spawns a real pi. That is the runner's
 * own job and install-smoke's lane; a unit test that installs a coding agent is
 * a nightly wearing a per-PR badge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import * as os from "node:os";
import {
	BASELINE_COLUMNS,
	classifyRowOutcome,
	classifySelftestOutput,
	classifyRunFailure,
	classifySkillsRegistration,
	coverageArithmetic,
	formatOutcome,
	implementedRowIds,
	parseArgs,
	dirtyCheckoutRefusal,
	finalizeRowOutcome,
	npm,
	parseBaselineRows,
	parseSupplyArgs,
	PINNED_ENV_KEYS,
	pollToTerminal,
	rowReportShows,
	rowProbeRequest,
	runToolSmokeInstallProbe,
	classifyPublishToolchain,
	isUnmeasured,
	unmeasuredRowIds,
	pinnedNpm,
	PUBLISH_TOOLCHAIN_ROW_ID,
	runPublishToolchainProbe,
	scratchEnv,
	renderCoverageLine,
	renderReport,
	shipVerdict,
	verdictExitCode,
} from "../../scripts/release-qa.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const BASELINE_PATH = path.join(REPO_ROOT, "docs", "release-qa-baseline.md");

/** A throwaway git repo, through the helper the git-fixture governance requires. */
function gitInit(dir: string): void {
	for (const args of [
		["init", "-q"],
		["config", "user.email", "t@t.t"],
		["config", "user.name", "t"],
	]) {
		gitExecFileSync(args, { cwd: dir });
	}
}

function baselineText(): string {
	return fs.readFileSync(BASELINE_PATH, "utf8");
}

function row(id: string, outcome: string, detail = "", implemented = true) {
	return { id, outcome, detail, implemented };
}

describe("release-QA baseline matrix parsing (#2606)", () => {
	it("parses the committed baseline into at least eight fully-populated rows", () => {
		const { rows, errors } = parseBaselineRows(baselineText());
		expect(errors).toEqual([]);
		expect(rows.length).toBeGreaterThanOrEqual(8);
		for (const parsed of rows) {
			expect(parsed.id).not.toBe("");
			expect(parsed.feature).not.toBe("");
			expect(parsed.modality).not.toBe("");
			expect(parsed.entryPoint).not.toBe("");
			expect(parsed.passCriterion).not.toBe("");
			expect(parsed.witness).not.toBe("");
			expect(parsed.reuse).not.toBe("");
			expect(parsed.umbrella).not.toBe("");
		}
	});

	// The maintainer's instruction on #2606: the matrix must say where it
	// overlaps the already-filed smoke umbrellas rather than re-litigating them
	// row by row. These four rows are the overlap; a blank or wrong citation
	// reds here.
	it.each([
		["install-selftest", "#1605"],
		["commands-registered", "#1605"],
		["mcp-turn-end", "#1605"],
		["degradation-visible", "#1605"],
		["mcp-lsp-navigation", "#1829"],
	])("row %s cites umbrella %s", (id, umbrella) => {
		const { rows } = parseBaselineRows(baselineText());
		const parsed = rows.find((r) => r.id === id);
		expect(parsed, `row ${id} is missing from the matrix`).toBeDefined();
		expect(parsed?.umbrella).toContain(umbrella);
	});

	it("covers at least three distinct modalities", () => {
		const { rows } = parseBaselineRows(baselineText());
		const modalities = new Set(rows.map((r) => r.modality));
		expect(modalities.size).toBeGreaterThanOrEqual(3);
	});

	it("reports a missing column instead of parsing a partial matrix", () => {
		const text = baselineText().replace("| pass criterion |", "| criterion |");
		const { rows, errors } = parseBaselineRows(text);
		expect(rows).toEqual([]);
		expect(errors.join("\n")).toContain('missing the "pass criterion" column');
	});

	it("reports a duplicate row id rather than silently collapsing two rows", () => {
		const { rows } = parseBaselineRows(baselineText());
		const duplicated = baselineText().replace(
			`| ${rows[1].id} |`,
			`| ${rows[0].id} |`,
		);
		const { errors } = parseBaselineRows(duplicated);
		expect(errors.join("\n")).toContain(`duplicate row id "${rows[0].id}"`);
	});

	it("reports a missing table rather than returning zero rows as success", () => {
		const { rows, errors } = parseBaselineRows("# no matrix here\n");
		expect(rows).toEqual([]);
		expect(errors.join("\n")).toContain("no matrix table found");
	});

	it("names every column the runner reads", () => {
		expect([...BASELINE_COLUMNS]).toEqual([
			"row id",
			"feature",
			"modality",
			"entry point",
			"pass criterion",
			"witness",
			"reuse",
			"umbrella",
		]);
	});

	it("requires every documented entry-point path in its named source (#2893)", () => {
		const { rows } = parseBaselineRows(baselineText());
		const packageFiles = (
			JSON.parse(
				fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
			) as { files: string[] }
		).files;
		const hasDist = fs.existsSync(path.join(REPO_ROOT, "dist"));
		const pathPattern = /<(export|installed)>\/([^\s`]+)/g;
		for (const parsed of rows) {
			const matches = [...parsed.entryPoint.matchAll(pathPattern)];
			for (const [, source, relative] of matches) {
				if (source === "export") {
					expect(
						fs.existsSync(path.join(REPO_ROOT, relative)),
						`${parsed.id}: ${relative}`,
					).toBe(true);
				} else {
					// Stryker sandboxes contain tracked sources, not gitignored dist/.
					// The package-file assertion below remains unconditional; this
					// check runs when a local build makes the installed path available.
					if (hasDist) {
						expect(
							fs.existsSync(path.join(REPO_ROOT, relative)),
							`${parsed.id}: ${relative} is not present in the built export`,
						).toBe(true);
					}
					expect(
						packageFiles.some(
							(file) =>
								relative === file ||
								relative.startsWith(file.replace(/\/$/, "")),
						),
						`${parsed.id}: ${relative} is not packaged`,
					).toBe(true);
				}
			}
		}
		const smoke = rows.find((parsed) => parsed.id === "tool-smoke-install");
		expect(smoke?.entryPoint).toContain("<export>/scripts/smoke-tools.mjs");
		expect(smoke?.entryPoint).toContain(
			"<installed>/dist/clients/installer/index.js",
		);
	});
});

describe("release-QA matrix and probe map are one list (#2606)", () => {
	// The single-source-of-truth tie. A probe map that drifts from the matrix is
	// exactly the hand-maintained mirror AGENTS.md forbids: a row could be
	// dropped from the document and keep running invisibly, or gain a probe
	// nobody documented.
	it("has a probe for every baseline row and a baseline row for every probe", () => {
		const { rows } = parseBaselineRows(baselineText());
		const documented = rows.map((r) => r.id).sort();
		expect(implementedRowIds()).toEqual(documented);
	});
});

describe("release-QA tool-smoke install lane (#2663)", () => {
	// The doc↔probe tie for #2663's row, pinned by name: the tool-smoke
	// install lane (#2661's red-on-genuine-install-failure classification)
	// joins the release gate, and a row present in only one of the two lists
	// is either an undocumented probe or a documented row the runner silently
	// skips. The generic tie above holds the whole list; this one names the
	// new row so its removal reads as a named failure, not a count drift.
	it("documents the tool-smoke-install row and implements its probe", () => {
		const { rows } = parseBaselineRows(baselineText());
		const documented = rows.find((r) => r.id === "tool-smoke-install");
		expect(
			documented,
			"row tool-smoke-install is missing from the matrix",
		).toBeDefined();
		expect(implementedRowIds()).toContain("tool-smoke-install");
	});

	function stubSmoke(report: Record<string, unknown>, exitCode = 0) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-qa-smoke-"));
		const scripts = path.join(root, "scripts");
		fs.mkdirSync(scripts);
		fs.writeFileSync(
			path.join(scripts, "smoke-tools.mjs"),
			`process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(${exitCode});\n`,
		);
		return root;
	}

	it("maps a red install row to exit 1 through the real smoke process boundary", () => {
		const root = stubSmoke({
			lane: "install-registry",
			toolCount: 1,
			installed: 0,
			results: [{ toolId: "dead-tool", state: "fail", detail: "E404" }],
		});
		const installedRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "release-qa-installed-"),
		);
		try {
			const raw = runToolSmokeInstallProbe({
				installedPkgDir: installedRoot,
				exportRoot: root,
				projectDir: root,
				env: { ...process.env, PI_LENS_HOME: path.join(root, ".probe-home") },
			});
			const result = { id: "tool-smoke-install", ...classifyRowOutcome(raw) };
			const verdict = shipVerdict([result]);
			expect(verdictExitCode(verdict.verdict)).toBe(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(installedRoot, { recursive: true, force: true });
		}
	});

	it("names a genuine install failure when smoke exits after printing JSON", () => {
		const root = stubSmoke(
			{
				lane: "install-registry",
				toolCount: 1,
				installed: 0,
				results: [
					{
						toolId: "yamllint",
						state: "fail",
						detail: "ensureTool(yamllint) failed: dead registry entry",
					},
				],
			},
			1,
		);
		const installedRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "release-qa-installed-"),
		);
		try {
			const raw = runToolSmokeInstallProbe({
				installedPkgDir: installedRoot,
				exportRoot: root,
				projectDir: root,
				env: { ...process.env, PI_LENS_HOME: path.join(root, ".probe-home") },
			});
			expect(raw.status).toBe("fail");
			expect(raw.detail).toContain("yamllint");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(installedRoot, { recursive: true, force: true });
		}
	});

	it("passes the distinct installed root to the export smoke process", () => {
		const exportRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "release-qa-export-"),
		);
		const installedRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "release-qa-installed-"),
		);
		fs.mkdirSync(path.join(exportRoot, "scripts"));
		fs.writeFileSync(
			path.join(exportRoot, "scripts", "smoke-tools.mjs"),
			"process.stdout.write(JSON.stringify({lane:'install-registry',toolCount:1,installed:1,results:[],ok:true,args:process.argv.slice(2)}))",
		);
		try {
			const raw = runToolSmokeInstallProbe({
				exportRoot,
				installedPkgDir: installedRoot,
				projectDir: exportRoot,
				env: process.env,
			});
			expect(raw.status).toBe("pass");
			expect(raw.witness?.content).toContain(
				`--installer-root=${installedRoot}`,
			);
		} finally {
			fs.rmSync(exportRoot, { recursive: true, force: true });
			fs.rmSync(installedRoot, { recursive: true, force: true });
		}
	});

	it("makes a missing installer root inconclusive instead of green", () => {
		const raw = runToolSmokeInstallProbe({
			exportRoot: "/tmp/export",
			installedPkgDir: "",
			projectDir: "/tmp",
			env: process.env,
		});
		expect(raw.status).toBe("error");
	});

	it("maps a network-unreachable install row to exit 3 through the real smoke process boundary", () => {
		const root = stubSmoke({
			lane: "install-registry",
			toolCount: 1,
			installed: 0,
			results: [
				{
					toolId: "offline-tool",
					state: "skip",
					detail: "transient registry/network condition",
					networkUnreachable: true,
				},
			],
		});
		try {
			const raw = runToolSmokeInstallProbe({
				installedPkgDir: root,
				exportRoot: root,
				projectDir: root,
				env: { ...process.env, PI_LENS_HOME: path.join(root, ".probe-home") },
			});
			expect(raw.status).toBe("unreachable");
			// #2940: this lane's skip is the one that leaves ground truth
			// UNMEASURED, so it — unlike a reachability skip — refuses the ship
			// verdict. `main()` reads this flag, not "any skipped row".
			expect(isUnmeasured(raw)).toBe(true);
			const result = { id: "tool-smoke-install", ...classifyRowOutcome(raw) };
			const verdict = shipVerdict([result], {
				inconclusiveReason: "registry-unreachable row(s) left UNMEASURED",
			});
			expect(verdictExitCode(verdict.verdict)).toBe(3);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("release-QA publish toolchain lane (#2940)", () => {
	// Recurrence: #2940. 9183f39c6 routed release.yml's pin and install steps
	// through `npx -y npm@<pin>` and left `npm publish` bare, so the publish
	// job ran Node 22's bundled npm with no OIDC support. The v4.1.6 run
	// (34530690014) created the tag and the GitHub release, then took
	// `npm error 404 Not Found - PUT https://registry.npmjs.org/pi-lens`.
	// Nothing had ever RUN that job's toolchain before a release; this row is
	// what runs it.
	it("documents the publish-toolchain row and implements its probe", () => {
		const { rows } = parseBaselineRows(baselineText());
		expect(
			rows.find((r) => r.id === PUBLISH_TOOLCHAIN_ROW_ID),
			`row ${PUBLISH_TOOLCHAIN_ROW_ID} is missing from the matrix`,
		).toBeDefined();
		expect(implementedRowIds()).toContain(PUBLISH_TOOLCHAIN_ROW_ID);
	});

	it("fails the row when the pinned invocation answers a different npm", () => {
		const verdict = classifyPublishToolchain({
			pin: "11.18.0",
			reportedVersion: "10.9.4",
			dryRunExitCode: 0,
		});
		expect(verdict.status).toBe("fail");
		expect(verdict.detail).toContain("10.9.4");
		expect(verdict.detail).toContain("11.18.0");
	});

	it("fails the row when the dry-run publish exits non-zero, naming the cause", () => {
		const verdict = classifyPublishToolchain({
			pin: "11.18.0",
			reportedVersion: "11.18.0",
			dryRunExitCode: 1,
			dryRunTail: "npm notice\nnpm error code E404\n",
		});
		expect(verdict.status).toBe("fail");
		expect(verdict.detail).toContain("E404");
	});

	it("passes an already-published dry run with the registry conflict noted", () => {
		const verdict = classifyPublishToolchain({
			pin: "11.18.0",
			reportedVersion: "11.18.0",
			dryRunExitCode: 1,
			dryRunTail:
				"npm error code EPUBLISHCONFLICT\nnpm error You cannot publish over the previously published versions: 4.1.6.\nnpm error A complete log can be found in: /tmp/npm-debug.log",
		});
		expect(verdict.status).toBe("pass");
		expect(verdict.detail).toContain("already published");
		expect(verdict.detail).toContain("EPUBLISHCONFLICT");
	});

	it("marks a pinned npm resolution failure as unmeasured", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "release-qa-npx-unreachable-"),
		);
		try {
			fs.writeFileSync(
				path.join(root, "package.json"),
				'{"packageManager":"npm@11.18.0"}',
			);
			const raw = runPublishToolchainProbe({
				exportRoot: root,
				exportedCommit: "ed63eb2f8",
				env: { ...process.env, PATH: path.join(root, "missing-bin") },
			});
			expect(raw.status).toBe("unreachable");
			expect(raw.unmeasured).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("errors rather than passing when package.json pins no npm", () => {
		expect(
			classifyPublishToolchain({ pin: "", reportedVersion: "11.18.0" }).status,
		).toBe("error");
	});

	it("passes only when the pin answered AND the dry run exited 0", () => {
		const verdict = classifyPublishToolchain({
			pin: "11.18.0",
			reportedVersion: "11.18.0",
			dryRunExitCode: 0,
		});
		expect(verdict.status).toBe("pass");
		expect(verdict.detail).toContain("11.18.0");
	});

	it("records only unmeasured rows in the inconclusive reason set", () => {
		expect(
			unmeasuredRowIds([
				{ id: "git-install-loads", status: "unreachable", unmeasured: false },
				{
					id: PUBLISH_TOOLCHAIN_ROW_ID,
					status: "unreachable",
					unmeasured: true,
				},
				{ id: "tool-smoke-install", status: "pass", unmeasured: false },
			]),
		).toEqual([PUBLISH_TOOLCHAIN_ROW_ID]);
	});

	// A stub `npx` on PATH ahead of the real one, so the probe's REAL argv is
	// the subject and nothing reaches the registry. `reports` is what the stub
	// answers for `--version`; `dryRunExit` is the dry run's exit code.
	function stubNpx(reports: string, dryRunExit = 0) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-qa-npx-"));
		const binDir = path.join(root, "bin");
		fs.mkdirSync(binDir);
		const argvLog = path.join(root, "argv.log");
		fs.writeFileSync(
			path.join(binDir, "npx"),
			[
				"#!/usr/bin/env node",
				'const fs = require("fs");',
				"const args = process.argv.slice(2);",
				`fs.appendFileSync(${JSON.stringify(argvLog)}, args.join(" ") + "\\n");`,
				`if (args.includes("--version")) { console.log(${JSON.stringify(reports)}); process.exit(0); }`,
				'console.log("npm notice Tarball Details");',
				`process.exit(${dryRunExit});`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "pi-lens", packageManager: "npm@11.18.0" }),
		);
		return {
			root,
			argv: () =>
				fs.existsSync(argvLog)
					? fs.readFileSync(argvLog, "utf8").trim().split("\n")
					: [],
			ctx: {
				exportRoot: root,
				exportedCommit: "deadbee",
				env: {
					...process.env,
					PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
				},
			},
		};
	}

	it("drives the argv release.yml publishes with, and passes on the pin", () => {
		const stub = stubNpx("11.18.0");
		try {
			const raw = runPublishToolchainProbe(stub.ctx);
			expect(stub.argv()).toEqual([
				"-y npm@11.18.0 --version",
				"-y npm@11.18.0 publish --dry-run",
			]);
			expect(raw.status).toBe("pass");
			expect(raw.witness?.content).toContain("Tarball Details");
		} finally {
			fs.rmSync(stub.root, { recursive: true, force: true });
		}
	});

	it("fails through the real spawn when npx answers a different npm", () => {
		const stub = stubNpx("10.9.4");
		try {
			const raw = runPublishToolchainProbe(stub.ctx);
			expect(raw.status).toBe("fail");
			expect(raw.detail).toContain("10.9.4");
		} finally {
			fs.rmSync(stub.root, { recursive: true, force: true });
		}
	});

	it("fails through the real spawn when the dry-run publish exits non-zero", () => {
		const stub = stubNpx("11.18.0", 1);
		try {
			expect(runPublishToolchainProbe(stub.ctx).status).toBe("fail");
		} finally {
			fs.rmSync(stub.root, { recursive: true, force: true });
		}
	});

	it("refuses to spawn the pinned npm without the pinned env", () => {
		// Same rule as npm() (#2619 review F1/N1): a dry-run publish runs our
		// own prepack/prepare, which write through os.homedir().
		expect(() => pinnedNpm("11.18.0", ["--version"], os.tmpdir())).toThrow(
			/pinned scratch env/,
		);
	});

	it("skips the row, without refusing the ship verdict, when nothing was exported", () => {
		// `--from npm:pi-lens@X` QAs a PUBLISHED release: there is no candidate
		// tree, and a dry-run publish fires prepack/prepare, so it may never run
		// in the live checkout.
		const raw = runPublishToolchainProbe({
			exportRoot: REPO_ROOT,
			env: process.env,
		});
		expect(classifyRowOutcome(raw).outcome).toBe("SKIPPED");
		expect(isUnmeasured(raw)).toBe(false);
		const verdict = shipVerdict(
			[
				row("pack-skills-payload", "PASS"),
				{ id: PUBLISH_TOOLCHAIN_ROW_ID, ...classifyRowOutcome(raw) },
			],
			{ inconclusiveReason: "" },
		);
		expect(verdict.verdict).toBe("SHIP-WITH-CAVEATS");
		expect(verdictExitCode(verdict.verdict)).toBe(2);
	});
});

describe("release-QA outcome rules (#2606)", () => {
	it("classifies a passing probe as PASS", () => {
		expect(classifyRowOutcome({ status: "pass", detail: "4 skills" })).toEqual({
			outcome: "PASS",
			detail: "4 skills",
		});
	});

	it("classifies a failing probe as FAIL carrying the observed cause", () => {
		expect(classifyRowOutcome({ status: "fail", detail: "0 skills" })).toEqual({
			outcome: "FAIL",
			detail: "0 skills",
		});
	});

	it("classifies a thrown probe as FAIL, not as untested", () => {
		expect(
			classifyRowOutcome({ status: "error", detail: "ENOENT" }).outcome,
		).toBe("FAIL");
	});

	it("classifies an expired polling cap as UNTESTED, never PASS", () => {
		const classified = classifyRowOutcome({
			status: "expired",
			detail: "cap 120000ms expired after 24 attempt(s)",
		});
		expect(classified.outcome).toBe("UNTESTED");
		expect(classified.detail).toContain("expired");
	});

	it("classifies an unreachable row as SKIPPED", () => {
		expect(
			classifyRowOutcome({ status: "unreachable", detail: "no --git-ref" })
				.outcome,
		).toBe("SKIPPED");
	});

	it("classifies a row with no probe as UNTESTED with that reason", () => {
		expect(classifyRowOutcome({ status: "unimplemented" })).toEqual({
			outcome: "UNTESTED",
			detail: "no runner implementation for this row",
		});
	});

	it("classifies a row skipped by a blocked run as UNTESTED with the block reason", () => {
		expect(
			classifyRowOutcome({
				status: "blocked",
				detail: "pi could not boot: timeout",
			}),
		).toEqual({
			outcome: "UNTESTED",
			detail: "pi could not boot: timeout",
		});
	});

	it("classifies an unrecognised status as UNTESTED rather than assuming success", () => {
		const classified = classifyRowOutcome({ status: "probably-fine" });
		expect(classified.outcome).toBe("UNTESTED");
		expect(classified.detail).toContain("unknown probe status");
	});

	it("formats non-passing outcomes with their cause in parentheses", () => {
		expect(formatOutcome({ outcome: "PASS", detail: "ok" })).toBe("PASS");
		expect(formatOutcome({ outcome: "FAIL", detail: "0 skills" })).toBe(
			"FAIL(0 skills)",
		);
		expect(formatOutcome({ outcome: "SKIPPED", detail: "" })).toBe(
			"SKIPPED(no reason recorded)",
		);
	});
});

describe("release-QA polling (#2606)", () => {
	it("returns terminal as soon as the attempt reports one", async () => {
		let calls = 0;
		const polled = await pollToTerminal(
			async () => {
				calls++;
				return { terminal: calls >= 2, detail: `attempt ${calls}` };
			},
			{ capMs: 5000, intervalMs: 1 },
		);
		expect(polled.status).toBe("terminal");
		expect(polled.attempts).toBe(2);
	});

	it("expires with the last observed detail when the cap elapses first", async () => {
		const polled = await pollToTerminal(
			async () => ({ terminal: false, detail: "still scanning" }),
			{ capMs: 30, intervalMs: 1 },
		);
		expect(polled.status).toBe("expired");
		expect(polled.detail).toContain("still scanning");
		expect(
			classifyRowOutcome({ status: polled.status, detail: polled.detail })
				.outcome,
		).toBe("UNTESTED");
	});
});

describe("release-QA coverage arithmetic (#2606)", () => {
	it("counts each outcome and balances against the discovered row count", () => {
		const coverage = coverageArithmetic(
			[
				row("a", "PASS"),
				row("b", "FAIL", "0 skills"),
				row("c", "UNTESTED", "cap expired"),
				row("d", "SKIPPED", "no ref", false),
			],
			4,
		);
		expect(coverage).toMatchObject({
			discovered: 4,
			rows: 3,
			pass: 1,
			fail: 1,
			untested: 1,
			skipped: 1,
			balanced: true,
		});
	});

	it("reports an imbalance when a discovered row produced no result", () => {
		const coverage = coverageArithmetic([row("a", "PASS")], 3);
		expect(coverage.balanced).toBe(false);
		expect(renderCoverageLine(coverage)).toContain("ARITHMETIC MISMATCH");
	});

	it("prints the discovered / rows / untested arithmetic", () => {
		const coverage = coverageArithmetic(
			[row("a", "PASS"), row("b", "UNTESTED", "cap expired")],
			2,
		);
		expect(renderCoverageLine(coverage)).toBe(
			"coverage: discovered 2 / rows 2 / untested 1  " +
				"(pass 1 · fail 0 · untested 1 · skipped 0)",
		);
	});
});

describe("release-QA ship verdict (#2606)", () => {
	it("issues no ship verdict when pi could not boot", () => {
		const verdict = shipVerdict([row("a", "PASS")], {
			blocked: true,
			blockedReason: "pi exited early (code 1)",
		});
		expect(verdict.verdict).toBe("BLOCKED");
		expect(verdict.reason).toBe("pi exited early (code 1)");
		expect(verdictExitCode(verdict.verdict)).toBe(3);
	});

	it("says do not ship when any row FAILED", () => {
		const verdict = shipVerdict([
			row("a", "PASS"),
			row("b", "FAIL", "0 skills registered"),
		]);
		expect(verdict.verdict).toBe("DO-NOT-SHIP");
		expect(verdict.caveats).toEqual(["b: 0 skills registered"]);
		expect(verdictExitCode(verdict.verdict)).toBe(1);
	});

	it("prefers do-not-ship over caveats when both a FAIL and an UNTESTED exist", () => {
		const verdict = shipVerdict([
			row("a", "UNTESTED", "cap expired"),
			row("b", "FAIL", "0 skills"),
		]);
		expect(verdict.verdict).toBe("DO-NOT-SHIP");
	});

	it("ships with caveats, each named, when a row produced no witness", () => {
		const verdict = shipVerdict([
			row("a", "PASS"),
			row("b", "SKIPPED", "no --git-ref"),
		]);
		expect(verdict.verdict).toBe("SHIP-WITH-CAVEATS");
		expect(verdict.caveats).toEqual(["b SKIPPED(no --git-ref)"]);
		expect(verdictExitCode(verdict.verdict)).toBe(2);
	});

	it("issues no ship verdict when pi booted but nothing was witnessed", () => {
		const verdict = shipVerdict([
			row("a", "UNTESTED", "cap expired"),
			row("b", "SKIPPED", "no --git-ref"),
		]);
		expect(verdict.verdict).toBe("INCONCLUSIVE");
		expect(verdict.reason).toContain("0 PASS");
		expect(verdictExitCode(verdict.verdict)).toBe(3);
	});

	it("ships only when every discovered row PASSED", () => {
		const verdict = shipVerdict([row("a", "PASS"), row("b", "PASS")]);
		expect(verdict.verdict).toBe("SHIP");
		expect(verdictExitCode(verdict.verdict)).toBe(0);
	});
});

describe("release-QA report rendering (#2606)", () => {
	it("carries each row's witness path and the excerpt that shows the result", () => {
		const rows = [
			{
				id: "skills-registered",
				feature: "f",
				modality: "pi-rpc",
				entryPoint: "e",
				passCriterion: "p",
				witness: "w",
				reuse: "r",
				umbrella: "—",
			},
		];
		const results = [
			{
				id: "skills-registered",
				outcome: "PASS",
				detail: "4 skill command(s)",
				implemented: true,
				witnessPath: "release-qa-evidence/skills-registered.json",
				shows: "4 skill command(s): skill:pi-lens-ast-grep",
			},
		];
		const report = renderReport({
			rows,
			results,
			coverage: coverageArithmetic(results, 1),
			verdict: shipVerdict(results),
			context: { pi: "pi 0.80.10" },
		});
		expect(report).toContain("## Verdict: SHIP");
		expect(report).toContain("release-qa-evidence/skills-registered.json");
		expect(report).toContain("4 skill command(s): skill:pi-lens-ast-grep");
		expect(report).toContain("coverage: discovered 1 / rows 1 / untested 0");
	});

	it("renders a discovered row that produced no result beside the mismatch line", () => {
		// The pair that makes a dropped row visible instead of invisible: the row
		// still gets a line (UNTESTED, not run) AND the arithmetic says the
		// discovered set did not add up.
		const rows = [
			{
				id: "dropped-row",
				feature: "f",
				modality: "mcp-stdio",
				entryPoint: "e",
				passCriterion: "p",
				witness: "w",
				reuse: "r",
				umbrella: "—",
			},
		];
		const report = renderReport({
			rows,
			results: [],
			coverage: coverageArithmetic([], 1),
			verdict: shipVerdict([]),
		});
		expect(report).toContain("| dropped-row | mcp-stdio | UNTESTED(not run) |");
		expect(report).toContain("ARITHMETIC MISMATCH");
	});

	it("says plainly that a blocked run gets no ship verdict", () => {
		const report = renderReport({
			rows: [],
			results: [],
			coverage: coverageArithmetic([], 0),
			verdict: shipVerdict([], { blocked: true, blockedReason: "no pi" }),
		});
		expect(report).toContain("## Verdict: BLOCKED");
		expect(report).toContain("pi itself did not boot");
	});

	it("says plainly that an unwitnessed run gets no ship verdict either", () => {
		const results = [row("a", "UNTESTED", "cap expired")];
		const report = renderReport({
			rows: [
				{
					id: "a",
					feature: "f",
					modality: "mcp-stdio",
					entryPoint: "e",
					passCriterion: "p",
					witness: "w",
					reuse: "r",
					umbrella: "—",
				},
			],
			results,
			coverage: coverageArithmetic(results, 1),
			verdict: shipVerdict(results),
		});
		expect(report).toContain("## Verdict: INCONCLUSIVE");
		expect(report).toContain("An unwitnessed run is not a passing run");
	});

	it("defines the coverage triple beneath the arithmetic", () => {
		const results = [row("a", "PASS")];
		const report = renderReport({
			rows: [],
			results,
			coverage: coverageArithmetic(results, 1),
			verdict: shipVerdict(results),
		});
		expect(report).toContain("Legend — `discovered`");
		expect(report).toContain("A SKIPPED row IS counted");
	});
});

describe("release-QA scratch hermeticity (#2619 review F1)", () => {
	// The receipt this canary exists for: the runner's first six runs pinned
	// PI_LENS_HOME but passed NO env to `npm`, and `npm pack` runs our own
	// `prepare` -> `scripts/warm-loader-cache.mjs`, whose install-log sink is
	// PI_LENS_INSTALL_LOG or `os.homedir()/.pi-lens/install.log`. 41
	// `warm_loader_cache` records landed in the maintainer's real file.
	const scratchRoot = path.join(os.tmpdir(), "release-qa-hermeticity-fixture");

	it("pins every variable a pi-lens or npm child could write through", () => {
		const env = scratchEnv(scratchRoot);
		for (const key of PINNED_ENV_KEYS) {
			expect(env[key], `${key} is not pinned`).toBeDefined();
			expect(
				String(env[key]).startsWith(scratchRoot),
				`${key} = ${env[key]} escapes the scratch root`,
			).toBe(true);
		}
		// The one that was missing. Named explicitly as well as swept, because
		// a sweep over a list cannot notice the list itself lost an entry.
		expect(env.PI_LENS_INSTALL_LOG).toBe(
			path.join(scratchRoot, "home", ".pi-lens", "install.log"),
		);
	});

	it("refuses to spawn npm without the pinned env", () => {
		// #2619 review N1: `env` was an OPTIONAL positional, so dropping it at a
		// call site reproduced the F1 defect while every test stayed green. npm
		// runs pi-lens's OWN prepare/prepack, which write through os.homedir().
		// REPO_ROOT, not a made-up path: with the guard removed the call must
		// SUCCEED (and silently inherit the ambient env), so the red is "no
		// throw", never an incidental ENOENT from a nonexistent cwd.
		expect(() => npm(["--version"], REPO_ROOT)).toThrow(
			/npm\(\) requires the pinned scratch env/,
		);
	});

	it("keeps host pip and npm policy overrides out of the install-row environment", () => {
		const priorPip = process.env.PIP_BREAK_SYSTEM_PACKAGES;
		const priorNpm = process.env.npm_config_userconfig;
		process.env.PIP_BREAK_SYSTEM_PACKAGES = "host-value";
		process.env.npm_config_userconfig = "/host/.npmrc";
		try {
			const env = scratchEnv(scratchRoot);
			expect(env.PIP_BREAK_SYSTEM_PACKAGES).toBe("1");
			expect(env.npm_config_userconfig).toBeUndefined();
		} finally {
			if (priorPip === undefined) delete process.env.PIP_BREAK_SYSTEM_PACKAGES;
			else process.env.PIP_BREAK_SYSTEM_PACKAGES = priorPip;
			if (priorNpm === undefined) delete process.env.npm_config_userconfig;
			else process.env.npm_config_userconfig = priorNpm;
		}
	});

	it("keeps a packed package's own lifecycle script inside the scratch root", () => {
		// The canary the env pin actually needs: an assertion on scratchEnv()'s
		// OUTPUT cannot see npm ignoring it. This packs a two-line fixture
		// package whose `prepare` writes through `os.homedir()` — the same shape
		// as scripts/warm-loader-cache.mjs — through the REAL npm() helper, and
		// checks where the record landed.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-qa-canary-"));
		const ambient = path.join(root, "ambient-home");
		const fixture = path.join(root, "fixture");
		fs.mkdirSync(ambient, { recursive: true });
		fs.mkdirSync(fixture, { recursive: true });
		fs.writeFileSync(
			path.join(fixture, "package.json"),
			JSON.stringify({
				name: "release-qa-env-canary",
				version: "1.0.0",
				private: true,
				scripts: { prepare: "node ./write-marker.mjs" },
			}),
		);
		fs.writeFileSync(
			path.join(fixture, "write-marker.mjs"),
			'import fs from "node:fs";import os from "node:os";import path from "node:path";' +
				'const f=path.join(os.homedir(),".pi-lens","canary.log");' +
				'fs.mkdirSync(path.dirname(f),{recursive:true});fs.appendFileSync(f,"prepare ran\\n");',
		);
		try {
			// HOME in the env we hand npm is the SCRATCH home; the fixture's
			// `prepare` resolves os.homedir() from it.
			npm(
				["pack", "--json", "--pack-destination", root],
				fixture,
				scratchEnv(root, {
					HOME: path.join(root, "home"),
					USERPROFILE: path.join(root, "home"),
				}),
			);
			expect(
				fs.existsSync(path.join(root, "home", ".pi-lens", "canary.log")),
				"the packed package's prepare should write inside the scratch root",
			).toBe(true);
			expect(
				fs.existsSync(path.join(ambient, ".pi-lens")),
				"nothing should reach a home outside the scratch root",
			).toBe(false);

			// The negative half, wired rather than decorative (#2619 review N6):
			// pack the SAME fixture under an UNPINNED env — what a call site gets
			// when it builds `{...process.env}` itself instead of using
			// scratchEnv — and watch the marker follow HOME into the ambient dir.
			// Without this the positive assertion above is compatible with a
			// fixture that always writes to the scratch root regardless of env,
			// which would make the whole canary vacuous.
			npm(["pack", "--json", "--pack-destination", root], fixture, {
				...process.env,
				HOME: ambient,
				USERPROFILE: ambient,
			});
			expect(
				fs.existsSync(path.join(ambient, ".pi-lens", "canary.log")),
				"the fixture must actually resolve os.homedir() — otherwise the assertion above proves nothing",
			).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 120_000);

	it("gives a REAL child a home and an install log inside the scratch root", () => {
		// A real child, not an in-process assertion: the bug was a child
		// inheriting the ambient environment, and `os.homedir()` in THIS process
		// can only ever report the ambient one.
		const probe = [
			"-e",
			"console.log(JSON.stringify({" +
				"homedir: require('node:os').homedir()," +
				"installLog: process.env.PI_LENS_INSTALL_LOG ?? null," +
				"piLensHome: process.env.PI_LENS_HOME ?? null," +
				"npmCache: process.env.npm_config_cache ?? null}))",
		];
		const stdout = execFileSync(process.execPath, probe, {
			encoding: "utf8",
			env: scratchEnv(scratchRoot),
			timeout: 30_000,
		});
		const seen = JSON.parse(stdout);
		expect(seen.homedir).toBe(path.join(scratchRoot, "home"));
		expect(seen.homedir).not.toBe(os.homedir());
		expect(seen.installLog).toBe(
			path.join(scratchRoot, "home", ".pi-lens", "install.log"),
		);
		expect(seen.piLensHome).toBe(path.join(scratchRoot, "home", ".pi-lens"));
		expect(seen.npmCache).toBe(path.join(scratchRoot, "npm-cache"));
	});
});

describe("release-QA verdict state space (#2619 review round 3)", () => {
	// The rail's cell list, one case per reachable cell. The table lives in the
	// PR body; these are the cells as executable claims.

	// --- C1 vs C2: BLOCKED is about the HOST, never about the candidate -----
	it("C1: pi that will not boot at all is BLOCKED, no candidate blamed", () => {
		const classified = classifyRunFailure({
			bootProbeOk: false,
			bootProbeReason: "pi exited early (code 1)",
		});
		expect(classified.blocked).toBe(true);
		expect(classified.blockedReason).toContain(
			"pi could not boot without the candidate",
		);
		expect(classified.candidateFailure).toBe("");
		const verdict = shipVerdict([], {
			blocked: true,
			blockedReason: classified.blockedReason,
		});
		expect(verdict.verdict).toBe("BLOCKED");
		expect(verdictExitCode(verdict.verdict)).toBe(3);
	});

	it("C2: a candidate that will not install, on a pi that boots, is DO-NOT-SHIP", () => {
		const classified = classifyRunFailure({
			bootProbeOk: true,
			candidateError: "npm ERR! code ETARGET",
		});
		expect(classified.blocked).toBe(false);
		expect(classified.candidateFailure).toContain(
			"candidate could not be installed or activated",
		);
		expect(classified.candidateFailure).toContain("ETARGET");
	});

	it("C2: a candidate that stops a booted pi from starting is DO-NOT-SHIP", () => {
		const classified = classifyRunFailure({
			bootProbeOk: true,
			candidateRpcReason: "no get_commands response within 60000ms",
		});
		expect(classified.blocked).toBe(false);
		expect(classified.candidateFailure).toContain(
			"pi booted bare but not with the candidate installed",
		);
	});

	it("C2: every row reads UNTESTED and none is counted in rows", () => {
		// The N2 defect: this cell used to FAIL all eleven rows with the copied
		// cause and write ZERO witnesses — a verdict with no witness, against
		// Hard Rule 1 and against the legend's definition of `rows`.
		const cause = "candidate could not be installed or activated: ETARGET";
		const classified = classifyRowOutcome({
			status: "candidate-failure",
			detail: cause,
		});
		expect(classified.outcome).toBe("UNTESTED");
		expect(classified.detail).toBe(cause);

		const results = ["a", "b", "c"].map((id) => ({
			id,
			outcome: classified.outcome,
			detail: classified.detail,
			implemented: false,
		}));
		const coverage = coverageArithmetic(results, 3);
		expect(coverage).toMatchObject({
			discovered: 3,
			rows: 0,
			pass: 0,
			fail: 0,
			untested: 3,
			balanced: true,
		});
	});

	it("C2: no probe is driven for any row, and none is FAILED", () => {
		// The N2 defect, at its own seam: the candidate failure used to be
		// copied onto every row as a FAIL.
		const request = rowProbeRequest({
			hasProbe: true,
			candidateFailure:
				"candidate could not be installed or activated: ETARGET",
		});
		expect(request.attempted).toBe(false);
		expect(request.probe?.status).toBe("candidate-failure");
		expect(classifyRowOutcome(request.probe).outcome).toBe("UNTESTED");
	});

	it("C1: a blocked run drives no probe either", () => {
		const request = rowProbeRequest({
			hasProbe: true,
			blocked: true,
			blockedReason: "pi could not boot",
			candidateFailure: "ignored — blocked outranks it",
		});
		expect(request.attempted).toBe(false);
		expect(request.probe).toEqual({
			status: "blocked",
			detail: "pi could not boot",
		});
	});

	it("C8: a row with no probe is not counted in rows", () => {
		const request = rowProbeRequest({ hasProbe: false });
		expect(request.attempted).toBe(false);
		expect(request.probe?.status).toBe("unimplemented");
	});

	it("C3-C6: a healthy run drives the row's own probe", () => {
		expect(rowProbeRequest({ hasProbe: true })).toEqual({ attempted: true });
	});

	it("C2: the candidate failure is the verdict's own cause, not a row's", () => {
		const results = [row("a", "UNTESTED", "…", false)];
		const verdict = shipVerdict(results, {
			candidateFailure:
				"candidate could not be installed or activated: ETARGET",
		});
		expect(verdict.verdict).toBe("DO-NOT-SHIP");
		expect(verdict.reason).toContain("the candidate never activated");
		expect(verdict.reason).toContain("ETARGET");
		// Not INCONCLUSIVE: zero rows passed, but the run has a definite answer.
		expect(verdictExitCode(verdict.verdict)).toBe(1);
	});

	it("C1 outranks C2 when both are somehow set", () => {
		const verdict = shipVerdict([], {
			blocked: true,
			blockedReason: "pi could not boot",
			candidateFailure: "also this",
		});
		expect(verdict.verdict).toBe("BLOCKED");
	});

	// --- C7: Hard Rule 1 as code -------------------------------------------
	it("C7: a probe that claims PASS with no witness is downgraded to UNTESTED", () => {
		const downgraded = finalizeRowOutcome(
			{ outcome: "PASS", detail: "4 skills" },
			"",
		);
		expect(downgraded.outcome).toBe("UNTESTED");
		expect(downgraded.detail).toContain("no witness");
	});

	it("C7: a PASS with a witness that shows something is left alone", () => {
		const kept = finalizeRowOutcome(
			{ outcome: "PASS", detail: "4 skills" },
			"release-qa-evidence/skills-registered.json",
			'{"commands":[…]}',
		);
		expect(kept).toEqual({ outcome: "PASS", detail: "4 skills" });
	});

	it("C7: non-PASS outcomes pass through untouched, witness or not", () => {
		expect(
			finalizeRowOutcome({ outcome: "SKIPPED", detail: "no ref" }, "", ""),
		).toEqual({ outcome: "SKIPPED", detail: "no ref" });
		expect(
			finalizeRowOutcome({ outcome: "FAIL", detail: "0 skills" }, "p", ""),
		).toEqual({ outcome: "FAIL", detail: "0 skills" });
	});

	it("C7b: a PASS whose witness file is EMPTY is downgraded to UNTESTED", () => {
		// The reachable half (#2619 review N6): every shipped probe attaches a
		// witness OBJECT on its pass path, so the absence check alone never
		// fires. A 0-byte or whitespace-only witness shows nothing, and a row
		// that shows nothing is not a witnessed pass.
		for (const content of ["", "   ", "\n\t\n"]) {
			const downgraded = finalizeRowOutcome(
				{ outcome: "PASS", detail: "exit 0; 0 [FAIL] line(s); " },
				"release-qa-evidence/install-selftest.txt",
				content,
			);
			expect(downgraded.outcome).toBe("UNTESTED");
			expect(downgraded.detail).toContain("its witness is empty");
			expect(downgraded.detail).toContain("install-selftest.txt");
			expect(downgraded.downgraded).toBe(true);
		}
	});

	it("C7b: a downgraded row reports the reason, never the pass excerpt", () => {
		// `shows` is what the report's last column prints. Leaving the probe's
		// pass line there would put the claim back in the report that the
		// downgrade just removed.
		const downgraded = finalizeRowOutcome(
			{ outcome: "PASS", detail: "exit 0" },
			"release-qa-evidence/install-selftest.txt",
			"",
		);
		const shows = rowReportShows(downgraded, "exit 0; 0 [FAIL] line(s); ");
		expect(shows).toContain("its witness is empty");
		expect(shows).not.toContain("0 [FAIL] line(s)");
		// …and an ordinary row still shows the probe's own excerpt.
		expect(rowReportShows({ detail: "reason" }, "4 skill command(s)")).toBe(
			"4 skill command(s)",
		);
	});

	it("C7b: install-selftest exiting 0 in silence does not ship as a pass", () => {
		// The concrete row the reachable form was found on: `exit 0` with no
		// `[FAIL]` line is satisfied VACUOUSLY by a selftest that printed
		// nothing, and its witness is that same empty stdout.
		const verdict = classifySelftestOutput(0, "");
		expect(verdict.status).toBe("pass"); // the process really did succeed
		const finalized = finalizeRowOutcome(
			classifyRowOutcome(verdict),
			"release-qa-evidence/install-selftest.txt",
			"",
		);
		expect(finalized.outcome).toBe("UNTESTED");
	});

	it("C7b: a real selftest report still passes, and a [FAIL] line still fails", () => {
		const good =
			"  [PASS] dist/index.js (entry)\nselftest: 13 passed, 0 failed, 1 warned\n";
		const verdict = classifySelftestOutput(0, good);
		expect(verdict.status).toBe("pass");
		expect(verdict.shows).toContain("selftest: 13 passed");
		expect(
			finalizeRowOutcome(classifyRowOutcome(verdict), "p.txt", good).outcome,
		).toBe("PASS");
		expect(
			classifySelftestOutput(0, '  [FAIL] pi.skills "../../skills"\n').status,
		).toBe("fail");
		expect(classifySelftestOutput(1, good).status).toBe("fail");
	});
});

describe("release-QA skills-registration verdict (#2619 review N3)", () => {
	const PKG = "/proj/node_modules/pi-lens";
	const skill = (name: string, over: Record<string, unknown> = {}) => ({
		source: "skill",
		name: `skill:${name}`,
		sourceInfo: {
			path: `${PKG}/skills/${name}/SKILL.md`,
			source: "extension:index",
			...over,
		},
	});
	const four = () => [
		skill("pi-lens-ast-grep"),
		skill("pi-lens-lsp-navigation"),
		skill("pi-lens-write-ast-grep-rule"),
		skill("pi-lens-write-tree-sitter-rule"),
	];

	it("passes four in-package skills registered by the extension's own handler", () => {
		const verdict = classifySkillsRegistration(four(), PKG);
		expect(verdict.status).toBe("pass");
		expect(verdict.shows).toContain("4/4 via extension:index");
	});

	it("fails when a skill was registered by the manifest instead of the handler", () => {
		// The F2 fix, as its own case: #2587 proved one registrar can be broken
		// for four releases while the other silently covers for it, so the row
		// names which half is load-bearing.
		const commands = four();
		commands[0].sourceInfo.source = "package:manifest";
		const verdict = classifySkillsRegistration(commands, PKG);
		expect(verdict.status).toBe("fail");
		expect(verdict.shows).toContain("3/4 via extension:index");
	});

	it("fails when a skill resolved outside the installed package", () => {
		const commands = four();
		commands[1].sourceInfo.path = "/somewhere/else/skills/x/SKILL.md";
		expect(classifySkillsRegistration(commands, PKG).status).toBe("fail");
	});

	it("fails when fewer than the four shipped skills registered", () => {
		expect(classifySkillsRegistration(four().slice(0, 3), PKG).status).toBe(
			"fail",
		);
		const none = classifySkillsRegistration([], PKG);
		expect(none.status).toBe("fail");
		expect(none.shows).toContain("(none)");
	});

	it("ignores non-skill commands in the same response", () => {
		const commands = [
			...four(),
			{ source: "extension", name: "lens-health", sourceInfo: { path: PKG } },
		];
		expect(classifySkillsRegistration(commands, PKG).status).toBe("pass");
	});
});

describe("release-QA host-provided peer args (#2586 recombination)", () => {
	// scripts/supply-host-provided-deps.mjs emits ONE ENTRY PER LINE because a
	// peer range can contain a space — its own header says so, added by #2586's
	// review. A whitespace split turns the OR-form range into three argv
	// entries and hands `npm install` the tokens `||` and `^0.85.0` as package
	// names.
	it("keeps an OR-form range in one argv entry", () => {
		expect(
			parseSupplyArgs(
				"typebox@^1.0.0\n@earendil-works/pi-tui@^0.84.1 || ^0.85.0\n",
			),
		).toEqual(["typebox@^1.0.0", "@earendil-works/pi-tui@^0.84.1 || ^0.85.0"]);
	});

	it("drops blank lines and trailing whitespace", () => {
		expect(parseSupplyArgs("  a@1 \n\n b@2\n\n")).toEqual(["a@1", "b@2"]);
		expect(parseSupplyArgs("")).toEqual([]);
	});
});

describe("release-QA dirty-checkout refusal (#2619 review F1)", () => {
	it("passes a clean checkout through", () => {
		expect(dirtyCheckoutRefusal("")).toBeNull();
		expect(dirtyCheckoutRefusal("  \n ")).toBeNull();
	});

	it("refuses a dirty checkout and names what is uncommitted", () => {
		const refusal = dirtyCheckoutRefusal(" M scripts/release-qa.mjs\n");
		expect(refusal).toContain("the checkout is dirty");
		expect(refusal).toContain("M scripts/release-qa.mjs");
		expect(refusal).toContain("--from npm:<spec>");
	});

	it("exits 4 from the real CLI when its own checkout is dirty", () => {
		// #2619 review N3 / MP-E: the pure refusal above is covered, but main()'s
		// CALL to it was not — disabling that call left every test green. The
		// runner resolves REPO_ROOT from its own file location, so running the
		// real script out of a throwaway tree with a dirty git repo at its root
		// exercises the call site itself. No pi, no network: the refusal fires
		// before the scratch root is created.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-qa-dirty-"));
		try {
			fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
			for (const rel of [
				"scripts/release-qa.mjs",
				"scripts/lib/md-matrix.mjs",
				"scripts/lib/git-fixture-env.mjs",
			]) {
				fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
			}
			gitInit(root);
			fs.writeFileSync(path.join(root, "uncommitted.txt"), "dirty\n");

			const result = spawnSync(
				process.execPath,
				[
					path.join(root, "scripts", "release-qa.mjs"),
					"--from",
					"tree",
					"--baseline",
					BASELINE_PATH,
				],
				{ encoding: "utf8", timeout: 60_000 },
			);
			expect(result.status).toBe(4);
			expect(result.stderr).toContain("the checkout is dirty");
			expect(result.stderr).toContain("uncommitted.txt");
		} finally {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	}, 120_000);
});

describe("release-QA argument parsing (#2606)", () => {
	it("defaults to the committed baseline and a stated polling cap", () => {
		const opts = parseArgs([]);
		expect(opts.from).toBe("tree");
		expect(opts.pollCapMs).toBeGreaterThan(0);
		expect(opts.baseline.replaceAll("\\", "/")).toContain(
			"docs/release-qa-baseline.md",
		);
	});

	it("rejects an unknown option instead of ignoring it", () => {
		expect(() => parseArgs(["--wat"])).toThrow(/unknown option: --wat/);
	});

	it("refuses a non-numeric polling cap rather than running with NaN", () => {
		// A NaN cap makes pollToTerminal expire on its first check, so the polled
		// row goes silently UNTESTED — a typo quietly shrinking the witnessed set
		// is the exact opposite of "coverage counted, not claimed".
		expect(() => parseArgs(["--poll-cap-ms", "abc"])).toThrow(
			/--poll-cap-ms must be a positive number, got abc/,
		);
		expect(() => parseArgs(["--poll-cap-ms", "0"])).toThrow(
			/--poll-cap-ms must be a positive number/,
		);
		expect(parseArgs(["--poll-cap-ms", "5000"]).pollCapMs).toBe(5000);
	});

	it("refuses a trailing value-taking flag rather than carrying undefined", () => {
		expect(() => parseArgs(["--pi"])).toThrow(/--pi requires a value/);
		expect(() => parseArgs(["--out"])).toThrow(/--out requires a value/);
		expect(() => parseArgs(["--git-ref"])).toThrow(
			/--git-ref requires a value/,
		);
	});
});
// flake-shape: real-process-spawn — this test calls a child-process helper; its boundary remains part of the contention surface
