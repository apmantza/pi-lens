/**
 * Rust clippy runner for dispatch system
 *
 * Runs `cargo clippy` for Rust files to catch common mistakes.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeSpawn } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

const rustClippyRunner: RunnerDefinition = {
	id: "rust-clippy",
	appliesTo: ["rust"],
	priority: 15,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if cargo is available
		const check = safeSpawn("cargo", ["--version"], {
			timeout: 5000,
		});

		if (check.error || check.status !== 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Find the package root (where Cargo.toml is)
		const cargoToml = findCargoToml(ctx.filePath);
		if (!cargoToml) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run cargo clippy on the package
		const result = safeSpawn(
			"cargo",
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

		return {
			status: "failed",
			diagnostics,
			semantic: "warning",
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
			});
		} catch {
			// Not a JSON line, skip
		}
	}

	return diagnostics;
}

export default rustClippyRunner;
