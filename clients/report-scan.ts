/**
 * One report-file scan lifecycle for the session scanners whose CLI writes a
 * JSON report file: gitleaks (#130), trivy (#131), opengrep (#584), jscpd.
 *
 * Each of them wrapped a tool-specific argv and parser in the same sequence:
 * make a private report directory under the scanner temp root, spawn the CLI
 * against it, decide what a missing report means, read and parse the report the
 * CLI did write, and remove the directory whatever happened. That sequence was
 * written four times, and copies drift: the same CLI outcome read as a clean
 * scan for one scanner and as a refusal for another, which is the shape #5411
 * was filed over. This module owns the sequence once; the caller supplies the
 * argv (`spawn`), the result shape (`parse`, `fail`) and its own ledger lane
 * (`recordFailure`).
 *
 * Result policy, the same for every caller:
 *
 * - a spawn error, a throw, or a non-zero exit that left no report is an
 *   unsuccessful empty result and one `recordFailure` call;
 * - a CLI that exits 0 without writing its report is a successful empty one
 *   carrying stderr's first line: a missing file after a clean exit is an empty
 *   run for all four. Whether a clean run writes the report is per CLI and is
 *   not assumed: gitleaks and trivy write it, as their clients assume (not
 *   re-measured here); opengrep's clean run is unmeasured (no binary on the
 *   host this was written on); jscpd writes none (measured on 3.5.10, #1736).
 *   A non-zero exit before the report means the scan never ran and must not be
 *   cached as clean;
 * - a report that exists is parsed whatever the exit code: the run's verdict is
 *   the report's own content, which is each client's `parse` to judge;
 * - `parse` runs inside the guard, so its own throw lands in the same
 *   unsuccessful result and the same record, not in a client-side catch. A
 *   report that is not JSON (cut short by a killed CLI, or garbage) is such a
 *   throw (`parseReportJson`): it never reads as a scan that found nothing.
 *
 * Refs: #130, #131, #584, #1736, #1816, #4133, #5411, #5447
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatToolFailure } from "./dispatch/runners/utils/tool-failure.js";
import { LEDGER_FIELD_MAX } from "./ledger-bounds.js";
import type { SpawnFailureKind, SpawnResult } from "./safe-spawn.js";
import { scannerReportParentDir } from "./scanner-temp-root.js";

/** How a scan that never reached its parse failed. */
export type ReportScanOutcome = "spawn-error" | "no-report" | "crashed";

/**
 * One non-parse outcome, handed to `fail` (which builds the client's result) and
 * to `recordFailure` (which counts it in the client's ledger lane). The shared
 * parts are computed here so the wording and the exit-status reading cannot
 * differ per client; the fields a client may want to spell its own way
 * (`errorMessage`, `spawnFailure`) are carried raw beside `summary`.
 */
export type ReportScanFailure = {
	outcome: ReportScanOutcome;
	/** Stamped before the report directory exists, so it is the run's own read time. */
	scannedAt: string;
	/**
	 * The child's exit status, or `null` when it never ran or never ended. A
	 * crashed outcome always carries `null`, even when the child ran before the
	 * throw.
	 */
	status: number | null;
	/** The signal that ended the child, when one did. */
	signal: NodeJS.Signals | undefined;
	/** The CLI's stderr, verbatim. */
	stderr: string;
	/** The spawn error's message, for a child that never ran. */
	errorMessage?: string;
	/** `safeSpawnAsync`'s classification of that spawn failure. */
	spawnFailure?: SpawnFailureKind;
	/** One bounded reason, fit for a result summary and a ledger row alike. */
	summary: string;
	/** Set for a zero exit that wrote no report: an empty run, not a failure. */
	success?: true;
};

/** What the CLI did, handed to `parse` alongside the report bytes. */
export type ReportScanRun = {
	status: number | null;
	signal: NodeJS.Signals | undefined;
};

