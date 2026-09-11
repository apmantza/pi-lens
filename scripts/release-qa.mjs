#!/usr/bin/env node
/**
 * Release-QA runner (#2606) — witness the feature × modality matrix against a
 * REAL pi before a tag is cut.
 *
 * WHY THIS EXISTS
 * #2587: the four shipped skills were suspected of never registering for four
 * releases because no check ever asked a real pi what it loaded. The unit suite
 * and the nightly smokes are per-seam; nothing composed them into a release
 * verdict with COUNTED coverage, so a missing row read as absence rather than
 * arithmetic. This runner is that composition.
 *
 * WHAT IT DOES
 *   1. Reads `docs/release-qa-baseline.md` — the matrix is the DOCUMENT, not a
 *      copy of it in here. Every row id there must have a probe below and vice
 *      versa (`tests/scripts/release-qa.test.ts` enforces the tie).
 *   2. Exports the COMMITTED tree (`git archive HEAD`) into the scratch root and
 *      packs THERE — or takes `--from npm:pi-lens@X` to QA a published release
 *      instead — then installs the tarball into a SCRATCH project. The export
 *      matters: `npm pack` runs our own `prepack` (which rewrites
 *      `package.json` + `package-lock.json`, restored only by `postpack`, with
 *      no signal trap) and `prepare` (rebuilds `dist/`, downloads grammars,
 *      reinstalls git hooks), and none of that may happen in the live checkout.
 *      A dirty checkout is REFUSED rather than silently packed as its last
 *      commit.
 *   3. Installs that package into a scratch `pi`. EVERY child process — `pi`,
 *      the MCP server, `node`, and `npm` — runs under `scratchEnv()`, which
 *      pins `HOME`, `USERPROFILE`, `PI_LENS_HOME`, `PILENS_DATA_DIR`,
 *      `PI_LENS_INSTALL_LOG` and `npm_config_cache` inside the scratch root
 *      (AGENTS.md probe hygiene, #2506). `PI_LENS_INSTALL_LOG` is listed
 *      separately for a reason: it explicitly selects the warm-loader log
 *      file, while `PI_LENS_HOME` selects its fallback directory.
 *   4. Drives each row's entry point — the command or RPC a USER path takes,
 *      never a raw internal function — and writes `release-qa-report.md` plus
 *      one witness file per row under `release-qa-evidence/`.
 *
 * OUTCOMES
 * Every discovered row ends PASS / FAIL(cause) / UNTESTED(reason) /
 * SKIPPED(reason), and the four partition the discovered set — the report
 * asserts `discovered = pass + fail + untested + skipped`. An async row that
 * does not reach a terminal state before its polling cap expires UNTESTED,
 * never PASS.
 *
 * Two verdicts issue NO ship line at all:
 *   - **BLOCKED** — `pi` itself did not boot, probed BEFORE anything is
 *     installed. Nothing about the candidate was measured. A candidate that
 *     will not install or activate while pi boots fine is DO-NOT-SHIP, not
 *     BLOCKED: that is a result, not an untestable state.
 *   - **INCONCLUSIVE** — pi booted, but not one row produced a witness. "No
 *     row disagreed" is not evidence, so it never reads as ship-with-caveats.
 *
 * Exit codes: 0 ship · 1 do not ship · 2 ship with caveats (the EXPECTED
 * working-tree verdict — the git-install row is SKIPPED without `--git-ref`) ·
 * 3 BLOCKED or INCONCLUSIVE · 4 usage/self-check error.
 *
 * USAGE
 *   node scripts/release-qa.mjs [options]
 *     --pi <path>          pi binary to drive (default: `pi` on PATH)
 *     --from <source>      `tree` (default: npm pack this repo) or
 *                          `npm:pi-lens@<version>` to QA a published release
 *     --baseline <path>    default docs/release-qa-baseline.md
 *     --out <dir>          where the report + evidence land (default: cwd)
 *     --poll-cap-ms <n>    cap for polled async rows (default 120000)
 *     --git-ref <ref>      enable the git-install row against this pushed ref
 *     --keep               leave the scratch root on disk
 *     --keep-scratch       alias for --keep
 *     --scratch-root <dir> use this directory as the scratch root instead of
 *                          a fresh mkdtemp dir (created when missing; a
 *                          pre-existing directory is never removed on exit)
 *
 * Node-only, no new dependency. Every spawn is shell-free (execFile/spawn with
 * an argv array) per AGENTS.md.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { parseTable } from "./lib/md-matrix.mjs";

// ===========================================================================
// Pure core — parsing, outcome rules, arithmetic, rendering.
// Exported so `tests/scripts/release-qa.test.ts` can hold them without
// spawning a real pi (that is this runner's job, and install-smoke's lane).
// ===========================================================================

/**
 * pi's own label for the registrar that put a skill on the session, as
 * reported in `get_commands`' `sourceInfo.source`. `extension:index` is
 * `index.ts`'s `resources_discover` handler (#205) — pi-lens registering its
 * own skills — as opposed to a `pi.skills` manifest entry pi resolved itself.
 * Read off live pi 0.80.10 and 0.85.1 responses, both identical.
 */
const EXPECTED_SKILL_REGISTRAR = "extension:index";
/** How many skills pi-lens ships: one SKILL.md per dir under `skills`. */
const MIN_SHIPPED_SKILLS = 4;

/**
 * The baseline row that witnesses the installer registry (#2663): every
 * npm/pip entry installs for real through the tool smoke's registry install
 * lane, a genuine install failure is do-not-ship, and a registry-unreachable
 * classification refuses the ship verdict instead of reading as green.
 */
export const TOOL_SMOKE_INSTALL_ROW_ID = "tool-smoke-install";

/**
 * Short, schema-stable marker for the baseline's matrix table. Deliberately the
 * first two columns only: a marker naming a column that a later revision adds
 * or renames would stop finding the table and the runner would silently report
 * zero discovered rows.
 */
export const BASELINE_TABLE_MARKER = "| row id | feature |";

/** The matrix columns, in order. A baseline missing one is a hard error. */
export const BASELINE_COLUMNS = Object.freeze([
	"row id",
	"feature",
	"modality",
	"entry point",
	"pass criterion",
	"witness",
	"reuse",
	"umbrella",
]);

export const OUTCOME = Object.freeze({
	PASS: "PASS",
	FAIL: "FAIL",
	UNTESTED: "UNTESTED",
	SKIPPED: "SKIPPED",
});

/**
 * Parse the baseline matrix into ordered row records.
 *
 * Returns `{ rows, errors }`. `errors` is non-empty when the document cannot be
 * trusted as a row list — a missing table, a renamed/missing column, a blank id,
 * or a duplicate id. The caller treats any error as a self-check failure and
 * refuses to run: a matrix the runner half-understood would under-report
 * coverage while looking healthy, which is the exact failure #2606 exists to
 * end.
 *
 * @param {string} text  contents of docs/release-qa-baseline.md
 */
export function parseBaselineRows(text) {
	const table = parseTable(String(text ?? ""), BASELINE_TABLE_MARKER);
	if (!table) {
		return {
			rows: [],
			errors: [`no matrix table found (marker ${BASELINE_TABLE_MARKER})`],
		};
	}
	const errors = [];
	for (const column of BASELINE_COLUMNS) {
		if (!table.header.includes(column)) {
			errors.push(`baseline table is missing the "${column}" column`);
		}
	}
	if (errors.length > 0) return { rows: [], errors };

	const index = (name) => table.header.indexOf(name);
	const rows = [];
	const seen = new Set();
	for (const cells of table.rows) {
		const id = cells[index("row id")] ?? "";
		if (id === "") {
			errors.push(`row ${rows.length + 1} has a blank row id`);
			continue;
		}
		if (seen.has(id)) {
			errors.push(`duplicate row id "${id}"`);
			continue;
		}
		seen.add(id);
		rows.push({
			id,
			feature: cells[index("feature")] ?? "",
			modality: cells[index("modality")] ?? "",
			entryPoint: cells[index("entry point")] ?? "",
			passCriterion: cells[index("pass criterion")] ?? "",
			witness: cells[index("witness")] ?? "",
			reuse: cells[index("reuse")] ?? "",
			umbrella: cells[index("umbrella")] ?? "",
		});
	}
	if (rows.length === 0 && errors.length === 0) {
		errors.push("baseline matrix has no rows");
	}
	return { rows, errors };
}

/**
 * The outcome rules, as one total function over a probe's self-reported status.
 *
 * `expired` is the load-bearing one: a polled row whose cap elapsed before a
 * terminal state is UNTESTED, NEVER PASS. A runner that lets a timeout read as
 * success reports a green release it never witnessed.
 *
 * `unimplemented` is the second: a baseline row with no probe is UNTESTED with
 * that reason, so an unimplemented row is arithmetic rather than silence.
 *
 * @param {{ status?: string, detail?: string }} probe
 * @returns {{ outcome: string, detail: string }}
 */
