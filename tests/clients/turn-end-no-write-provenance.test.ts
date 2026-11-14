// flake-shape: service-double — the late-auxiliary cell: a real auxiliary client is an external child process, so the LSP service seam answers its cached publication (#4617)
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recordDeliveredCascadeNeighbor,
	resetCascadePendingNeighbors,
	resetCascadeUnansweredPrimariesDelivered,
} from "../../clients/cascade-format.js";
import { MAX_ADVISORY_AFFECTED_FILES } from "../../clients/advisory-provenance.js";
import type { CascadeRun } from "../../clients/cascade-types.js";
import {
	deferRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import type { Diagnostic, RunnerResult } from "../../clients/dispatch/types.js";
import {
	markPendingAuxiliaryCoverage,
	resetPendingAuxiliaryCoverage,
} from "../../clients/lsp/pending-aux-coverage.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { runTurnScenario } from "../support/turn-harness.js";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());

// Recurrence (#4617): the turn-end advisory of a turn that wrote no file
// carried no provenance stamp the gate could read, so findings captured in
// the current turn reached the model labelled "Historical finding; workspace
// changed since capture". A bash-only turn is about 85% of a session.
const HISTORICAL = "Historical finding";
const UNKNOWN_STAMP = "generation unknown";
// Cascade lines that, with the section's own header lines, end the kept
// prefix on the next part's tier label (the 20-line cap).
const CUT_AFTER_LABEL_LINES = 18;

beforeEach(async () => {
	await installLspServiceDouble({
		readCachedDiagnosticsForServers,
		observeLateAuxiliaryAnswer: async () => undefined,
	});
	readCachedDiagnosticsForServers.mockReset();
});

afterEach(() => {
	resetCascadePendingNeighbors();
	resetCascadeUnansweredPrimariesDelivered();
	resetPendingAuxiliaryCoverage();
	resetPendingRunnerFindings();
});

function neighborError(filePath: string): Diagnostic {
	return {
		id: "lsp:cascade:1",
		message: "type mismatch",
		filePath,
		line: 1,
		column: 1,
		severity: "error",
		semantic: "blocking",
		tool: "lsp",
		rule: "cascade:test",
	};
}

/** A cascade run no section renders: the trigger that lets a bash-only turn
 *  reach the composer without citing any file itself. */
function silentRun(filePath: string): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		skipReason: "clean",
	};
}

function indeterminateRun(filePath: string): CascadeRun {
	return {
		filePath,
		result: undefined,
		neighborCount: 0,
		diagnosticCount: 0,
		skipReason: "indeterminate",
		indeterminate: {
			reason: "graph_degraded",
			detail: "review graph unavailable",
		},
	};
}

