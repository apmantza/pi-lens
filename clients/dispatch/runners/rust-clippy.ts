/**
 * Rust clippy runner for dispatch system
 *
 * Runs `cargo clippy` for Rust files to catch common mistakes.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { RustClient } from "../../rust-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { tryLazyInstall } from "./utils/lazy-installer.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";

const rustClient = new RustClient();

const rustClippyRunner: RunnerDefinition = {
	id: "rust-clippy",
	appliesTo: ["rust"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 90_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Resolve cargo path using platform-aware lookup (handles ~/.cargo/bin on Windows)
		const cargoExe = rustClient.findCargoPath();
		if (!cargoExe) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const clippyCheck = await safeSpawnAsync(cargoExe, ["clippy", "--version"], {
			timeout: 8000,
			cwd: ctx.cwd,
		});
		if (clippyCheck.error || clippyCheck.status !== 0) {
			await tryLazyInstall("rust-clippy", ctx.cwd);
			const retry = await safeSpawnAsync(cargoExe, ["clippy", "--version"], {
				timeout: 8000,
				cwd: ctx.cwd,
			});
			if (retry.error || retry.status !== 0) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// Find the package root (where Cargo.toml is)
		const cargoToml = findCargoToml(ctx.filePath);
		if (!cargoToml) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run cargo clippy on the package
		const result = await safeSpawnAsync(
			cargoExe,
			["clippy", "--message-format=json", "-q"],
			{
				timeout: 60000,
				cwd: cargoToml.replace("Cargo.toml", ""),
			},
		);

		const raw = stripAnsi(result.stdout + result.stderr);

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse JSON output
		const diagnostics = parseClippyOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			// Non-parseable output
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw.substring(0, 500),
			};
		}

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

function findCargoToml(filePath: string): string | undefined {
	let dir = dirname(filePath);
	while (dir !== "/" && dir !== ".") {
		const cargoPath = join(dir, "Cargo.toml");
		if (existsSync(cargoPath)) {
			return cargoPath;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return undefined;
}

function parseClippyOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split("\n").filter((l) => l.trim());

	for (const line of lines) {
		try {
			const msg = JSON.parse(line);
			if (msg.reason !== "compiler-message") continue;

			const message = msg.message;
			if (!message) continue;

			// Only include messages for this file or project-wide
			const span = message.spans?.[0];
			if (!span) continue;

			diagnostics.push({
				id: `clippy-${message.code?.code || "unknown"}`,
				message: message.message || "Clippy warning",
				filePath: span.file || filePath,
				line: span.line_start || 0,
				column: span.column_start || 0,
				severity: message.level === "error" ? "error" : "warning",
				semantic: message.level === "error" ? "blocking" : "warning",
				tool: "rust-clippy",
				rule: message.code?.code,
				defectClass: "correctness",
			});
		} catch {
			// Not a JSON line, skip
		}
	}

	return diagnostics;
}

export default rustClippyRunner;