export function classifyRowOutcome(probe) {
	const detail = String(probe?.detail ?? "").trim();
	switch (probe?.status) {
		case "pass":
			return { outcome: OUTCOME.PASS, detail };
		case "fail":
			return { outcome: OUTCOME.FAIL, detail: detail || "no cause recorded" };
		case "error":
			return { outcome: OUTCOME.FAIL, detail: detail || "probe threw" };
		case "expired":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "polling cap expired before a terminal state",
			};
		case "unreachable":
			return {
				outcome: OUTCOME.SKIPPED,
				detail: detail || "unreachable in this run",
			};
		case "unimplemented":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "no runner implementation for this row",
			};
		case "blocked":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "run BLOCKED before this row was attempted",
			};
		case "candidate-failure":
			return {
				outcome: OUTCOME.UNTESTED,
				detail:
					detail || "the candidate never activated, so no probe was driven",
			};
		default:
			return {
				outcome: OUTCOME.UNTESTED,
				detail: `unknown probe status ${JSON.stringify(probe?.status ?? null)}`,
			};
	}
}

/** `PASS`, or `FAIL(cause)` / `UNTESTED(reason)` / `SKIPPED(reason)`. */
export function formatOutcome(result) {
	if (result.outcome === OUTCOME.PASS) return OUTCOME.PASS;
	return `${result.outcome}(${result.detail || "no reason recorded"})`;
}

/**
 * Counted coverage.
 *
 * `discovered` is the count of rows the BASELINE enumerated, passed in
 * separately and deliberately: taking it from `results.length` would make the
 * balance check below tautological, and an inert guard is worse than none. A
 * discovered row that produced no result — a `continue` added to the loop, a
 * probe map keyed wrong — then shows up as an ARITHMETIC MISMATCH instead of
 * quietly shrinking the denominator, which is the whole point of counting
 * coverage rather than claiming it.
 *
 * `rows` counts the rows this run actually ATTEMPTED: a blocked run attempts
 * none, so `rows` reads 0 rather than implying work that never happened.
 *
 * @param {ReadonlyArray<{ outcome: string, implemented?: boolean }>} results
 * @param {number} [discoveredCount]  rows enumerated in the baseline
 */
export function coverageArithmetic(results, discoveredCount) {
	const list = results ?? [];
	const count = (outcome) => list.filter((r) => r.outcome === outcome).length;
	const pass = count(OUTCOME.PASS);
	const fail = count(OUTCOME.FAIL);
	const untested = count(OUTCOME.UNTESTED);
	const skipped = count(OUTCOME.SKIPPED);
	const discovered =
		typeof discoveredCount === "number" ? discoveredCount : list.length;
	return {
		discovered,
		rows: list.filter((r) => r.implemented !== false).length,
		pass,
		fail,
		untested,
		skipped,
		balanced: pass + fail + untested + skipped === discovered,
	};
}

/** The single arithmetic line the skill quotes. */
export function renderCoverageLine(coverage) {
	const balance = coverage.balanced
		? ""
		: "  ** ARITHMETIC MISMATCH — a discovered row produced no outcome **";
	return (
		`coverage: discovered ${coverage.discovered} / rows ${coverage.rows} / ` +
		`untested ${coverage.untested}  ` +
		`(pass ${coverage.pass} · fail ${coverage.fail} · ` +
		`untested ${coverage.untested} · skipped ${coverage.skipped})${balance}`
	);
}

/**
 * The ship line. BLOCKED short-circuits everything: a run where pi could not
 * boot witnessed nothing, so it gets NO ship verdict — reporting it as
 * "do not ship" would be a verdict the run did not earn, and reporting it as
 * anything else would be worse.
 *
 * @param {ReadonlyArray<{ id: string, outcome: string, detail: string }>} results
 * @param {{ blocked?: boolean, blockedReason?: string }} [options]
 */
export function shipVerdict(results, options = {}) {
	if (options.blocked) {
		return {
			verdict: "BLOCKED",
			reason: options.blockedReason || "pi could not boot",
			caveats: [],
		};
	}
	// #2619 review N2, cell C2. A candidate that will not install or activate on
	// a pi that boots fine is a RESULT — do-not-ship — but it is not a row
	// failure: no probe ran, nothing was witnessed. Carrying it here, the way
	// `blocked` is carried, is what lets every row stay honestly UNTESTED while
	// the run still refuses to ship. Copying the cause onto eleven rows instead
	// produced eleven FAILs with an empty evidence dir.
	if (options.candidateFailure) {
		return {
			verdict: "DO-NOT-SHIP",
			reason: `the candidate never activated: ${options.candidateFailure}`,
			caveats: [],
		};
	}
	const list = results ?? [];
	const failed = list.filter((r) => r.outcome === OUTCOME.FAIL);
	if (failed.length > 0) {
		return {
			verdict: "DO-NOT-SHIP",
			reason: `${failed.length} row(s) FAILED`,
			caveats: failed.map((r) => `${r.id}: ${r.detail}`),
		};
	}
	// #2663: the tool-smoke install row is the release gate's ground truth for
	// the installer registry. A registry-unreachable classification (the
	// smoke's own transient-network branch) means that lane is UNMEASURED —
	// its skips are not green — so the run refuses a ship verdict even where
	// other rows passed. A genuine install failure outranks it (above): a real
	// defect is a verdict, not an unmeasurable run.
	if (options.inconclusiveReason) {
		return {
			verdict: "INCONCLUSIVE",
			reason: options.inconclusiveReason,
			caveats: [],
		};
	}
	const caveats = list.filter(
		(r) => r.outcome === OUTCOME.UNTESTED || r.outcome === OUTCOME.SKIPPED,
	);
	// Nothing was witnessed. Not blocked (pi booted), not failed (nothing
	// contradicted the criteria) — and therefore not shippable either, because
	// "no row disagreed" is not evidence. SHIP-WITH-CAVEATS here would be the
	// worst of the four: a green-shaped word over an empty measurement
	// (#2619 review, decision b).
	const passed = list.filter((r) => r.outcome === OUTCOME.PASS);
	if (passed.length === 0) {
		return {
			verdict: "INCONCLUSIVE",
			reason: `no row was witnessed (${list.length} discovered, 0 PASS)`,
			caveats: caveats.map((r) => `${r.id} ${formatOutcome(r)}`),
		};
	}
	if (caveats.length > 0) {
		return {
			verdict: "SHIP-WITH-CAVEATS",
			reason: `${caveats.length} row(s) produced no witness`,
			caveats: caveats.map((r) => `${r.id} ${formatOutcome(r)}`),
		};
	}
	return {
		verdict: "SHIP",
		reason: "every discovered row PASSED with a witness",
		caveats: [],
	};
}

/**
 * Split `supply-host-provided-deps.mjs --install-args` output into argv
 * entries.
 *
 * NEWLINE-delimited, never whitespace-delimited. A peer range can legitimately
 * contain a space — `@earendil-works/pi-tui@^0.84.1 || ^0.85.0` after #2586 —
 * and the upstream script emits one entry per line for exactly that reason.
 * A `/\s+/` split explodes such a range into three argv entries and hands
 * `npm install` the tokens `||` and `^0.85.0` as package names. This runner
 * shipped that split for one commit; the OR-form range arrived from master in
 * the same merge, which is the "textually clean merge that recombines into a
 * bug" shape.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parseSupplyArgs(stdout) {
	return String(stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Which of the two non-row failures a run hit, if either (#2619 review N3).
 *
 * The distinction is the one round 2 introduced and round 3 mechanises: BLOCKED
 * is about the HOST — a pi that cannot start a bare RPC session, probed BEFORE
 * anything is installed, so nothing about the candidate was measured. A
 * candidate that will not pack, install, or activate on a pi that boots fine is
 * a RESULT: do-not-ship. Living in `main()` as two `if`s, the distinction was
 * mutation-inert — re-classifying a candidate failure as BLOCKED left every
 * test green (MP-B).
 *
 * @param {{ bootProbeOk: boolean, bootProbeReason?: string, candidateError?: string, candidateRpcReason?: string }} observed
 * @returns {{ blocked: boolean, blockedReason: string, candidateFailure: string }}
 */
export function classifyRunFailure(observed) {
	const none = { blocked: false, blockedReason: "", candidateFailure: "" };
	if (!observed?.bootProbeOk) {
		return {
			blocked: true,
			blockedReason: `pi could not boot without the candidate: ${
				observed?.bootProbeReason || "no reason recorded"
			}`,
			candidateFailure: "",
		};
	}
	if (observed.candidateError) {
		return {
			...none,
			candidateFailure: `candidate could not be installed or activated: ${observed.candidateError}`,
		};
	}
	if (observed.candidateRpcReason) {
		return {
			...none,
			candidateFailure: `pi booted bare but not with the candidate installed: ${observed.candidateRpcReason}`,
		};
	}
	return none;
}