describe.each([false, true])(
	"bash-only turn provenance, --lens-guard %s (#4617)",
	(guard) => {
		const flags = { "lens-guard": guard };

		it("keeps a confirmed-clean resolution current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-clean-${guard}`,
				incident:
					"Live turn-end findings received the historical-provenance preamble",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					expect(
						h.runtime.retireInlineBlockerOnConfirmedClean(
							file,
							h.runtime.nextWriteOrderToken(),
							["lsp"],
						),
					).toBe(true);
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("confirmed clean");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a cascade coverage advisory current (indeterminate run)", async () => {
			await runTurnScenario({
				id: `no-write-provenance-indeterminate-${guard}`,
				incident: "A coverage advisory cites no edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(indeterminateRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps an unconfirmed-neighbour advisory current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unconfirmed-${guard}`,
				incident: "A coverage advisory cites no edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: undefined,
						neighborCount: 1,
						diagnosticCount: 0,
						unconfirmed: {
							count: 1,
							servers: [
								{
									serverId: "ts",
									reason: "no-answer",
									waitMs: 500,
									paths: [neighbor],
								},
							],
						},
					});
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("no answer arrived");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps an unanswered-primary line beside a clean neighbour current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unanswered-${guard}`,
				incident: "A cascade section with no neighbour error to cite",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [],
								},
							],
							formatted: "No language server answered for a.ts",
							unansweredPrimaries: {
								notes: [
									{
										serverIds: ["pyrefly"],
										line: "No language server answered for a.ts",
									},
								],
								formattedWithoutNotes: "",
							},
						},
						neighborCount: 1,
						diagnosticCount: 0,
					});
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("No language server answered");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a pending-neighbour line current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-pending-${guard}`,
				incident:
					"The pending-error lines name a neighbour, not an edited file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					recordDeliveredCascadeNeighbor(
						neighbor,
						[neighborError(neighbor)],
						1,
						Date.now() + 60_000,
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(silentRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("error(s) unresolved");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a changed-since-checked neighbour line current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-pending-changed-${guard}`,
				incident: "The changed-outside-pi line names a neighbour, not an edit",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					recordDeliveredCascadeNeighbor(
						neighbor,
						[neighborError(neighbor)],
						1,
						Date.now() - 60_000,
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(silentRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("changed since checked");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a late auxiliary finding current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-aux-${guard}`,
				incident: "A late auxiliary part cites a file the turn did not edit",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const auxFile = h.write("src/aux.ts", "export const aux = 1;\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(auxFile, past, past);
					markPendingAuxiliaryCoverage(
						auxFile,
						["opengrep"],
						Date.now() - 2000,
					);
					readCachedDiagnosticsForServers.mockImplementation(
						async () =>
							new Map([
								[
									"opengrep",
									{
										diags: [
											{
												range: {
													start: { line: 0, character: 0 },
													end: { line: 0, character: 10 },
												},
												severity: 2,
												code: "rule-x",
												source: "opengrep",
												message: "late scanner finding",
											},
										],
										publishedAt: Date.now(),
									},
								],
							]),
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(silentRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("late scanner finding");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4617 item 2): a bash-only turn delivered a late runner's
		// advisory whose file the turn neither wrote nor resolved, so the stamp
		// named no file and the live findings read as historical.
		it("keeps a late runner finding current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-late-runner-${guard}`,
				incident: "A late runner part cites a file the turn did not edit",
				issue: "#4617",
				async run(h) {
					const runnerFile = h.write("src/late.sh", "echo hi\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(runnerFile, past, past);
					deferRunnerFindings({
						filePath: runnerFile,
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "shellcheck",
						markedAtMs: Date.now() - 2000,
						promise: Promise.resolve({
							status: "failed",
							failureKind: "blocking_diagnostics",
							semantic: "warning",
							diagnostics: [
								{
									id: "late-runner-1",
									message: "late runner finding",
									filePath: runnerFile,
									line: 1,
									column: 1,
									severity: "warning",
									semantic: "warning",
									tool: "shellcheck",
									rule: "SC2086",
								},
							],
						} as RunnerResult),
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Late runner diagnostics");
					expect(view.text).toContain("late runner finding");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4617 item 2): the stamp for a late runner's file must still
		// go historical once that file changes after the turn end; citing it must
		// bind the message, not silence the label.
		it("labels a late runner finding historical when its file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-late-runner-older-${guard}`,
				incident:
					"A stamped late runner part from an older turn stays labelled",
				issue: "#4617",
				async run(h) {
					const runnerFile = h.write("src/late.sh", "echo hi\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(runnerFile, past, past);
					deferRunnerFindings({
						filePath: runnerFile,
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "shellcheck",
						markedAtMs: Date.now() - 2000,
						promise: Promise.resolve({
							status: "failed",
							failureKind: "blocking_diagnostics",
							semantic: "warning",
							diagnostics: [
								{
									id: "late-runner-2",
									message: "late runner finding",
									filePath: runnerFile,
									line: 1,
									column: 1,
									severity: "warning",
									semantic: "warning",
									tool: "shellcheck",
									rule: "SC2086",
								},
							],
						} as RunnerResult),
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runnerFile, "echo changed\n");
						},
					});
					expect(view.text).toContain("late runner finding");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4962 r5, CodeRabbit outside-diff): a late runner's kept
		// advisory can name a file other than the one the run was deferred for
		// (the freshness gate and the line text read each finding's own
		// `filePath`). The part cited only the deferred file, so a change to the
		// named file after the turn end left the message current.
		it("labels a late runner finding historical when the file it names changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-late-runner-cross-file-${guard}`,
				incident:
					"A late runner advisory names a file other than its deferred one",
				issue: "#4617",
				async run(h) {
					const runnerFile = h.write("src/late.sh", "echo hi\n");
					const namedFile = h.write("src/named.sh", "echo named\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(runnerFile, past, past);
					fs.utimesSync(namedFile, past, past);
					deferRunnerFindings({
						filePath: runnerFile,
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "shellcheck",
						markedAtMs: Date.now() - 2000,
						promise: Promise.resolve({
							status: "failed",
							failureKind: "blocking_diagnostics",
							semantic: "warning",
							diagnostics: [
								{
									id: "late-runner-cross-1",
									message: "late runner finding",
									filePath: namedFile,
									line: 1,
									column: 1,
									severity: "warning",
									semantic: "warning",
									tool: "shellcheck",
									rule: "SC2086",
								},
							],
						} as RunnerResult),
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(namedFile, "echo changed\n");
						},
					});
					expect(view.text).toContain("late runner finding");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4617 item 2, round 2): a late runner whose surviving
		// findings are all blocking leaves the advisory and is delivered by the
		// blocker replay ("Unresolved from this turn"), a second producer of the
		// same file-less part. The stamp named no file, so a STOP blocker the
		// same message called historical of unknown provenance.
		const deferBlockingLateRunner = (
			h: { write: (rel: string, body: string) => string; cwd: string },
			id: string,
		): string => {
			const runnerFile = h.write("src/late.sh", "echo hi\n");
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(runnerFile, past, past);
			deferRunnerFindings({
				filePath: runnerFile,
				cwd: h.cwd,
				projectRoot: h.cwd,
				runnerId: "shellcheck",
				markedAtMs: Date.now() - 2000,
				promise: Promise.resolve({
					status: "failed",
					failureKind: "blocking_diagnostics",
					semantic: "blocking",
					diagnostics: [
						{
							id,
							message: "late runner finding",
							filePath: runnerFile,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "shellcheck",
							rule: "SC2086",
						},
					],
				} as RunnerResult),
			});
			return runnerFile;
		};

		/**
		 * A runner that crashed: no usable result, so the drain states the failure
		 * itself (`❌ Deferred runner <id> failed`) and the note names no file.
		 */
		const deferBrokenRunner = (
			h: { write: (rel: string, body: string) => string; cwd: string },
			runnerId: string,
		): void => {
			const runnerFile = h.write("src/broken.sh", "echo broken\n");
			deferRunnerFindings({
				filePath: runnerFile,
				cwd: h.cwd,
				projectRoot: h.cwd,
				runnerId,
				markedAtMs: Date.now() - 2000,
				promise: Promise.resolve({
					status: "failed",
					failureKind: "spawn_failed",
					semantic: "warning",
					diagnostics: [],
				} as RunnerResult),
			});
		};

		/** A runner whose findings are long enough to spend the turn-end cap. */
		const deferNoisyRunner = (
			h: { write: (rel: string, body: string) => string; cwd: string },
			count: number,
		): void => {
			const runnerFile = h.write(
				"src/noisy.sh",
				Array.from({ length: count }, () => "echo noisy").join("\n") + "\n",
			);
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(runnerFile, past, past);
			deferRunnerFindings({
				filePath: runnerFile,
				cwd: h.cwd,
				projectRoot: h.cwd,
				runnerId: "shellcheck",
				markedAtMs: Date.now() - 2000,
				promise: Promise.resolve({
					status: "failed",
					failureKind: "blocking_diagnostics",
					semantic: "warning",
					diagnostics: Array.from({ length: count }, (_, i) => ({
						id: `noisy-${i}`,
						message: "noisy late runner finding",
						filePath: runnerFile,
						line: i + 1,
						column: 1,
						severity: "warning" as const,
						semantic: "warning" as const,
						tool: "shellcheck",
						rule: "SC2086",
					})),
				} as RunnerResult),
			});
		};

		/**
		 * A Go CVE whose trace has no filename frame: the govulncheck lane renders
		 * it as `(module)` and cites the Go module files at the scan root. A cell
		 * that writes no go.mod leaves the section with an empty citation and no
		 * fileless declaration — the fail-closed state the census keeps for a
		 * producer nobody registered (here: the declaration it is pinned by is
		 * gone).
		 */
		const seedModuleOnlyGoCve = (h: {
			scan: (store: string, result: Record<string, unknown>) => void;
		}): void => {
			h.scan("govulncheck", {
				findings: [
					{
						osv: "GO-2024-9999",
						module: "example.com/module",
						trace: [],
					},
				],
			});
		};

		it("keeps a blocking-only late runner finding current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-late-runner-blocking-${guard}`,
				incident:
					"A blocker replayed from a late runner cites no file the turn edited",
				issue: "#4617",
				async run(h) {
					deferBlockingLateRunner(h, "late-runner-blocking-1");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Unresolved from this turn");
					expect(view.text).toContain("late runner finding");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Negative direction of the cell above: citing the blocker's file binds
		// the message, it does not silence the label once the file moves on.
		it("labels a blocking-only late runner finding historical when its file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-late-runner-blocking-older-${guard}`,
				incident:
					"A stamped replayed blocker from an older turn stays labelled",
				issue: "#4617",
				async run(h) {
					const runnerFile = deferBlockingLateRunner(
						h,
						"late-runner-blocking-2",
					);
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runnerFile, "echo changed\n");
						},
					});
					expect(view.text).toContain("late runner finding");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4962 r3, CodeRabbit thread): one cited part made a
		// no-write turn's stamp well-formed, so it spoke for the whole message.
		// A part beside it that the stamp cannot speak for must not read current.
		// #4617 moved the population: every file-bound producer now cites, so the
		// unaccounted part left is one whose declaration is gone — a module-only
		// Go CVE in a tree with no go.mod, which cites nothing. The rule still has
		// to fail closed on it.
		it("labels a message historical when one of its parts is accounted for by neither files nor a fileless subject", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-${guard}`,
				incident:
					"A cited replay vouched for an unaccounted module-only CVE in the same message",
				issue: "#4617",
				async run(h) {
					deferBlockingLateRunner(h, "late-runner-mixed-1");
					seedModuleOnlyGoCve(h);
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Unresolved from this turn");
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4962 r4 verify N1): the completeness rule also flips two
		// cited producers from current to historical beside an uncited part, a
		// #4954 coverage advisory and a confirmed-clean resolution. The mixed cell
		// above pins only the late-runner citation, so a rule narrowed to that
		// citation would drop both flips without a red.
		it("labels a coverage advisory historical beside a part accounted for by neither", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-advisory-${guard}`,
				incident:
					"A cited coverage advisory vouched for an unaccounted module-only CVE in the same message",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					seedModuleOnlyGoCve(h);
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(indeterminateRun(primary));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a resolution historical beside a part accounted for by neither", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-resolution-${guard}`,
				incident:
					"A confirmed-clean resolution vouched for an unaccounted module-only CVE in the same message",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					seedModuleOnlyGoCve(h);
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					expect(
						h.runtime.retireInlineBlockerOnConfirmedClean(
							file,
							h.runtime.nextWriteOrderToken(),
							["lsp"],
						),
					).toBe(true);
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The excluded default (#4962 r3): a write turn's stamp binds its edits,
		// as it did before #4617, so a part beside them that cites no file
		// leaves it current. Applying the completeness rule there would label
		// every write turn with such a part historical.
		it("keeps a write turn current beside a part accounted for by neither", async () => {
			await runTurnScenario({
				id: `no-write-provenance-write-uncited-${guard}`,
				incident:
					"The completeness rule must not reach a stamp that binds edits",
				issue: "#4617",
				async run(h) {
					h.edit("src/app.ts", "export const app = 1;\n");
					seedModuleOnlyGoCve(h);
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The cap's direction (#4962 r3): only a part the message carries can
		// leave the stamp incomplete. An uncited part the cap cut is not text
		// the model reads, so it must not label the delivered part historical.
		it("keeps a message current when the cap cut its only uncited part", async () => {
			await runTurnScenario({
				id: `no-write-provenance-cut-uncited-${guard}`,
				incident: "An uncited part the cap cut labelled the kept part",
				issue: "#4617",
				async run(h) {
					const warnings = 25;
					const runnerFile = h.write(
						"src/late.sh",
						Array.from({ length: warnings }, () => "echo hi").join("\n") + "\n",
					);
					const failedFile = h.write("src/other.sh", "echo other\n");
					const past = new Date(Date.now() - 10_000);
					fs.utimesSync(runnerFile, past, past);
					fs.utimesSync(failedFile, past, past);
					deferRunnerFindings({
						filePath: runnerFile,
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "shellcheck",
						markedAtMs: Date.now() - 2000,
						promise: Promise.resolve({
							status: "failed",
							failureKind: "blocking_diagnostics",
							semantic: "warning",
							diagnostics: Array.from({ length: warnings }, (_, i) => ({
								id: `late-runner-cut-${i}`,
								message: "late runner finding",
								filePath: runnerFile,
								line: i + 1,
								column: 1,
								severity: "warning" as const,
								semantic: "warning" as const,
								tool: "shellcheck",
								rule: "SC2086",
							})),
						} as RunnerResult),
					});
					deferRunnerFindings({
						filePath: failedFile,
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "slow-runner",
						markedAtMs: Date.now() - 2000,
						promise: Promise.resolve({
							status: "failed",
							failureKind: "timeout",
							semantic: "warning",
							diagnostics: [],
						} as RunnerResult),
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Late runner diagnostics");
					expect(view.text).not.toContain("Deferred runner slow-runner failed");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Negative cells: the fix must not drop the label. A stamp taken at this
		// turn end still flips to historical once the workspace moves on, or
		// once the session that took it is over.
		it("labels a resolution historical when its file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-file-${guard}`,
				incident: "A stamped advisory from an older turn must stay labelled",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(file, "export const value = 'changed';\n");
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a coverage advisory historical when its cited file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-cited-${guard}`,
				incident: "A stamped advisory from an older turn must stay labelled",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun(indeterminateRun(primary));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(primary, "export const a = 2;\n");
						},
					});
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Fail closed on a stamp that cannot name every file the advisory cites
		// (`truncated-provenance`): a partial stamp must not read as current.
		it("labels a write turn historical when its edited and cited files exceed the stamp cap", async () => {
			await runTurnScenario({
				id: `no-write-provenance-over-cap-${guard}`,
				incident: "A stamp over the first files of a larger citation set",
				issue: "#4617",
				async run(h) {
					for (let i = 0; i < MAX_ADVISORY_AFFECTED_FILES; i += 1) {
						h.edit(`src/e${i}.ts`, `export const e${i} = 1;\n`);
					}
					const extra = h.write("src/extra.ts", "export const extra = 1;\n");
					h.runtime.appendCascadeRun(indeterminateRun(extra));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4954 r5, CodeRabbit thread): a truncated stamp omits a
		// cited file, so "every stamped file is deleted" no longer means every
		// file the text names is gone. Dropping the message there discarded text
		// whose omitted, still-existing file master delivered labelled historical.
		it("keeps a truncated stamp's message labelled historical when every stamped file is deleted", async () => {
			await runTurnScenario({
				id: `no-write-provenance-over-cap-deleted-${guard}`,
				incident:
					"Deleting every stamped file dropped a message citing an omitted one",
				issue: "#4617",
				async run(h) {
					const edited = Array.from(
						{ length: MAX_ADVISORY_AFFECTED_FILES },
						(_, i) => h.edit(`src/e${i}.ts`, `export const e${i} = 1;\n`),
					);
					const extra = h.write("src/extra.ts", "export const extra = 1;\n");
					h.runtime.appendCascadeRun(indeterminateRun(extra));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							for (const file of edited) fs.unlinkSync(file);
						},
					});
					expect(fs.existsSync(extra)).toBe(true);
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4954 F3): a path cited by two sources counted twice against
		// the cap, so a stamp of exactly MAX unique files read as truncated and a
		// current message went out labelled historical.
		it("counts a file cited and edited once against the stamp cap", async () => {
			await runTurnScenario({
				id: `no-write-provenance-dedupe-${guard}`,
				incident: "The same path from two sources crossed the stamp cap",
				issue: "#4617",
				async run(h) {
					const edited = Array.from(
						{ length: MAX_ADVISORY_AFFECTED_FILES },
						(_, i) => h.edit(`src/e${i}.ts`, `export const e${i} = 1;\n`),
					);
					h.runtime.appendCascadeRun(indeterminateRun(edited[0] as string));
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Cascade could not compute");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4954 F1, Sourcery thread): the stamp was built from the
		// parts the composer produced, so the file of a part the 20-line cap cut
		// still bound the delivered text, and a change to a file the model never
		// saw labelled live findings historical.
		it("ignores the file of an advisory the cap cut out of the message", async () => {
			await runTurnScenario({
				id: `no-write-provenance-cut-part-${guard}`,
				incident: "A cut advisory's file bound the delivered section",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					const cut = h.write("src/cut.ts", "export const cut = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [neighborError(neighbor)],
								},
							],
							formatted: Array.from(
								{ length: 22 },
								(_, i) => `Cascade error line ${i}`,
							).join("\n"),
						},
						neighborCount: 1,
						diagnosticCount: 1,
					});
					h.runtime.appendCascadeRun(indeterminateRun(cut));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(cut, "export const cut = 2;\n");
						},
					});
					expect(view.text).toContain("Cascade error line 0");
					expect(view.text).not.toContain("Cascade could not compute");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4954 F5): the stamp re-derived reach as "the part starts
		// inside the kept prefix", so an advisory cut after its tier label bound
		// the runs its cut bullet names, and a change to one of them labelled a
		// message that never showed it historical. The hold plan holds that part.
		it("ignores the files of an advisory the cap cut part-way", async () => {
			await runTurnScenario({
				id: `no-write-provenance-part-cut-${guard}`,
				incident: "A part cut after its label bound the files it would name",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					const runs = Array.from({ length: 5 }, (_, i) =>
						h.write(`src/r${i}.ts`, `export const r${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [neighborError(neighbor)],
								},
							],
							formatted: Array.from(
								{ length: CUT_AFTER_LABEL_LINES },
								(_, i) => `Cascade error line ${i}`,
							).join("\n"),
						},
						neighborCount: 1,
						diagnosticCount: 1,
					});
					for (const run of runs)
						h.runtime.appendCascadeRun(indeterminateRun(run));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runs[0] as string, "export const r0 = 2;\n");
						},
					});
					expect(view.text).toContain("ℹ️ Advisory — no action required");
					expect(view.text).not.toContain("Cascade could not compute");
					expect(view.text).not.toContain("r0.ts");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The other arm of the reach rule (#4954 F5): a leading section too long
		// for the cap reaches the model from its head, so it binds its files. A
		// "whole parts only" stamp would read it current after its file changed.
		it("binds the files of a leading section the cap cut part-way", async () => {
			await runTurnScenario({
				id: `no-write-provenance-leading-cut-${guard}`,
				incident: "An oversized leading section must keep binding its file",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [neighborError(neighbor)],
								},
							],
							formatted: Array.from(
								{ length: 22 },
								(_, i) => `Cascade error line ${i}`,
							).join("\n"),
						},
						neighborCount: 1,
						diagnosticCount: 1,
					});
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(primary, "export const a = 2;\n");
						},
					});
					expect(view.text).toContain("Cascade error line 0");
					expect(view.text).not.toContain("Cascade error line 21");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Recurrence (#4954 F6, CodeRabbit thread): a stamp of cited files only
		// dropped the whole message once they were deleted (`allFilesDeleted`),
		// where master delivered it labelled historical. A cited file is
		// evidence for the text, not the text's subject: it never discards it.
		it("keeps a section labelled historical when its only cited file is deleted", async () => {
			await runTurnScenario({
				id: `no-write-provenance-cited-deleted-${guard}`,
				incident: "Deleting a cited primary dropped the whole turn-end message",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbor = h.write("src/b.ts", "export const b = 1;\n");
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: {
							filePath: primary,
							impact: {
								filePath: primary,
								changedSymbols: [],
								directImporters: [neighbor],
								directCallers: [],
								neighborFiles: [neighbor],
								riskFlags: [],
							},
							neighbors: [
								{
									filePath: neighbor,
									reason: "imports",
									lspTouched: false,
									diagnostics: [],
								},
							],
							formatted: "No language server answered for a.ts",
							unansweredPrimaries: {
								notes: [
									{
										serverIds: ["pyrefly"],
										line: "No language server answered for a.ts",
									},
								],
								formattedWithoutNotes: "",
							},
						},
						neighborCount: 1,
						diagnosticCount: 0,
					});
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.unlinkSync(primary);
						},
					});
					expect(view.text).toContain("No language server answered");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("keeps a resolution labelled historical when its file is deleted", async () => {
			await runTurnScenario({
				id: `no-write-provenance-resolved-deleted-${guard}`,
				incident: "A resolution's file, not written this turn, was deleted",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.unlinkSync(file);
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The drop rule that stays: once every stamped file is gone, the findings
		// have no file left to fix. The edited file is cited too, and stays
		// edited, so the stamp is not cited-only.
		it("drops a write turn's message once every stamped file is deleted", async () => {
			await runTurnScenario({
				id: `no-write-provenance-edited-deleted-${guard}`,
				incident: "A write turn's edited and cited files were all deleted",
				issue: "#4617",
				async run(h) {
					const edited = h.edit("src/e.ts", "export const e = 1;\n");
					const cited = h.write("src/c.ts", "export const c = 1;\n");
					h.blocker("src/e.ts", "L1: type mismatch");
					h.runtime.appendCascadeRun(indeterminateRun(edited));
					h.runtime.appendCascadeRun(indeterminateRun(cited));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.unlinkSync(edited);
							fs.unlinkSync(cited);
						},
					});
					expect(view.text).toBe("");
				},
			});
		});

		// Recurrence (#4954 F8): the r3 drop rule counted only edited files, so a
		// turn that edited one file and resolved another dropped its message once
		// the edited file was deleted, while the resolved file the text names
		// still existed. Master delivered it labelled historical.
		it("keeps a write turn's resolution labelled historical when only its edited file is deleted", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-deleted-${guard}`,
				incident: "Deleting the edited file dropped a live resolution line",
				issue: "#4617",
				async run(h) {
					const resolved = h.write("src/v.ts", "export const v = 1;\n");
					h.runtime.beginTurn();
					const edited = h.edit("src/e.ts", "export const e = 1;\n");
					h.blocker("src/v.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						resolved,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.unlinkSync(edited);
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Same recurrence, the display bound: an advisory shows five files per
		// reason and "(+N more)" for the rest, so a file it does not name is not
		// one it speaks for.
		it("ignores a run the coverage advisory counts but does not name", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unnamed-run-${guard}`,
				incident: "A run behind (+N more) bound the delivered advisory",
				issue: "#4617",
				async run(h) {
					const runs = Array.from({ length: 7 }, (_, i) =>
						h.write(`src/r${i}.ts`, `export const r${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					for (const run of runs)
						h.runtime.appendCascadeRun(indeterminateRun(run));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runs[6] as string, "export const r6 = 2;\n");
						},
					});
					expect(view.text).toContain("(+2 more)");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("ignores a neighbour the unconfirmed line counts but does not name", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unnamed-neighbor-${guard}`,
				incident: "A neighbour behind (+N more) bound the delivered line",
				issue: "#4617",
				async run(h) {
					const primary = h.write("src/a.ts", "export const a = 1;\n");
					const neighbors = Array.from({ length: 7 }, (_, i) =>
						h.write(`src/n${i}.ts`, `export const n${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					h.runtime.appendCascadeRun({
						filePath: primary,
						result: undefined,
						neighborCount: neighbors.length,
						diagnosticCount: 0,
						unconfirmed: {
							count: neighbors.length,
							servers: [
								{
									serverId: "ts",
									reason: "no-answer",
									waitMs: 500,
									paths: neighbors,
								},
							],
						},
					});
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(
								neighbors[6] as string,
								"export const n6 = 2;\n",
							);
						},
					});
					expect(view.text).toContain("(+2 more)");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("ignores a primary the unconfirmed line counts but does not name", async () => {
			await runTurnScenario({
				id: `no-write-provenance-unnamed-primary-${guard}`,
				incident: "A primary behind (+N more) bound the delivered line",
				issue: "#4617",
				async run(h) {
					const neighbor = h.write("src/n.ts", "export const n = 1;\n");
					const primaries = Array.from({ length: 5 }, (_, i) =>
						h.write(`src/p${i}.ts`, `export const p${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					for (const primary of primaries) {
						h.runtime.appendCascadeRun({
							filePath: primary,
							result: undefined,
							neighborCount: 1,
							diagnosticCount: 0,
							unconfirmed: {
								count: 1,
								servers: [
									{
										serverId: "ts",
										reason: "no-answer",
										waitMs: 500,
										paths: [neighbor],
									},
								],
							},
						});
					}
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(
								primaries[4] as string,
								"export const p4 = 2;\n",
							);
						},
					});
					expect(view.text).toContain("(+2 more)");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a coverage advisory historical when a file it names changed", async () => {
			await runTurnScenario({
				id: `no-write-provenance-named-run-${guard}`,
				incident: "A named run's file changed after the turn end",
				issue: "#4617",
				async run(h) {
					const runs = Array.from({ length: 7 }, (_, i) =>
						h.write(`src/r${i}.ts`, `export const r${i} = 1;\n`),
					);
					h.runtime.beginTurn();
					for (const run of runs)
						h.runtime.appendCascadeRun(indeterminateRun(run));
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runs[0] as string, "export const r0 = 2;\n");
						},
					});
					expect(view.text).toContain("(+2 more)");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The turn's own edited-file list is capped before the stamp sees it, so
		// the stamp must carry that loss forward (`affectedFilesTruncated`).
		it("labels a write turn historical when its edited files exceed the stamp cap", async () => {
			await runTurnScenario({
				id: `no-write-provenance-edited-over-cap-${guard}`,
				incident: "A stamp over the first files of a larger edit set",
				issue: "#4617",
				async run(h) {
					for (let i = 0; i <= MAX_ADVISORY_AFFECTED_FILES; i += 1) {
						h.edit(`src/e${i}.ts`, `export const e${i} = 1;\n`);
					}
					h.blocker("src/e0.ts", "L1: type mismatch");
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("type mismatch");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 population A (the #4954 F2 remainder): the demoted-secrets tier
		// is rendered by the secrets lane from a scanned file, and every rendered
		// part names that file — but the producer registered no citation, so a
		// no-write turn's stamp had no subject and the whole message read
		// historical. The live cell is the 🔑 ACTION NEEDED tier.
		it("keeps a stale-secret ACTION NEEDED tier current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-stale-secret-${guard}`,
				incident:
					"A demoted gitleaks finding was labelled historical on a bash-only turn",
				issue: "#4617",
				async run(h) {
					const secretFile = h.write(
						"src/config.ts",
						"const key = 'AKIA0000000000000000';\n",
					);
					h.scan("gitleaks", {
						findings: [
							{
								ruleId: "aws-access-token",
								file: secretFile,
								startLine: 1,
								description: "AWS key",
							},
						],
					});
					// Written after the scan by something pi never saw: the finding is
					// demoted to the ACTION NEEDED tier, and the turn wrote nothing.
					h.advance(5_000);
					h.write("src/config.ts", "const key = process.env.KEY;\n");
					// The fall-through trigger of a bash-only turn: a cascade run no
					// section renders.
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("ACTION NEEDED");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The negative direction of the cell above: the citation binds the tier to
		// the file it names, so a change AFTER the capture still labels it.
		it("labels a stale-secret ACTION NEEDED tier historical when its file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-stale-secret-older-${guard}`,
				incident:
					"A cited demoted-secret tier must not read current once its file moves on",
				issue: "#4617",
				async run(h) {
					const secretFile = h.write(
						"src/config.ts",
						"const key = 'AKIA0000000000000000';\n",
					);
					h.scan("gitleaks", {
						findings: [
							{
								ruleId: "aws-access-token",
								file: secretFile,
								startLine: 1,
								description: "AWS key",
							},
						],
					});
					h.advance(5_000);
					h.write("src/config.ts", "const key = process.env.KEY;\n");
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							h.write("src/config.ts", "const key = process.env.OTHER;\n");
						},
					});
					expect(view.text).toContain("ACTION NEEDED");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 population A, the cell the file stamp could not reach: a trivy row
		// names a PACKAGE, so there is no file:line to stat. Its evidence is the
		// dependency declaration the scan read, so the advisory cites the
		// manifests — and a lockfile edit after the turn end supersedes it.
		it("keeps a trivy CVE advisory current, bound to the manifest it read", async () => {
			await runTurnScenario({
				id: `no-write-provenance-trivy-${guard}`,
				incident:
					"A session-start CVE advisory was labelled historical on a bash-only turn",
				issue: "#4617",
				async run(h) {
					h.write("package-lock.json", "{\n}\n");
					h.scan("trivy", {
						findings: [
							{
								vulnerabilityId: "CVE-2024-0001",
								pkgName: "left-pad",
								installedVersion: "1.0.0",
								fixedVersion: "1.0.1",
								severity: "HIGH",
							},
						],
						licenses: [],
						secrets: [],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Dependency CVEs (trivy");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The negative direction: the manifest IS the subject, so a lockfile edit
		// after the capture supersedes the message.
		it("labels a trivy CVE advisory historical when the lockfile changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-trivy-older-${guard}`,
				incident: "A lockfile edit must supersede the cached CVE list",
				issue: "#4617",
				async run(h) {
					const manifest = h.write("package-lock.json", "{\n}\n");
					h.scan("trivy", {
						findings: [
							{
								vulnerabilityId: "CVE-2024-0001",
								pkgName: "left-pad",
								installedVersion: "1.0.0",
								fixedVersion: "1.0.1",
								severity: "HIGH",
							},
						],
						licenses: [],
						secrets: [],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(manifest, '{\n  "x": 1\n}\n');
						},
					});
					expect(view.text).toContain("Dependency CVEs (trivy");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 review F1 (probe C): `trivy fs` walks the whole tree, so a nested
		// lockfile is a declaration the scan read. Citing only the manifests at
		// `cwd` left a monorepo's CVE list reading current after its own package's
		// lockfile moved on.
		it("labels a trivy CVE advisory historical when a nested lockfile the scan named changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-trivy-nested-${guard}`,
				incident:
					"A nested lockfile edit left a monorepo's CVE advisory labelled current",
				issue: "#4617",
				async run(h) {
					h.write("package.json", '{\n  "name": "root"\n}\n');
					h.write("package-lock.json", "{\n}\n");
					const nested = h.write("packages/a/package-lock.json", "{\n}\n");
					h.scan("trivy", {
						findings: [
							{
								vulnerabilityId: "CVE-2024-0001",
								pkgName: "left-pad",
								installedVersion: "1.0.0",
								fixedVersion: "1.0.1",
								severity: "HIGH",
								target: "packages/a/package-lock.json",
							},
						],
						licenses: [],
						secrets: [],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(nested, '{\n  "x": 1\n}\n');
						},
					});
					expect(view.text).toContain("Dependency CVEs (trivy");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 review V3 (probes P1b/P1c): a target the scan root does not
		// contain is not a declaration this scan read. Cited, a file outside the
		// workspace decided the label and the root manifests went unwatched; it
		// now falls through to the root-manifest fallback like a row with none.
		it("binds a trivy CVE advisory to the root manifests when its row names a target outside the scan root", async () => {
			await runTurnScenario({
				id: `no-write-provenance-trivy-outside-root-${guard}`,
				incident:
					"A CVE row naming a lockfile outside the workspace left a root lockfile edit unwatched",
				issue: "#4617",
				async run(h) {
					// `pi-lens-` prefixed: the tmp-root hygiene census owns that
					// namespace, and the finally removes it.
					const outsideDir = path.join(
						h.cwd,
						"..",
						`pi-lens-trivy-outside-${process.pid}-${guard}`,
					);
					try {
						fs.mkdirSync(outsideDir, { recursive: true });
						const outside = path.join(outsideDir, "package-lock.json");
						fs.writeFileSync(outside, "{\n}\n");
						const manifest = h.write("package-lock.json", "{\n}\n");
						h.scan("trivy", {
							findings: [
								{
									vulnerabilityId: "CVE-2024-0001",
									pkgName: "left-pad",
									installedVersion: "1.0.0",
									fixedVersion: "1.0.1",
									severity: "HIGH",
									target: path.relative(h.cwd, outside),
								},
							],
							licenses: [],
							secrets: [],
						});
						h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
						h.runtime.beginTurn();
						const view = await h.turnEnd({
							flags,
							beforeDelivery: () => {
								fs.writeFileSync(manifest, '{\n  "x": 1\n}\n');
							},
						});
						expect(view.text).toContain("Dependency CVEs (trivy");
						expect(view.text).toContain(HISTORICAL);
						expect(view.text).not.toContain(UNKNOWN_STAMP);
					} finally {
						fs.rmSync(outsideDir, { recursive: true, force: true });
					}
				},
			});
		});

		// #4617 review V5: a blank target resolves to the scan root itself, a
		// directory and not a declaration, so it counts as a row that names no
		// target and the report falls back to the root manifests. Cited instead,
		// the directory left the live advisory reading historical.
		it("keeps a trivy CVE advisory current, bound to the root manifests, when its row names a blank target", async () => {
			await runTurnScenario({
				id: `no-write-provenance-trivy-blank-target-${guard}`,
				incident:
					"A CVE row with a blank target cited the workspace directory instead of its lockfile",
				issue: "#4617",
				async run(h) {
					h.write("package-lock.json", "{\n}\n");
					h.scan("trivy", {
						findings: [
							{
								vulnerabilityId: "CVE-2024-0001",
								pkgName: "left-pad",
								installedVersion: "1.0.0",
								fixedVersion: "1.0.1",
								severity: "HIGH",
								target: "",
							},
						],
						licenses: [],
						secrets: [],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Dependency CVEs (trivy");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 population A through the govulncheck LANE: the section reports the
		// call site each CVE is reachable from, so the lane hands back those files
		// as the section's subject. A change to one of them supersedes the text.
		it("keeps a govulncheck advisory current, bound to the call site it names", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-${guard}`,
				incident:
					"A Go CVE advisory was labelled historical on a bash-only turn",
				issue: "#4617",
				async run(h) {
					const callSite = h.write(
						"src/go/main.go",
						"package main\n\nfunc main() {}\n",
					);
					h.scan("govulncheck", {
						findings: [
							{
								osv: "GO-2024-1111",
								module: "example.com/module",
								trace: [{ filename: callSite, line: 3 }],
							},
						],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a govulncheck advisory historical when its call site changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-older-${guard}`,
				incident: "A call-site edit must supersede the cached Go CVE list",
				issue: "#4617",
				async run(h) {
					const callSite = h.write(
						"src/go/main.go",
						"package main\n\nfunc main() {}\n",
					);
					h.scan("govulncheck", {
						findings: [
							{
								osv: "GO-2024-1111",
								module: "example.com/module",
								trace: [{ filename: callSite, line: 3 }],
							},
						],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(
								callSite,
								"package main\n\nfunc main() { println(1) }\n",
							);
						},
					});
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 remainder: a Go CVE whose trace has no filename frame (a module-
		// or package-level finding) renders as `(module)` and names no call site,
		// so the section reached the stamp with no subject and a LIVE finding
		// read "Historical finding" on every bash-only turn. A Go CVE is pinned
		// by go.mod (#1622 H1), so the lane cites the module files, as the trivy
		// tiers cite their manifests.
		it("keeps a module-only Go CVE advisory current, bound to go.mod", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-module-${guard}`,
				incident:
					"A module-level Go CVE advisory was labelled historical on a bash-only turn",
				issue: "#4617",
				async run(h) {
					h.write("go.mod", "module example.com/app\n");
					seedModuleOnlyGoCve(h);
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain("(example.com/module)");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		it("labels a module-only Go CVE advisory historical when go.mod changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-module-older-${guard}`,
				incident: "A go.mod edit must supersede the cached module-level CVE",
				issue: "#4617",
				async run(h) {
					const goMod = h.write("go.mod", "module example.com/app\n");
					seedModuleOnlyGoCve(h);
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(
								goMod,
								"module example.com/app\n\nrequire example.com/module v1.2.0\n",
							);
						},
					});
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// A call-site CVE is pinned by go.mod too (#1622 H1): the bump that fixes
		// the module supersedes the advisory even though no row is module-only.
		it("labels a call-site Go CVE advisory historical when go.mod changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-callsite-gomod-${guard}`,
				incident: "A go.mod bump must supersede a call-site Go CVE advisory",
				issue: "#4617",
				async run(h) {
					const goMod = h.write("go.mod", "module example.com/app\n");
					const callSite = h.write(
						"src/go/main.go",
						"package main\n\nfunc main() {}\n",
					);
					h.scan("govulncheck", {
						findings: [
							{
								osv: "GO-2024-1111",
								module: "example.com/module",
								trace: [{ filename: callSite, line: 3 }],
							},
						],
					});
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(
								goMod,
								"module example.com/app\n\nrequire example.com/module v1.2.0\n",
							);
						},
					});
					expect(view.text).toContain("GO-2024-1111");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The manifest list the lane reads covers every ecosystem; a Go CVE is
		// pinned by the Go module files alone, so another ecosystem's manifest
		// moving on must not supersede it.
		it("keeps a module-only Go CVE advisory current when another ecosystem's manifest changed", async () => {
			await runTurnScenario({
				id: `no-write-provenance-govulncheck-module-other-${guard}`,
				incident: "A package.json edit superseded a Go module CVE",
				issue: "#4617",
				async run(h) {
					h.write("go.mod", "module example.com/app\n");
					const packageJson = h.write("package.json", "{}\n");
					seedModuleOnlyGoCve(h);
					h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(packageJson, '{"name":"x"}\n');
						},
					});
					expect(view.text).toContain("Go CVEs reachable from this code");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// A section that mixes a call-site CVE with a module-only one reports both
		// subjects: either file moving on supersedes it.
		describe.each([
			["go.mod", "go.mod", "module example.com/app\n\nrequire x v1\n"],
			[
				"the call site",
				"src/go/main.go",
				"package main\n\nfunc main() { println(1) }\n",
			],
		])(
			"a call-site and a module-only Go CVE, %s changed",
			(_label, rel, next) => {
				it("labels the advisory historical", async () => {
					await runTurnScenario({
						id: `no-write-provenance-govulncheck-mixed-${rel.replace(/\W/g, "-")}-${guard}`,
						incident:
							"A section citing only one of its two Go CVE subjects stayed current",
						issue: "#4617",
						async run(h) {
							h.write("go.mod", "module example.com/app\n");
							const callSite = h.write(
								"src/go/main.go",
								"package main\n\nfunc main() {}\n",
							);
							h.scan("govulncheck", {
								findings: [
									{
										osv: "GO-2024-1111",
										module: "example.com/module",
										trace: [{ filename: callSite, line: 3 }],
									},
									{
										osv: "GO-2024-9999",
										module: "example.com/other",
										trace: [],
									},
								],
							});
							h.runtime.appendCascadeRun(silentRun(h.pathOf("src/clean.ts")));
							h.runtime.beginTurn();
							const view = await h.turnEnd({
								flags,
								beforeDelivery: () => {
									fs.writeFileSync(h.pathOf(rel), next);
								},
							});
							expect(view.text).toContain("GO-2024-9999");
							expect(view.text).toContain(HISTORICAL);
							expect(view.text).not.toContain(UNKNOWN_STAMP);
						},
					});
				});
			},
		);

		// #4617 population B: a part with no file it could be stale against. The
		// deferred runner's crash note names no file, so the message had no stamp
		// subject at all and read historical however fresh the failure was.
		it("keeps a deferred runner failure note current", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-${guard}`,
				incident:
					"A runner that crashed during this turn was reported as historical",
				issue: "#4617",
				async run(h) {
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Deferred runner shellcheck failed");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 review F2 (probe A): the dominant carry path is not the cap. A run
		// the drain leaves unanswered at this turn's end settles later, and the
		// note it renders reports the earlier turn's bytes — so it reads carried
		// whatever mechanism delayed it.
		it("labels a runner failure note historical when its run settled after its own turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-late-settle-${guard}`,
				incident:
					"A crash note for a run deferred before this turn read as this turn's news",
				issue: "#4617",
				async run(h) {
					let settle = (): void => {};
					const inFlight = new Promise<RunnerResult>((resolve) => {
						settle = () =>
							resolve({
								status: "failed",
								failureKind: "spawn_failed",
								semantic: "warning",
								diagnostics: [],
							} as RunnerResult);
					});
					deferRunnerFindings({
						filePath: h.write("src/broken.sh", "echo broken\n"),
						cwd: h.cwd,
						projectRoot: h.cwd,
						runnerId: "shellcheck",
						markedAtMs: Date.now() - 2000,
						promise: inFlight,
					});
					h.runtime.beginTurn();
					const first = await h.turnEnd({ flags });
					expect(first.text).not.toContain("Deferred runner shellcheck failed");
					// The in-flight run settles only after the turn that dispatched it
					// has ended: production's own drain budget is zero.
					settle();
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const second = await h.turnEnd({ flags });
					expect(second.text).toContain("Deferred runner shellcheck failed");
					expect(second.text).toContain(HISTORICAL);
					expect(second.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		/**
		 * A crash note whose run stays in flight until `settle()`, dispatched by
		 * `sessionId` (a concurrent secondary's turn when it is not the
		 * coordinator's own).
		 */
		const deferInFlightBrokenRunner = (
			h: { write: (rel: string, body: string) => string; cwd: string },
			sessionId: string,
		): (() => void) => {
			let settle = (): void => {};
			const inFlight = new Promise<RunnerResult>((resolve) => {
				settle = () =>
					resolve({
						status: "failed",
						failureKind: "spawn_failed",
						semantic: "warning",
						diagnostics: [],
					} as RunnerResult);
			});
			deferRunnerFindings({
				filePath: h.write("src/broken.sh", "echo broken\n"),
				cwd: h.cwd,
				projectRoot: h.cwd,
				runnerId: "shellcheck",
				markedAtMs: Date.now() - 2000,
				promise: inFlight,
				sessionId,
			});
			return () => settle();
		};

		// #4617 review V1 (probe P4a, CodeRabbit PRRT_kwDORt8rec6x5fOh): a
		// concurrent secondary's turn does not move the coordinator's
		// `turnIndex`, so a carry measured on that clock never crossed anything
		// for the secondary and its late crash note read as this turn's news.
		// The secondary's own clock is `turnKey(sessionId)`.
		it("labels a secondary session's runner failure note historical when its run settled after that session's turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-secondary-late-settle-${guard}`,
				incident:
					"A subagent's crash note for a run its earlier turn left waiting read as this turn's news",
				issue: "#4617",
				async run(h) {
					const secondary = "secondary-session-1";
					const settle = deferInFlightBrokenRunner(h, secondary);
					h.runtime.beginTurn(secondary);
					const first = await h.turnEnd({ flags, sessionId: secondary });
					expect(first.text).not.toContain("Deferred runner shellcheck failed");
					settle();
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn(secondary);
					const second = await h.turnEnd({ flags, sessionId: secondary });
					expect(second.text).toContain("Deferred runner shellcheck failed");
					expect(second.text).toContain(HISTORICAL);
					expect(second.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 review V1, the other half (probe P4b, CodeRabbit
		// PRRT_kwDORt8rec6x5fOd): the coordinator's turn end keeps a secondary's
		// run it may not deliver. A stamp there records the COORDINATOR's
		// boundary, which the secondary never crossed, so on the secondary's own
		// clock its first turn end would read a fresh failure as historical.
		it("keeps a secondary session's runner failure note current when only the coordinator's turn ended before it settled", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-secondary-fresh-${guard}`,
				incident:
					"A subagent's crash note from its own turn read as historical after the main session's turn end",
				issue: "#4617",
				async run(h) {
					const secondary = "secondary-session-1";
					h.runtime.beginTurn();
					h.runtime.beginTurn(secondary);
					const settle = deferInFlightBrokenRunner(h, secondary);
					const primary = await h.turnEnd({ flags });
					expect(primary.text).not.toContain(
						"Deferred runner shellcheck failed",
					);
					settle();
					await new Promise<void>((resolve) => setImmediate(resolve));
					const own = await h.turnEnd({ flags, sessionId: secondary });
					expect(own.text).toContain("Deferred runner shellcheck failed");
					expect(own.text).not.toContain(HISTORICAL);
					expect(own.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// #4617 review F3 (probe H, CodeRabbit PRRT_kwDORt8rec6x4WEe): the
		// registry is keyed by part TEXT, so a fresh note identical to the
		// cap-held one overwrites `carried` with `this-turn` and the earlier-turn
		// evidence is lost. The carried arm wins over a later same-text write.
		it("labels a message historical when a carried crash note collides with an identical note from this turn", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-collision-${guard}`,
				incident:
					"A repeated runner failure overwrote the carried note's provenance",
				issue: "#4617",
				async run(h) {
					deferNoisyRunner(h, 25);
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const first = await h.turnEnd({ flags });
					expect(first.text).not.toContain("Deferred runner shellcheck failed");
					// A second failure of the same runner with the same text: the cap-held
					// note drains first, this turn's identical one second.
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const second = await h.turnEnd({ flags });
					expect(second.text).toContain("Deferred runner shellcheck failed");
					expect(second.text).toContain(HISTORICAL);
					expect(second.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Acceptance 3 (#4617): the mixed message. Every part qualifies — one
		// cited, one fileless — so the message is current; the cases below pin
		// that a part which is NEITHER still fails the whole message closed.
		it("keeps a message current when a cited part and a fileless part both qualify", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-qualified-${guard}`,
				incident:
					"A cited replay and a runner-crash note were both live this turn",
				issue: "#4617",
				async run(h) {
					deferBlockingLateRunner(h, "late-runner-mixed-qualified-1");
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({ flags });
					expect(view.text).toContain("Unresolved from this turn");
					expect(view.text).toContain("Deferred runner shellcheck failed");
					expect(view.text).not.toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// The mixed message's negative direction: the fileless half qualifies, the
		// cited half does not, so the message is historical.
		it("labels a mixed message historical when its cited part's file changed after the turn end", async () => {
			await runTurnScenario({
				id: `no-write-provenance-mixed-older-${guard}`,
				incident: "A stale cited part beside a live fileless part read current",
				issue: "#4617",
				async run(h) {
					const runnerFile = deferBlockingLateRunner(
						h,
						"late-runner-mixed-older-1",
					);
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							fs.writeFileSync(runnerFile, "echo changed\n");
						},
					});
					expect(view.text).toContain("Deferred runner shellcheck failed");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});

		// Acceptance 2, the carried half (#4617): a fileless part produced in an
		// EARLIER turn stays historical. The cap cuts the crash note this turn, the
		// delivery hold re-queues the failure, and the next turn re-renders it —
		// evidence captured a turn ago, not this one.
		it("labels a runner failure note carried from an earlier turn historical", async () => {
			await runTurnScenario({
				id: `no-write-provenance-failed-runner-carried-${guard}`,
				incident: "A crash note the cap held last turn re-delivered as current",
				issue: "#4617",
				async run(h) {
					// A burst of late findings fills the cap so the crash note after it
					// is the part cut.
					deferNoisyRunner(h, 25);
					deferBrokenRunner(h, "shellcheck");
					await new Promise<void>((resolve) => setImmediate(resolve));
					h.runtime.beginTurn();
					const first = await h.turnEnd({ flags });
					expect(first.text).not.toContain("Deferred runner shellcheck failed");
					// Next turn: the held failure is re-queued, re-rendered, and is
					// the only part left.
					h.runtime.beginTurn();
					const second = await h.turnEnd({ flags });
					expect(second.text).toContain("Deferred runner shellcheck failed");
					expect(second.text).toContain(HISTORICAL);
					expect(second.text).not.toContain(UNKNOWN_STAMP);
					// The carried part is a shape the composer knows, so the stamp is
					// well formed and truncated rather than "malformed-or-legacy".
					expect(second.text).toContain("session turn-harness-session");
				},
			});
		});

		it("labels a resolution historical when the stamping session is over", async () => {
			await runTurnScenario({
				id: `no-write-provenance-older-session-${guard}`,
				incident: "A stamped advisory from an older session must stay labelled",
				issue: "#4617",
				async run(h) {
					const file = h.write("src/value.ts", "export const value = 1;\n");
					h.runtime.beginTurn();
					h.blocker("src/value.ts", "L1: type mismatch");
					h.runtime.retireInlineBlockerOnConfirmedClean(
						file,
						h.runtime.nextWriteOrderToken(),
						["lsp"],
					);
					const view = await h.turnEnd({
						flags,
						beforeDelivery: () => {
							h.runtime.setTelemetryIdentity({ sessionId: "a-later-session" });
						},
					});
					expect(view.text).toContain("confirmed clean");
					expect(view.text).toContain(HISTORICAL);
					expect(view.text).not.toContain(UNKNOWN_STAMP);
				},
			});
		});
	},
);