export type ReportScanSpec<TResult> = {
	/** Run the CLI. It must write its report at `reportPath`. */
	spawn: (paths: {
		outDir: string;
		reportPath: string;
	}) => Promise<SpawnResult>;
	/** Turn the report the CLI wrote into the client's result. */
	parse: (
		raw: string,
		scannedAt: string,
		run: ReportScanRun,
	) => TResult | Promise<TResult>;
	/** Build the client's empty result for a non-parse outcome. */
	fail: (failure: ReportScanFailure) => TResult;
	/**
	 * Count one unsuccessful outcome in the client's own ledger lane. Called
	 * once per failed scan, with the same `summary` the result carries, so the
	 * row and the result the agent sees cannot disagree about why.
	 */
	recordFailure?: (failure: ReportScanFailure) => void;
	/**
	 * Extra discriminating identity for the missing-report reason (#1816's
	 * `fields`, e.g. jscpd naming the `npx` fallback vs a local binary). Read
	 * when the reason is built, which is after `spawn` settled, so a client that
	 * discovers its command inside `spawn` can still name it.
	 */
	failureFields?: () => Record<string, string | number | undefined>;
	/** The client's verbose logger; every failure is logged before it is failed. */
	log?: (msg: string) => void;
};

/**
 * Parse a report's bytes as JSON, or throw `unreadable <tool> report: <why>`.
 * The throw is the verdict (#5447): a parser that returned `[]` for bytes it
 * could not read made `runReportScan` record an analysed success with zero
 * findings, so a truncated secrets or vulnerability report read as clean. Called
 * inside a `parse`, the throw lands in the guard below as one failed scan and
 * one record. Callers keep their own `!raw.trim()` arm: an empty file is an
 * empty run, not an unreadable report.
 */
export function parseReportJson(toolName: string, raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`unreadable ${toolName} report: ${message}`);
	}
}

/**
 * Scan with a CLI that writes a JSON report file. See the module doc for the
 * result policy; the report directory is removed on every path.
 */
export async function runReportScan<TResult>(
	toolName: string,
	spec: ReportScanSpec<TResult>,
): Promise<TResult> {
	const scannedAt = new Date().toISOString();
	const outDir = fs.mkdtempSync(
		path.join(scannerReportParentDir(), `pi-lens-${toolName}-`),
	);
	const reportPath = path.join(outDir, `${toolName}-report.json`);
	/** Record the outcome in the caller's lane, then hand it to the caller. */
	const failed = (failure: ReportScanFailure): TResult => {
		spec.recordFailure?.(failure);
		return spec.fail(failure);
	};
	try {
		const result = await spec.spawn({ outDir, reportPath });

		if (result.error) {
			const message = result.error.message;
			spec.log?.(`Scan error: ${message}`);
			return failed({
				outcome: "spawn-error",
				scannedAt,
				status: result.status,
				signal: result.signal,
				stderr: result.stderr ?? "",
				errorMessage: message,
				...(result.failure ? { spawnFailure: result.failure } : {}),
				summary: message.slice(0, LEDGER_FIELD_MAX),
			});
		}

		const stderr = result.stderr ?? "";
		if (!fs.existsSync(reportPath)) {
			// Shape 10: a CLI that stopped with a non-zero exit before writing its
			// report did not scan, so it is not a clean scan.
			if (result.status !== 0) {
				const reason = formatToolFailure({
					tool: toolName,
					status: result.status,
					// A null exit with a signal is only explainable by the signal, and
					// the four report scanners now say it the same way (#5411).
					signal: result.signal ?? null,
					stderr,
					reportMissing: true,
					...(spec.failureFields ? { fields: spec.failureFields() } : {}),
				});
				spec.log?.(reason);
				return failed({
					outcome: "no-report",
					scannedAt,
					status: result.status,
					signal: result.signal,
					stderr,
					summary: reason,
				});
			}
			return spec.fail({
				outcome: "no-report",
				scannedAt,
				status: result.status,
				signal: result.signal,
				stderr,
				success: true,
				summary: stderr.trim().split("\n")[0] || "no report produced",
			});
		}

		return await spec.parse(fs.readFileSync(reportPath, "utf-8"), scannedAt, {
			status: result.status,
			signal: result.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		spec.log?.(`Scan error: ${message}`);
		const failure: ReportScanFailure = {
			outcome: "crashed",
			scannedAt,
			status: null,
			signal: undefined,
			stderr: "",
			summary: message.slice(0, LEDGER_FIELD_MAX),
		};
		// Recorded here, at the handler's top level: the silent-catch sweep reads a
		// record made through the `failed` closure as silent (#5440 r1 F3).
		spec.recordFailure?.(failure);
		return spec.fail(failure);
	} finally {
		try {
			fs.rmSync(outDir, { recursive: true, force: true });
		} catch {
			// none: a report directory left under the scanner temp root is inert and the scan's result is already built
		}
	}
}