/**
 * The skills row's verdict, as a pure function of the `get_commands` response
 * (#2619 review N3).
 *
 * Three independent conditions, each of which has been the whole defect at some
 * point:
 *   - at least four skills registered at all (#2587's headline);
 *   - every one resolved INSIDE the installed package (a foreign tree adopted
 *     from a parent directory would otherwise read as success);
 *   - every one registered by `extension:index` — pi-lens's own
 *     `resources_discover` handler (#205) rather than the `pi.skills` manifest.
 *     #2587 is the proof that one registrar can be broken for four releases
 *     while the other silently covers for it.
 *
 * Lived inline in the probe, so deleting the third condition — the F2 fix
 * itself — left every test green (MP-D).
 *
 * @param {ReadonlyArray<{ source?: string, name?: string, sourceInfo?: { path?: string, source?: string } }>} commands
 * @param {string} installedPkgDir
 */
export function classifySkillsRegistration(commands, installedPkgDir) {
	const skills = (commands ?? []).filter((c) => c.source === "skill");
	const inPackage = skills.filter((c) =>
		String(c.sourceInfo?.path ?? "").startsWith(String(installedPkgDir ?? "")),
	);
	const byHandler = skills.filter(
		(c) => c.sourceInfo?.source === EXPECTED_SKILL_REGISTRAR,
	);
	const registrars = [
		...new Set(skills.map((c) => String(c.sourceInfo?.source ?? "(none)"))),
	];
	const shows =
		`${skills.length} skill command(s): ` +
		`${skills.map((c) => c.name).join(", ") || "(none)"}; ` +
		`${inPackage.length} resolved inside the installed package; ` +
		`registrar(s): ${registrars.join(", ") || "(none)"} ` +
		`(${byHandler.length}/${skills.length} via ${EXPECTED_SKILL_REGISTRAR})`;
	const ok =
		skills.length >= MIN_SHIPPED_SKILLS &&
		inPackage.length === skills.length &&
		byHandler.length === skills.length;
	return { status: ok ? "pass" : "fail", detail: shows, shows };
}

/**
 * What to do with one baseline row before any probe runs (#2619 review N2).
 *
 * Pure because the three non-probe paths are exactly where round 2 went wrong:
 * a candidate failure used to be copied onto every row as a FAIL, producing
 * eleven FAILed rows and an EMPTY evidence dir. Living as `else if`s inside
 * `main()`, that was mutation-inert.
 *
 * `attempted` is what the coverage triple's `rows` counts — rows this run
 * actually DROVE a probe for. All three non-probe paths set it false.
 *
 * @param {{ hasProbe: boolean, blocked?: boolean, blockedReason?: string, candidateFailure?: string }} run
 * @returns {{ attempted: boolean, probe?: { status: string, detail?: string } }}
 */
export function rowProbeRequest(run) {
	if (!run?.hasProbe) {
		return { attempted: false, probe: { status: "unimplemented" } };
	}
	if (run.blocked) {
		return {
			attempted: false,
			probe: { status: "blocked", detail: run.blockedReason },
		};
	}
	if (run.candidateFailure) {
		return {
			attempted: false,
			probe: { status: "candidate-failure", detail: run.candidateFailure },
		};
	}
	return { attempted: true };
}

/**
 * The `install-selftest` row's verdict, as a pure function of the packaged
 * selftest's exit code and stdout (#2619 review N6).
 *
 * Extracted so the empty-stdout cell is reachable in a test: a selftest that
 * exits 0 having printed nothing satisfies "no `[FAIL]` line" vacuously. This
 * function keeps that reading — the process DID succeed — and
 * `finalizeRowOutcome` is the single place that refuses to call an empty
 * witness a pass, rather than two overlapping guards for one property.
 *
 * @param {number} code
 * @param {string} stdout
 */
export function classifySelftestOutput(code, stdout) {
	const lines = String(stdout ?? "").split(/\r?\n/);
	const failLines = lines.filter((line) => line.includes("[FAIL]"));
	const summary = lines.find((line) => line.startsWith("selftest:")) ?? "";
	const shows = `exit ${code}; ${failLines.length} [FAIL] line(s); ${summary}`;
	return {
		status: code === 0 && failLines.length === 0 ? "pass" : "fail",
		detail: shows,
		shows,
	};
}

/**
 * The tool-smoke install lane's report → the row's probe verdict (#2663).
 *
 *   - any genuine install failure (the smoke's red row, #2661) → `"fail"`:
 *     the row FAILs and the run is do-not-ship (exit 1);
 *   - no genuine failure but at least one registry-unreachable tool →
 *     `"unreachable"` with `networkBlocked: true`: the lane is UNMEASURED, so
 *     the run refuses a ship verdict (INCONCLUSIVE, exit 3) instead of
 *     reading the skips as green;
 *   - otherwise → `"pass"`: every entry resolved, with the legitimately
 *     unavailable ones (toolchain absent, declined) named in the detail.
 *
 * The classification itself is never re-derived here — the row/skip verdict
 * per tool is the smoke's `classifyInstallOutcome` (#2661), consumed through
 * the lane's JSON; this function only maps that verdict onto the release
 * gate's outcomes.
 *
 * A lane that produced no parseable report — crashed, missing dist build,
 * timed out — is `"error"`: the check did not run, and a release gate whose
 * check did not run is not a pass. `toolCount === 0` is the same refusal: a
 * lane that enumerated no npm/pip entries witnessed nothing.
 *
 * @param {{ lane?: string, toolCount?: number, installed?: number, ok?: boolean, results?: Array<{ toolId: string, state: string, detail?: string, networkUnreachable?: boolean }> } | null} report
 * @param {{ exitCode?: number, stderrTail?: string, timedOut?: boolean, stdout?: string }} [context]
 */
export function classifyToolSmokeInstallReport(report, context = {}) {
	const stderrTail = String(context.stderrTail ?? "")
		.trim()
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0)
		.slice(-1)[0];
	const witnessContent = report
		? JSON.stringify(report)
		: String(context.stdout ?? "");
	if (!report) {
		const why = context.timedOut
			? "the install lane timed out"
			: `the install lane produced no parseable result${
					context.exitCode ? ` (exit ${context.exitCode})` : ""
				}`;
		return {
			status: "error",
			detail: `${why}${stderrTail ? `: ${stderrTail}` : ""}`,
			shows: why,
			networkBlocked: false,
			witnessContent,
		};
	}
	if (!Number.isInteger(report.toolCount) || report.toolCount <= 0) {
		return {
			status: "error",
			detail: "the install lane enumerated no npm/pip registry entries",
			shows: "install lane enumerated no npm/pip registry entries",
			networkBlocked: false,
			witnessContent,
		};
	}
	const results = report.results ?? [];
	const failures = results.filter((r) => r?.state === "fail");
	if (failures.length > 0) {
		const shows = `${failures.length} genuine install failure(s): ${failures
			.map((f) => f.detail || f.toolId)
			.join("; ")}`;
		return {
			status: "fail",
			detail: shows,
			shows,
			networkBlocked: false,
			witnessContent,
		};
	}
	const network = results.filter((r) => r?.networkUnreachable);
	if (network.length > 0) {
		const shows =
			`registry unreachable for ${network.length} npm/pip ` +
			`${network.length === 1 ? "entry" : "entries"} ` +
			`(${network.map((r) => r.toolId).join(", ")}); install ground truth unmeasured`;
		return {
			status: "unreachable",
			detail: shows,
			shows,
			networkBlocked: true,
			witnessContent,
		};
	}
	const skips = results.filter((r) => r?.state === "skip");
	const shows =
		`${report.installed}/${report.toolCount} npm/pip registry entries resolved` +
		(skips.length > 0
			? `; ${skips.length} legitimately unavailable (${skips
					.map((s) => s.toolId)
					.join(", ")})`
			: "");
	return {
		status: "pass",
		detail: shows,
		shows,
		networkBlocked: false,
		witnessContent,
	};
}

/**
 * Run the installed smoke boundary for the registry baseline row.
 * @param {{ exportRoot: string, installedPkgDir: string, projectDir: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {{ status: string, detail: string, shows?: string, witness?: { ext: string, content: string } }}
 */
export function runToolSmokeInstallProbe(ctx) {
	if (!ctx.installedPkgDir) {
		return {
			status: "error",
			detail: "installer root is missing; installed registry was not measured",
		};
	}
	const script = path.join(ctx.exportRoot, "scripts", "smoke-tools.mjs");
	if (!fs.existsSync(script)) {
		return {
			status: "fail",
			detail: `smoke-tools.mjs is not in the export root (${script})`,
		};
	}
	let report = null;
	let context = {};
	const parseSmokeOutput = (stdout) => {
		try {
			return { report: JSON.parse(String(stdout ?? "").trim()) };
		} catch {
			return { context: { stdout } };
		}
	};
	try {
		const stdout = execFileSync(
			process.execPath,
			[
				script,
				"--install",
				"--install-registry",
				`--installer-root=${ctx.installedPkgDir}`,
			],
			{
				cwd: ctx.projectDir,
				encoding: "utf8",
				env: ctx.env,
				timeout: 900_000,
				maxBuffer: 10 * 1024 * 1024,
			},
		);
		({ report, context } = parseSmokeOutput(stdout));
	} catch (err) {
		({ report, context } = parseSmokeOutput(err?.stdout));
		context = {
			...context,
			exitCode: err?.status,
			stderrTail: err?.stderr,
			timedOut: Boolean(err?.killed),
		};
	}
	const classified = classifyToolSmokeInstallReport(report, context);
	return {
		status: classified.status,
		detail: classified.detail,
		shows: classified.shows,
		witness: { ext: "json", content: classified.witnessContent },
	};
}

