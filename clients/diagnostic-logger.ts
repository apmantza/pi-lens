/**
 * Diagnostic Logger — append-only JSONL log for cross-session analytics
 *
 * Log file: ~/.pi-lens/logs/{date}.jsonl
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DiagnosticEntry {
	// When
	timestamp: string;

	// What was caught
	tool: "biome" | "eslint" | "ts-lsp" | "ruff" | "ast-grep" | "tree-sitter";
	ruleId: string;
	severity: "error" | "warning" | "info";
	language: string;

	// Where
	filePath: string;
	line: number;
	column: number;
	message: string;

	// What happened
	caughtByPipeline: boolean;
	shownInline: boolean;
	autoFixed: boolean;
	shownToAgent: boolean;
	agentFixed: boolean;
	unresolved: boolean;

	// Context
	model: string;
	sessionId: string;
	turnIndex: number;
	writeIndex: number;
}

export interface DiagnosticLogger {
	log(entry: DiagnosticEntry): void;
	logCaught(d: Diagnostic, context: LogContext, shownInline?: boolean): void;
	flush(): Promise<void>;
}

export interface Diagnostic {
	tool?: string;
	rule?: string;
	id?: string;
	severity?: string;
	language?: string;
	filePath: string;
	line?: number;
	column?: number;
	message?: string;
}

export interface LogContext {
	model: string;
	sessionId: string;
	turnIndex: number;
	writeIndex: number;
}

function getLogDir(): string {
	const home = os.homedir();
	const logDir = path.join(home, ".pi-lens", "logs");
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
	return logDir;
}

function getLogFile(): string {
	const date = new Date().toISOString().split("T")[0];
	return path.join(getLogDir(), `${date}.jsonl`);
}

// Module-level singleton — persists across all writes
let _logger: DiagnosticLogger | null = null;

export function getDiagnosticLogger(): DiagnosticLogger {
	if (!_logger) {
		_logger = createDiagnosticLogger();
	}
	return _logger;
}

export function createDiagnosticLogger(): DiagnosticLogger {
	const pending: DiagnosticEntry[] = [];
	let writing = false;

	const writePending = async () => {
		if (writing || pending.length === 0) return;
		writing = true;
		const toWrite = pending.splice(0, pending.length);
		const lines = toWrite.map((e) => JSON.stringify(e)).join("\n") + "\n";
		try {
			await fs.promises.appendFile(getLogFile(), lines);
		} catch (err) {
			// pi-lens-ignore: missing-error-propagation — fire-and-forget log write, must not throw
			console.error("Failed to write diagnostic log:", err);
		}
		writing = false;
	};

	return {
		log(entry: DiagnosticEntry) {
			if (
				process.env.PI_LENS_TEST_MODE === "1" ||
				(process.env.VITEST && process.env.PI_LENS_TEST_MODE !== "0")
			) {
				return;
			}
			pending.push(entry);
			writePending(); // async, non-blocking
		},

		logCaught(d: Diagnostic, context: LogContext, shownInline = false) {
			this.log({
				timestamp: new Date().toISOString(),
				tool: (d.tool as DiagnosticEntry["tool"]) || "unknown",
				ruleId: d.rule || d.id || "unknown",
				severity: (d.severity as DiagnosticEntry["severity"]) || "warning",
				language: d.language || "unknown",
				filePath: d.filePath,
				line: d.line || 1,
				column: d.column || 1,
				message: d.message || "",
				caughtByPipeline: true,
				shownInline,
				autoFixed: false,
				shownToAgent: shownInline,
				agentFixed: false,
				unresolved: true,
				model: context.model,
				sessionId: context.sessionId,
				turnIndex: context.turnIndex,
				writeIndex: context.writeIndex,
			});
		},

		async flush() {
			// Drain any buffered entries, then wait for the write to finish.
			await writePending();
			while (writing) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
	};
}