/**
 * Hard Rule 1, as code: a row is PASS only when an artifact SHOWS the pass
 * criterion (#2619 review, cells C7 and C7b).
 *
 * The ABSENCE check alone is unreachable — every shipped probe attaches a
 * witness object on its pass path, so `!witnessPath` never fires (#2619 review
 * N6). The reachable failure is an EMPTY one: `install-selftest` passes on
 * `exit 0` with no `[FAIL]` line, and writes the selftest's stdout as its
 * witness, so a packaged selftest that exits 0 having printed nothing would
 * PASS with a 0-byte evidence file and an empty excerpt — a green row showing
 * literally nothing. Both are downgraded here.
 *
 * `downgraded` is set so the caller can replace the probe's pass excerpt with
 * the reason: leaving `shows` as the (empty, or now-false) pass line would put
 * the claim back in the report the downgrade just removed.
 *
 * @param {{ outcome: string, detail: string }} classified
 * @param {string | undefined} witnessPath
 * @param {string | undefined} witnessContent
 */
export function finalizeRowOutcome(classified, witnessPath, witnessContent) {
	if (classified.outcome !== OUTCOME.PASS) return classified;
	const empty = String(witnessContent ?? "").trim() === "";
	if (!witnessPath || empty) {
		return {
			outcome: OUTCOME.UNTESTED,
			detail: witnessPath
				? "probe reported pass but its witness is empty " +
					`(${witnessPath} has no content to show)`
				: "probe reported pass but captured no witness",
			downgraded: true,
		};
	}
	return classified;
}

/**
 * What the report's "what the witness shows" column prints for one row.
 *
 * A downgraded row (C7/C7b) shows the DOWNGRADE REASON, never the probe's pass
 * excerpt: leaving the claim there would put back in the report exactly what
 * the downgrade removed — a row reading UNTESTED beside a line asserting it
 * passed.
 *
 * @param {{ detail: string, downgraded?: boolean }} classified
 * @param {string | undefined} probeShows
 */
export function rowReportShows(classified, probeShows) {
	if (classified.downgraded) return classified.detail;
	return probeShows ?? classified.detail;
}

/**
 * The refusal message for a dirty checkout, or null when it is clean.
 *
 * A `--from tree` run packs `git archive HEAD`, so an uncommitted edit would be
 * QA'd as its last commit and the report's "QA target" would name something the
 * operator is not looking at. That is a USAGE error (exit 4), not a candidate
 * failure: nothing about the release was measured, and reporting every row
 * FAILed for it would be the runner lying in the other direction.
 *
 * @param {string} porcelain  output of `git status --porcelain`
 * @returns {string | null}
 */
export function dirtyCheckoutRefusal(porcelain) {
	const dirty = String(porcelain ?? "").trim();
	if (dirty === "") return null;
	return (
		"the checkout is dirty, so `git archive HEAD` would pack something other " +
		"than what you are looking at. Commit first, or QA a published release " +
		`with --from npm:<spec>. Uncommitted:\n${dirty}`
	);
}

/**
 * Exit code per verdict.
 *
 * | code | verdict | meaning |
 * | --- | --- | --- |
 * | 0 | SHIP | every discovered row PASSED with a witness |
 * | 1 | DO-NOT-SHIP | a row FAILED, or the candidate would not install/activate |
 * | 2 | SHIP-WITH-CAVEATS | every witnessed row passed, some produced no witness |
 * | 3 | BLOCKED / INCONCLUSIVE | no verdict: pi did not boot, or nothing was witnessed |
 * | 4 | usage or self-check error | bad option, unparseable baseline, arithmetic mismatch |
 *
 * **2 is the EXPECTED verdict for a working-tree run**: the `git-install` row
 * is SKIPPED without `--git-ref`. A CI lane should treat 2 as a warning, and
 * 1/3/4 as failures.
 */
export function verdictExitCode(verdict) {
	switch (verdict) {
		case "SHIP":
			return 0;
		case "DO-NOT-SHIP":
			return 1;
		case "SHIP-WITH-CAVEATS":
			return 2;
		case "BLOCKED":
		case "INCONCLUSIVE":
			return 3;
		default:
			return 4;
	}
}

/**
 * The report. Each row line carries its witness PATH and the excerpt that SHOWS
 * the asserted result — a witness that merely exists is not a witness.
 */
export function renderReport({
	rows,
	results,
	coverage,
	verdict,
	context = {},
}) {
	const byId = new Map((results ?? []).map((r) => [r.id, r]));
	const lines = [];
	lines.push("# Release-QA report");
	lines.push("");
	for (const [key, value] of Object.entries(context)) {
		lines.push(`- **${key}**: ${value}`);
	}
	lines.push("");
	lines.push(`## Verdict: ${verdict.verdict}`);
	lines.push("");
	lines.push(verdict.reason);
	if (verdict.verdict === "BLOCKED") {
		lines.push("");
		lines.push(
			"No ship verdict is issued for a blocked run: pi itself did not boot, " +
				"so nothing about the candidate was measured.",
		);
	}
	if (
		verdict.verdict === "DO-NOT-SHIP" &&
		verdict.reason.startsWith("the candidate never activated")
	) {
		lines.push("");
		lines.push(
			"No row was driven: pi booted, the candidate did not. Every row is " +
				"UNTESTED, and the run refuses to ship on the activation failure " +
				"alone.",
		);
	}
	if (verdict.verdict === "INCONCLUSIVE") {
		lines.push("");
		lines.push(
			"No ship verdict is issued: pi booted, but not one row produced a " +
				"witness. An unwitnessed run is not a passing run.",
		);
	}
	for (const caveat of verdict.caveats) lines.push(`- ${caveat}`);
	lines.push("");
	lines.push("```");
	lines.push(renderCoverageLine(coverage));
	lines.push("```");
	lines.push("");
	lines.push(
		"Legend — `discovered`: rows in the baseline matrix. `rows`: of those, " +
			"the ones this run actually DROVE a probe for; a row the runner has no " +
			"probe for is not counted, and a BLOCKED run drives none, so `rows` " +
			"reads 0. A SKIPPED row IS counted: its probe ran and decided the row " +
			"unreachable. `untested`: rows that produced no witness. The four " +
			"outcomes partition `discovered`, not `rows`.",
	);
	lines.push("");
	lines.push("## Rows");
	lines.push("");
	lines.push(
		"| row id | modality | outcome | witness | what the witness shows |",
	);
	lines.push("| --- | --- | --- | --- | --- |");
	for (const row of rows ?? []) {
		const result = byId.get(row.id);
		const outcome = result ? formatOutcome(result) : "UNTESTED(not run)";
		const witness = result?.witnessPath ?? "—";
		const shows = (result?.shows ?? "—").replace(/\s*\|\s*/g, " / ");
		lines.push(
			`| ${row.id} | ${row.modality} | ${outcome} | ${witness} | ${shows} |`,
		);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// ===========================================================================
// Driver — the impure half.
// ===========================================================================

const IS_WINDOWS = process.platform === "win32";
const NPM_BIN = IS_WINDOWS ? "npm.cmd" : "npm";
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DEFAULT_POLL_CAP_MS = 120_000;
const NPM_TIMEOUT_MS = 600_000;
const RPC_TIMEOUT_MS = 60_000;
const MCP_CALL_TIMEOUT_MS = 180_000;

export function parseArgs(argv) {
	const opts = {
		pi: "pi",
		from: "tree",
		baseline: path.join(REPO_ROOT, "docs", "release-qa-baseline.md"),
		out: process.cwd(),
		pollCapMs: DEFAULT_POLL_CAP_MS,
		gitRef: undefined,
		keep: false,
		scratchRoot: undefined,
	};
	// Every value-taking option reads its value through `value()`, which
	// refuses a missing one. A trailing `--pi` used to leave `opts.pi`
	// undefined and the run then died deep in a spawn; a trailing
	// `--poll-cap-ms` produced `Number(undefined)` = NaN, and a NaN cap makes
	// `pollToTerminal` expire on its first check — turning a polled row
	// silently UNTESTED, which is precisely the "counted, not claimed"
	// property this runner exists to hold.
	const value = (i, flag) => {
		const raw = argv[i];
		if (raw === undefined) throw new Error(`${flag} requires a value`);
		return raw;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pi") opts.pi = value(++i, arg);
		else if (arg === "--from") opts.from = value(++i, arg);
		else if (arg === "--baseline") opts.baseline = value(++i, arg);
		else if (arg === "--out") opts.out = value(++i, arg);
		else if (arg === "--git-ref") opts.gitRef = value(++i, arg);
		else if (arg === "--poll-cap-ms") {
			const raw = value(++i, arg);
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`--poll-cap-ms must be a positive number, got ${raw}`);
			}
			opts.pollCapMs = parsed;
		} else if (arg === "--keep" || arg === "--keep-scratch") opts.keep = true;
		else if (arg === "--scratch-root") opts.scratchRoot = value(++i, arg);
		else throw new Error(`unknown option: ${arg}`);
	}
	return opts;
}

function log(message) {
	console.log(`[release-qa] ${message}`);
}

/**
 * Shell-free `npm` with an argv array, under the PINNED env.
 *
 * `env` is required, not optional (#2619 review F1). It used to be absent, so
 * every `npm` child inherited the maintainer's real environment — and npm
 * runs OUR lifecycle scripts: `prepare` invokes
 * `scripts/warm-loader-cache.mjs`, whose install-log sink is
 * `PI_LENS_INSTALL_LOG` or, failing that, `PI_LENS_HOME/install.log`.
 * Pinning the explicit file keeps the sink and the assertion independent of
 * fallback resolution.
 */
export function npm(args, cwd, env) {
	// #2619 review N1: `env` was an OPTIONAL positional, so dropping it at a
	// call site reproduced the exact F1 defect — npm running OUR lifecycle
	// scripts against the maintainer's real HOME — while every test stayed
	// green. A missing env is now a loud crash, not a silent leak.
	if (!env) {
		throw new Error(
			"npm() requires the pinned scratch env: npm runs pi-lens's own " +
				"prepare/prepack, which write through os.homedir() and " +
				"PI_LENS_INSTALL_LOG (#2619 review F1/N1)",
		);
	}
	return execFileSync(NPM_BIN, args, {
		cwd,
		encoding: "utf8",
		timeout: NPM_TIMEOUT_MS,
		env,
	});
}

/**
 * The scratch environment EVERY child process below runs under — `pi`, the
 * MCP server, `node`, and `npm` alike.
 *
 * Each pin exists because a specific writer reads it, and the set is what
 * `tests/scripts/release-qa.test.ts`'s hermeticity canary asserts against a
 * real child process:
 *
 * - `HOME` / `USERPROFILE` — `os.homedir()`, which is what pi resolves `~/.pi`
 *   from and what every fallback sink below lands in when its own variable is
 *   unset.
 * - `PI_LENS_HOME` — pi-lens's logs, ledgers and caches.
 * - `PILENS_DATA_DIR` — project-scoped pi-lens data.
 * - `PI_LENS_INSTALL_LOG` — `scripts/warm-loader-cache.mjs`'s install log.
 *   It overrides the `install.log` file under `PI_LENS_HOME`; pinning it makes
 *   the sink explicit and keeps the test's assertion independent of fallback
 *   resolution.
 * - `npm_config_cache` — npm's own cache, so a QA run cannot mutate the
 *   developer's package cache either.
 *
 * `#2506` is the standing rule this implements: an ad-hoc probe against real
 * code with no pins writes into the maintainer's real dirs.
 */
export function scratchEnv(scratchRoot, extra = {}) {
	const home = path.join(scratchRoot, "home");
	// Keep only process settings needed to find the host tools and preserve their
	// locale. In particular, never inherit host package-manager policy overrides.
	return {
		...Object.fromEntries(
			["PATH", "Path", "PATHEXT", "SystemRoot", "LANG", "LC_ALL", "CI"]
				.filter((key) => process.env[key] !== undefined)
				.map((key) => [key, process.env[key]]),
		),
		HOME: home,
		USERPROFILE: home,
		PI_LENS_HOME: path.join(home, ".pi-lens"),
		PILENS_DATA_DIR: path.join(home, ".pilens-data"),
		PI_LENS_INSTALL_LOG: path.join(home, ".pi-lens", "install.log"),
		npm_config_cache: path.join(scratchRoot, "npm-cache"),
		// HOME is scratch-pinned, so this deliberately permits pip to measure
		// package resolution instead of letting PEP 668 hide dead registry entries.
		PIP_BREAK_SYSTEM_PACKAGES: "1",
		ANTHROPIC_API_KEY:
			process.env.ANTHROPIC_API_KEY || "sk-ant-dummy-release-qa",
		...extra,
	};
}

/**
 * Every environment variable `scratchEnv` pins inside the scratch root, and
 * the writer each one steers. Exported so the hermeticity canary enumerates
 * the same list the runner does instead of re-typing it — a second copy is
 * how one of them goes missing (which is what F1 was).
 */
export const PINNED_ENV_KEYS = Object.freeze([
	"HOME",
	"USERPROFILE",
	"PI_LENS_HOME",
	"PILENS_DATA_DIR",
	"PI_LENS_INSTALL_LOG",
	"npm_config_cache",
]);

/**
 * Export the committed tree into the scratch root and pack THERE (#2619
 * review F1).
 *
 * `npm pack` runs our own `prepack` and `prepare`, and both write into the
 * directory they run in: `scripts/strip-dev-deps-for-pack.mjs` rewrites
 * `package.json` AND `package-lock.json` (restored only by `postpack`, with no
 * signal trap, so an interrupted pack leaves the checkout stripped), and
 * `prepare` rebuilds `dist/`, downloads grammars over the network, and
 * reinstalls the git hooks. Running that in the live checkout makes a QA run a
 * mutation of the thing under test. Exporting first makes the pack's blast
 * radius the scratch root and nothing else.
 *
 * `git archive` emits the COMMITTED tree, so a dirty checkout would silently
 * QA something other than what the operator is looking at. That is refused
 * rather than warned about: a release is cut from a commit, and a report whose
 * "QA target" does not name what was measured is the failure mode this whole
 * runner exists to end. `--from npm:<spec>` needs no export and is unaffected.
 *
 * `setup-git-hooks.mjs` no-ops in the export (`if (!existsSync(".git")) return`),
 * which is why a bare tree export is enough and a full clone is not needed.
 */
function exportHeadForPack(scratchRoot) {
	const commit = String(
		gitExecFileSync(["rev-parse", "HEAD"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}),
	).trim();
	const dir = path.join(scratchRoot, "export");
	fs.mkdirSync(dir, { recursive: true });
	const tar = path.join(scratchRoot, "export.tar");
	gitExecFileSync(["archive", "--format=tar", `--output=${tar}`, "HEAD"], {
		cwd: REPO_ROOT,
	});
	execFileSync("tar", ["-xf", tar, "-C", dir], {
		timeout: NPM_TIMEOUT_MS,
		env: scratchEnv(scratchRoot),
	});
	fs.rmSync(tar, { force: true });
	return { dir, commit };
}

/**
 * The fixture project every row is witnessed against.
 *
 * `.pi-lens.json` carries `lsp.enabled` DELIBERATELY: it is a global-only
 * setting, so placing it at project tier is a real, deterministic
 * "input silently ignored" event. That one file therefore serves two rows —
 * config-provenance (it is a contributing document) and degradation-visible
 * (it produces a `config-ignored` degradation naming this file). Every other
 * ignored-input trigger I probed either was accepted as ordinary provenance
 * (an unknown key) or needed a network failure to reproduce (auto-install).
 */
function setUpFixture(projectDir) {
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, "a.ts"),
		"export function releaseQaFixtureSymbol(n: number): number {\n\treturn n + 1;\n}\n",
	);
	fs.writeFileSync(
		path.join(projectDir, "package.json"),
		'{ "name": "release-qa-fixture", "version": "1.0.0", "type": "module" }\n',
	);
	fs.writeFileSync(
		path.join(projectDir, ".pi-lens.json"),
		'{\n\t"lsp": { "enabled": true }\n}\n',
	);
	gitExecFileSync(["init", "-q"], { cwd: projectDir });
	gitExecFileSync(["config", "user.email", "t@t.t"], { cwd: projectDir });
	gitExecFileSync(["config", "user.name", "t"], { cwd: projectDir });
	gitExecFileSync(["add", "-A"], { cwd: projectDir });
	gitExecFileSync(["commit", "-qm", "init"], { cwd: projectDir });
}

/**
 * Drive one headless `pi --mode rpc` session and capture the `get_commands`
 * response plus any `extension_error` events. This is the #2589 mechanism —
 * the same JSONL framing and the same command `scripts/rpc-load-check.mjs`
 * uses in install-smoke's `pi-load` job — captured once and asserted on by two
 * rows rather than run twice.
 */
function captureGetCommands({ piBin, cwd, env, timeoutMs = RPC_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(piBin, ["--mode", "rpc", "--no-session"], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env,
			});
		} catch (err) {
			resolve({ ok: false, reason: `spawn failed: ${err?.message || err}` });
			return;
		}
		const extensionErrors = [];
		const stderr = [];
		let buf = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					reason: `no get_commands response within ${timeoutMs}ms`,
					extensionErrors,
					stderr: stderr.join(""),
				}),
			timeoutMs,
		);
		child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let i = buf.indexOf("\n");
			while (i >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
				if (!line.trim()) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (
					(message.type === "event" && message.event === "extension_error") ||
					message.type === "extension_error"
				) {
					extensionErrors.push(message);
				}
				if (message.type === "response" && message.command === "get_commands") {
					finish({
						ok: true,
						commands: message.data?.commands ?? [],
						extensionErrors,
						raw: message,
					});
				}
			}
		});
		child.on("error", (err) =>
			finish({ ok: false, reason: `pi error: ${err?.message || err}` }),
		);
		child.on("exit", (code) =>
			finish({
				ok: false,
				reason: `pi exited early (code ${code})`,
				extensionErrors,
				stderr: stderr.join(""),
			}),
		);
		// Extensions register asynchronously; ask once they have had a moment.
		setTimeout(() => {
			try {
				child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
			} catch {}
		}, 3000);
	});
}

/** A newline-delimited JSON-RPC client for the pi-lens MCP stdio server. */
class McpSession {
	constructor(serverJs, cwd, env) {
		this.child = spawn(process.execPath, [serverJs], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = [];
		this.buf = "";
		this.child.stderr.on("data", (chunk) => this.stderr.push(chunk.toString()));
		this.child.stdout.on("data", (chunk) => {
			this.buf += chunk.toString();
			let i = this.buf.indexOf("\n");
			while (i >= 0) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				i = this.buf.indexOf("\n");
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
			}
		});
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code) => {
				for (const [, waiter] of this.pending) {
					waiter.resolve({ error: { message: `server exited (${code})` } });
				}
				this.pending.clear();
				resolve(code);
			});
		});
	}

	request(method, params, timeoutMs = MCP_CALL_TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ error: { message: `timeout after ${timeoutMs}ms` } });
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			try {
				this.child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: { message: `write failed: ${err?.message || err}` } });
			}
		});
	}

	notify(method, params) {
		try {
			this.child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		} catch {}
	}

	/** The first text block of a tools/call result, or an error marker. */
	async callToolText(name, args, timeoutMs) {
		const response = await this.request(
			"tools/call",
			{ name, arguments: args },
			timeoutMs,
		);
		if (response.error) {
			return { ok: false, text: `JSON-RPC error: ${response.error.message}` };
		}
		const text = response.result?.content?.[0]?.text ?? "";
		return { ok: response.result?.isError !== true, text: String(text) };
	}

	async close() {
		try {
			this.child.kill("SIGTERM");
		} catch {}
		await Promise.race([
			this.exited,
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
		try {
			this.child.kill("SIGKILL");
		} catch {}
	}
}

/**
 * Poll `attempt` until it reports terminal, or the cap elapses.
 *
 * The cap is a real deadline measured against the wall clock, and expiry
 * returns `{ status: "expired" }` — which `classifyRowOutcome` turns into UNTESTED.
 * Nothing here can turn a timeout into a pass.
 */
export async function pollToTerminal(attempt, { capMs, intervalMs }) {
	const deadline = Date.now() + capMs;
	let last = { terminal: false, detail: "never attempted" };
	let attempts = 0;
	while (Date.now() < deadline) {
		attempts++;
		last = await attempt();
		if (last.terminal) return { status: "terminal", attempts, value: last };
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, remaining)),
		);
	}
	return {
		status: "expired",
		attempts,
		value: last,
		detail:
			`polling cap ${capMs}ms expired after ${attempts} attempt(s) without a ` +
			`terminal state — last: ${last.detail}`,
	};
}

// --- Row probes ------------------------------------------------------------
//
// One entry per baseline row id. A row id present here but absent from
// docs/release-qa-baseline.md (or the reverse) is a self-check failure, not a
// silently skipped row — the matrix document is the single source of truth for
// the row list and this map may never become a second copy of it.

/** @param {any} ctx */
const ROW_PROBES = {
	"pack-skills-payload": async (ctx) => {
		const listing = ctx.packListing;
		if (!listing) {
			return { status: "fail", detail: "no pack listing was captured" };
		}
		const files = (listing.files ?? []).map((f) => f.path ?? "");
		const skillDocs = files.filter((p) => /^skills\/.*\/SKILL\.md$/.test(p));
		const hasEntry = files.includes("dist/index.js");
		const shows = `dist/index.js present=${hasEntry}; SKILL.md in pack=${skillDocs.length}`;
		return {
			status: hasEntry && skillDocs.length >= 4 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "json", content: JSON.stringify(listing, null, 2) },
		};
	},

	"install-selftest": async (ctx) => {
		const selftest = path.join(
			ctx.installedPkgDir,
			"scripts",
			"install-selftest.mjs",
		);
		if (!fs.existsSync(selftest)) {
			return {
				status: "fail",
				detail: `install-selftest.mjs is not in the installed package (${selftest})`,
			};
		}
		let stdout = "";
		let code = 0;
		try {
			stdout = execFileSync(process.execPath, [selftest, "--allow-soft"], {
				cwd: ctx.projectDir,
				encoding: "utf8",
				env: ctx.env,
				timeout: 300_000,
			});
		} catch (err) {
			stdout = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
			code = typeof err?.status === "number" ? err.status : 1;
		}
		return {
			...classifySelftestOutput(code, stdout),
			witness: { ext: "txt", content: stdout },
		};
	},

	"skills-registered": async (ctx) => {
		const capture = ctx.rpc;
		if (!capture?.ok) {
			return { status: "fail", detail: capture?.reason ?? "no RPC capture" };
		}
		const verdict = classifySkillsRegistration(
			capture.commands,
			ctx.installedPkgDir,
		);
		return {
			...verdict,
			witness: {
				ext: "json",
				content: JSON.stringify(capture.raw ?? capture, null, 2),
			},
		};
	},

	"commands-registered": async (ctx) => {
		const capture = ctx.rpc;
		if (!capture?.ok) {
			return { status: "fail", detail: capture?.reason ?? "no RPC capture" };
		}
		const lens = capture.commands.filter(
			(c) =>
				c.source === "extension" && String(c.name ?? "").startsWith("lens-"),
		);
		const errors = capture.extensionErrors ?? [];
		const shows =
			`${lens.length} lens-* command(s): ${lens.map((c) => c.name).join(", ") || "(none)"}; ` +
			`${errors.length} extension_error event(s)`;
		return {
			status: lens.length >= 1 && errors.length === 0 ? "pass" : "fail",
			detail: shows,
			shows,
			// The witness is the RAW get_commands response plus the raw
			// extension_error events — the thing the baseline promises — not the
			// filtered list, which is this probe's own conclusion and would agree
			// with itself no matter what pi said (#2619 review F3). The derived
			// counts live in `shows`.
			witness: {
				ext: "json",
				content: JSON.stringify(
					{ response: capture.raw ?? null, extensionErrors: errors },
					null,
					2,
				),
			},
		};
	},

	"mcp-tools-registered": async (ctx) => {
		const listed = ctx.mcpTools;
		if (!listed?.ok) {
			return {
				status: "fail",
				detail: listed?.reason ?? "no tools/list result",
			};
		}
		const names = listed.names;
		const required = [
			"pilens_analyze",
			"pilens_diagnostics",
			"pilens_turn_end",
			"pilens_lsp_navigation",
			"pilens_health",
		];
		const missing = required.filter((n) => !names.includes(n));
		const misnamed = names.filter((n) => !n.startsWith("pilens_"));
		const shows =
			`${names.length} tool(s) advertised; ${missing.length} required missing ` +
			`(${missing.join(", ") || "none"}); ${misnamed.length} not pilens_* ` +
			`(${misnamed.join(", ") || "none"})`;
		return {
			status: missing.length === 0 && misnamed.length === 0 ? "pass" : "fail",
			detail: shows,
			shows,
			// Raw tools/list result, not the extracted names (#2619 review F3).
			witness: {
				ext: "json",
				content: JSON.stringify(listed.result ?? null, null, 2),
			},
		};
	},

	"mcp-diagnostics-full": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		// The genuinely async row: the full scan runs project-wide analyzers, so
		// it is polled to a terminal state and expiry is UNTESTED, never PASS.
		let lastText = "";
		const polled = await pollToTerminal(
			async () => {
				const result = await mcp.callToolText(
					"pilens_diagnostics",
					{ mode: "full", refreshRunners: "cheap" },
					ctx.pollCapMs,
				);
				lastText = result.text;
				const summary = /Summary \((\d+) files? diagnosed this session\)/.exec(
					result.text,
				);
				const diagnosed = summary ? Number(summary[1]) : 0;
				return {
					terminal: result.ok && diagnosed >= 1,
					detail: result.ok
						? `summary reports ${diagnosed} file(s) diagnosed`
						: `tool error: ${result.text.slice(0, 200)}`,
				};
			},
			{ capMs: ctx.pollCapMs, intervalMs: 5000 },
		);
		const witness = { ext: "txt", content: lastText };
		if (polled.status === "expired") {
			return { status: "expired", detail: polled.detail, witness };
		}
		return {
			status: "pass",
			detail: polled.value.detail,
			shows: polled.value.detail,
			witness,
		};
	},

	"mcp-turn-end": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_turn_end", {
			files: ["a.ts"],
		});
		const match = /Turn-end over (\d+) file\(s\)\./.exec(result.text);
		const covered = match ? Number(match[1]) : 0;
		const shows = result.ok
			? `turn-end ran over ${covered} file(s)`
			: `tool error: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && covered >= 1 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"mcp-lsp-navigation": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_lsp_navigation", {
			operation: "documentSymbol",
			path: "a.ts",
		});
		const named = result.text.includes("releaseQaFixtureSymbol");
		const shows = named
			? "documentSymbol answered with releaseQaFixtureSymbol"
			: `documentSymbol did not name the fixture symbol: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && named ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"config-provenance": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_effective_config", {
			file: "a.ts",
		});
		const configPath = path.join(ctx.projectDir, ".pi-lens.json");
		const named = result.text.includes(configPath);
		const shows = named
			? `effective config names the fixture's ${configPath} as contributing`
			: `fixture config not named in the provenance: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && named ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"degradation-visible": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_health", {});
		const line = result.text
			.split(/\r?\n/)
			.find(
				(candidate) =>
					candidate.includes("config-ignored") &&
					candidate.includes(".pi-lens.json"),
			);
		const shows = line
			? `health reports: ${line.trim().slice(0, 200)}`
			: "no config-ignored degradation naming the fixture config in health output";
		return {
			status: result.ok && Boolean(line) ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"git-install-loads": async (ctx) => {
		if (!ctx.gitRef) {
			return {
				status: "unreachable",
				detail:
					"no --git-ref given; a git: install resolves a PUSHED ref, not the " +
					"working tree, so this row is reachable only once the release ref exists",
			};
		}
		const home = path.join(ctx.scratchRoot, "git-home");
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({
				npmCommand: ["npm"],
				defaultProvider: "anthropic",
				defaultModel: "claude-sonnet-4-6",
			}),
		);
		const env = { ...ctx.env, HOME: home, USERPROFILE: home };
		// pi separates the ref with `@`, NOT `#` — read from its own parser,
		// `splitRef` in `@earendil-works/pi-coding-agent` `dist/utils/git.js`
		// (0.80.10, identical in 0.85.1): the non-URL branch takes
		// `pathWithMaybeRef.indexOf("@")` as the separator, so a `#ref` form is
		// carried into the clone URL verbatim and `git clone` fails. Verified
		// live: `#fix/2606-release-qa` produced
		// `git clone https://github.com/apmantza/pi-lens#fix/2606-release-qa`.
		const source = `git:github.com/apmantza/pi-lens@${ctx.gitRef}`;
		let installLog = "";
		try {
			installLog = execFileSync(ctx.piBin, ["install", source], {
				cwd: ctx.projectDir,
				encoding: "utf8",
				env,
				timeout: 900_000,
			});
		} catch (err) {
			const detail = `pi install ${source} failed: ${(err?.stderr || err?.message || err).toString().slice(0, 300)}`;
			return {
				status: "fail",
				detail,
				shows: detail,
				witness: { ext: "txt", content: `${installLog}\n${err?.stdout ?? ""}` },
			};
		}
		const capture = await captureGetCommands({
			piBin: ctx.piBin,
			cwd: ctx.projectDir,
			env,
		});
		if (!capture.ok) {
			return { status: "fail", detail: capture.reason ?? "RPC capture failed" };
		}
		const skills = capture.commands.filter((c) => c.source === "skill");
		const lens = capture.commands.filter(
			(c) =>
				c.source === "extension" && String(c.name ?? "").startsWith("lens-"),
		);
		const shows = `git:${ctx.gitRef} → ${lens.length} lens-* command(s), ${skills.length} skill(s)`;
		return {
			status: lens.length >= 1 && skills.length >= 4 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: {
				ext: "json",
				content: JSON.stringify(capture.raw ?? capture, null, 2),
			},
		};
	},

	// The installer registry's ground truth (#2663): the smoke's install lane
	// runs its harness from the exported source tree but loads the INSTALLED
	// package's own dist, so a registry entry that is dead in the shipped
	// artifact is one red row here — the same red row shape the
	// fixture lanes produce (#2661) — instead of a ⚠ skip folded into
	// "toolchain absent". The classification is the lane's own
	// `classifyToolSmokeInstallReport` mapping; a registry-unreachable verdict
	// surfaces as status "unreachable" and `main()` turns it into the run's
	// INCONCLUSIVE reason rather than letting the skips read as green.
	[TOOL_SMOKE_INSTALL_ROW_ID]: async (ctx) => {
		return runToolSmokeInstallProbe(ctx);
	},
};

/** Row ids this runner can execute. Exported for the drift guard. */
export function implementedRowIds() {
	return Object.keys(ROW_PROBES).sort();
}

/** Best-effort scratch removal shared by the normal and crash exits. */
export function removeScratchRoot(scratchRoot) {
	try {
		fs.rmSync(scratchRoot, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch (err) {
		console.warn(`[release-qa] cleanup warning: ${err?.message || err}`);
	}
}

// The crash exit at the bottom of this file cannot see main()'s locals, so
// the active scratch root is published here when created and cleared after a
// successful cleanup. A pre-existing --scratch-root directory is never
// published: removing a directory the runner did not create would destroy
// user state.
let activeScratchRoot = null;

export function noteActiveScratchRoot(scratchRoot) {
	activeScratchRoot = scratchRoot;
}

export function cleanupActiveScratchRoot() {
	if (!activeScratchRoot) return;
	const root = activeScratchRoot;
	activeScratchRoot = null;
	removeScratchRoot(root);
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`[release-qa] ${err.message}`);
		process.exit(4);
	}

	const baselineText = fs.readFileSync(opts.baseline, "utf8");
	const { rows, errors } = parseBaselineRows(baselineText);
	if (errors.length > 0) {
		for (const error of errors)
			console.error(`[release-qa] baseline: ${error}`);
		process.exit(4);
	}
	if (opts.from === "tree") {
		const refusal = dirtyCheckoutRefusal(
			gitExecFileSync(["status", "--porcelain"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			}),
		);
		if (refusal) {
			console.error(`[release-qa] ${refusal}`);
			process.exit(4);
		}
	}

	const scratchPreexisting = opts.scratchRoot
		? fs.existsSync(opts.scratchRoot)
		: false;
	const scratchRoot = opts.scratchRoot
		? path.resolve(opts.scratchRoot)
		: fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-release-qa-"));
	if (opts.scratchRoot) fs.mkdirSync(scratchRoot, { recursive: true });
	// Owned unless the caller named a directory that already existed: the
	// runner removes only scratch it created, and only when not kept.
	const scratchOwned = !scratchPreexisting;
	if (scratchOwned && !opts.keep) noteActiveScratchRoot(scratchRoot);
	const home = path.join(scratchRoot, "home");
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({
			npmCommand: ["npm"],
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-6",
		}),
	);
	const env = scratchEnv(scratchRoot);
	const projectDir = path.join(scratchRoot, "proj");
	const evidenceDir = path.join(opts.out, "release-qa-evidence");
	fs.mkdirSync(evidenceDir, { recursive: true });

	log(`scratch root: ${scratchRoot}`);
	log(
		`pinned under ${scratchRoot}: ${PINNED_ENV_KEYS.join(", ")} ` +
			"(allowlisted process environment; pip policy: PIP_BREAK_SYSTEM_PACKAGES=1)",
	);

	let blocked = false;
	let blockedReason = "";
	let candidateFailure = "";
	let exportedCommit = "";
	let exportRoot = REPO_ROOT;
	let packListing = null;
	let installedPkgDir = "";
	let rpc = null;
	let mcp = null;
	let mcpTools = null;
	let installSource = opts.from;

	// BLOCKED is about the HOST, not the candidate (#2619 review, decision a).
	// This probe runs BEFORE anything is installed: a pi that cannot start a
	// bare RPC session tells us nothing about the release, so the run is
	// BLOCKED and no verdict is issued. Once pi has answered here, every later
	// failure — the pack, the install, `pi install`, a candidate that stops pi
	// from booting — is the CANDIDATE's failure, and a candidate that will not
	// install or activate is a do-not-ship result, not an untestable one.
	setUpFixture(projectDir);
	log("boot probe: pi --mode rpc with no candidate installed");
	const bootProbe = await captureGetCommands({
		piBin: opts.pi,
		cwd: projectDir,
		env,
	});
	{
		const classified = classifyRunFailure({
			bootProbeOk: bootProbe.ok,
			bootProbeReason: bootProbe.reason,
		});
		blocked = classified.blocked;
		blockedReason = classified.blockedReason;
	}

	try {
		if (blocked) throw new Error(blockedReason);

		if (opts.from === "tree") {
			const exported = exportHeadForPack(scratchRoot);
			exportRoot = exported.dir;
			exportedCommit = exported.commit;
			// The export carries no node_modules, and `prepare`'s bundle step
			// (scripts/bundle-dist.mjs) inlines the pure-JS runtime deps with
			// esbuild — so without them it fails on `Could not resolve
			// "minimatch"`. Production deps only: the toolchain `prepare` needs
			// (tsc, esbuild) is fetched through npx/npm-exec into the cache, not
			// the project tree. `--ignore-scripts` so this install does not run
			// `prepare` itself; the pack below runs it once, properly.
			log(`installing production deps into the export (npm ci --omit=dev)`);
			npm(
				["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
				exported.dir,
				env,
			);
			log(`packing the exported ${exported.commit} (npm pack --json)`);
			// --pack-destination keeps the tarball out of the export too, and the
			// JSON is sliced from the first `[` because the `prepare` script
			// legitimately writes progress to stdout ahead of it (#376's break).
			const packJson = npm(
				["pack", "--json", "--pack-destination", scratchRoot],
				exported.dir,
				env,
			);
			const jsonStart = packJson.indexOf("[");
			if (jsonStart < 0) throw new Error("npm pack --json printed no JSON");
			packListing = JSON.parse(packJson.slice(jsonStart))[0];
			installSource = path.join(scratchRoot, packListing.filename);
		} else if (opts.from.startsWith("npm:")) {
			installSource = opts.from.slice("npm:".length);
			log(`QA target is the published ${installSource}`);
		} else {
			throw new Error(`unsupported --from: ${opts.from}`);
		}

		// pi supplies typebox and pi-tui from its own runtime, so nothing vendors
		// them and the standalone MCP server cannot load without them. This reuses
		// the repo's own answer to that (#1926) rather than re-listing the
		// packages here — the list and the ranges stay in one place.
		const supplyStdout = execFileSync(
			process.execPath,
			[
				path.join(REPO_ROOT, "scripts", "supply-host-provided-deps.mjs"),
				"--install-args",
			],
			{ encoding: "utf8", env },
		);
		const supplyArgs = parseSupplyArgs(supplyStdout);

		// ONE install, deliberately: npm reconciles the tree against the fixture's
		// package.json on every run, so installing the candidate and the
		// host-provided peers in two `--no-save` passes prunes the first one back
		// out (observed: "Path does not exist" from `pi install` on a directory
		// that existed moments earlier).
		log(
			`installing ${installSource} into the scratch project ` +
				`(with host-provided peers ${supplyArgs.join(" ")})`,
		);
		npm(
			["install", "--no-audit", "--no-fund", installSource, ...supplyArgs],
			projectDir,
			env,
		);
		installedPkgDir = path.join(projectDir, "node_modules", "pi-lens");
		if (!fs.existsSync(installedPkgDir)) {
			throw new Error(`pi-lens is not installed at ${installedPkgDir}`);
		}

		if (opts.from !== "tree") {
			// A published release is QA'd as shipped, so the pack listing has to be
			// derived from the installed tree rather than from `npm pack`.
			packListing = {
				filename: `${installSource} (as installed)`,
				files: listInstalledFiles(installedPkgDir),
			};
		}

		log(`pi install ${installedPkgDir}`);
		execFileSync(opts.pi, ["install", installedPkgDir], {
			cwd: projectDir,
			encoding: "utf8",
			env,
			timeout: 600_000,
		});

		log("driving pi --mode rpc (get_commands) with the candidate installed");
		rpc = await captureGetCommands({ piBin: opts.pi, cwd: projectDir, env });
		if (!rpc.ok) {
			// pi answered the boot probe moments ago, so this is the candidate
			// breaking it, not an unbootable host.
			candidateFailure = classifyRunFailure({
				bootProbeOk: true,
				candidateRpcReason: rpc.reason,
			}).candidateFailure;
		}
	} catch (err) {
		if (!blocked) {
			candidateFailure = classifyRunFailure({
				bootProbeOk: true,
				candidateError: `${err?.message || err}`,
			}).candidateFailure;
		}
	}

	if (!blocked && !candidateFailure) {
		const serverJs = path.join(installedPkgDir, "dist", "mcp", "server.js");
		try {
			mcp = new McpSession(serverJs, projectDir, env);
			const init = await mcp.request(
				"initialize",
				{
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "release-qa", version: "1" },
				},
				60_000,
			);
			if (init.error) throw new Error(init.error.message);
			mcp.notify("notifications/initialized", {});
			const listed = await mcp.request("tools/list", {}, 60_000);
			mcpTools = listed.error
				? { ok: false, reason: listed.error.message }
				: {
						ok: true,
						names: (listed.result?.tools ?? []).map((t) => t.name),
						result: listed.result,
					};
			// One dispatch through the real per-edit path, so the diagnostics and
			// health rows below have a session to report on.
			await mcp.callToolText("pilens_analyze", { file: "a.ts" });
		} catch (err) {
			mcpTools = {
				ok: false,
				reason: `MCP session failed: ${err?.message || err}`,
			};
		}
	}

	const ctx = {
		env,
		gitRef: opts.gitRef,
		installedPkgDir,
		exportRoot,
		mcp,
		mcpTools,
		packListing,
		piBin: opts.pi,
		pollCapMs: opts.pollCapMs,
		projectDir,
		rpc,
		scratchRoot,
	};

	const results = [];
	// #2663: a registry-unreachable classification means the lane's skips are
	// UNMEASURED, not green, so the run refuses a ship verdict. Carried beside
	// `blocked`/`candidateFailure` for the same reason they are: the verdict is
	// about the run, not any one row's outcome cell.
	const unreachableRows = [];
	for (const row of rows) {
		const probe = ROW_PROBES[row.id];
		let raw;
		const request = rowProbeRequest({
			hasProbe: Boolean(probe),
			blocked,
			blockedReason,
			candidateFailure,
		});
		const attempted = request.attempted;
		if (!attempted) {
			raw = request.probe;
		} else {
			log(`row ${row.id}`);
			try {
				raw = await probe(ctx);
			} catch (err) {
				raw = { status: "error", detail: `${err?.message || err}` };
			}
		}
		const probeOutcome = classifyRowOutcome(raw);
		if (raw.status === "unreachable") unreachableRows.push(row.id);
		let witnessPath = "";
		if (raw.witness) {
			const file = path.join(evidenceDir, `${row.id}.${raw.witness.ext}`);
			fs.writeFileSync(file, raw.witness.content ?? "");
			witnessPath = path.relative(opts.out, file).replaceAll("\\", "/");
		}
		// Hard Rule 1 as code (cells C7/C7b): a pass with nothing to show — no
		// witness, or an empty one — is not a pass. Downgraded here rather than
		// trusted, and the report's excerpt becomes the reason, not the claim.
		const classified = finalizeRowOutcome(
			probeOutcome,
			witnessPath,
			raw.witness?.content,
		);
		results.push({
			id: row.id,
			outcome: classified.outcome,
			detail: classified.detail,
			implemented: attempted,
			witnessPath: witnessPath || "—",
			shows: rowReportShows(classified, raw.shows),
		});
		log(`  → ${formatOutcome(classified)}`);
	}

	if (mcp) await mcp.close();

	const coverage = coverageArithmetic(results, rows.length);
	const verdict = shipVerdict(results, {
		blocked,
		blockedReason,
		candidateFailure,
		inconclusiveReason: unreachableRows.length
			? `registry-unreachable row(s) left UNMEASURED: ${unreachableRows.join(", ")}`
			: "",
	});
	const report = renderReport({
		rows,
		results,
		coverage,
		verdict,
		context: {
			"QA target": exportedCommit
				? `${installSource} (packed from exported ${exportedCommit})`
				: installSource,
			pi: describePi(opts.pi, env),
			baseline: path.relative(REPO_ROOT, opts.baseline).replaceAll("\\", "/"),
			"scratch root": scratchRoot,
			"polling cap": `${opts.pollCapMs}ms`,
			generated: new Date().toISOString(),
		},
	});
	const reportPath = path.join(opts.out, "release-qa-report.md");
	fs.writeFileSync(reportPath, report);

	console.log("");
	console.log(renderCoverageLine(coverage));
	console.log(`verdict: ${verdict.verdict} — ${verdict.reason}`);
	console.log(`report: ${reportPath}`);
	console.log(`evidence: ${evidenceDir}`);

	if (scratchOwned && !opts.keep) {
		activeScratchRoot = null;
		removeScratchRoot(scratchRoot);
	}

	process.exit(coverage.balanced ? verdictExitCode(verdict.verdict) : 4);
}

/** Package-relative file list of an installed tree, in `npm pack --json` shape. */
function listInstalledFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(full);
			} else {
				out.push({ path: path.relative(root, full).replaceAll("\\", "/") });
			}
		}
	};
	walk(root);
	return out;
}

function describePi(piBin, env) {
	try {
		return `${piBin} ${execFileSync(piBin, ["--version"], {
			encoding: "utf8",
			env,
		}).trim()}`;
	} catch (err) {
		return `${piBin} (version unreadable: ${err?.message || err})`;
	}
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((err) => {
		console.error("[release-qa] crashed:", err);
		cleanupActiveScratchRoot();
		process.exit(4);
	});
}
