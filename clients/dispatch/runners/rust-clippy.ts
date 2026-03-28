/**
 * Rust clippy runner for dispatch system
 *
 * Runs `cargo clippy` for Rust files to catch common mistakes.
 */

import type { DispatchContext, Diagnostic, RunnerDefinition, RunnerResult } from "../types.js";
import { spawnSync } from "node:child_process";
import { stripAnsi } from "../../sanitize.js";

const rustClippyRunner: RunnerDefinition = {
	id: "rust-clippy",
	appliesTo: ["rust"],
	priority: 15,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Check if cargo is available
		const check = spawnSync("cargo", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			shell: true,
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
		const result = spawnSync(
			"cargo",
			["clippy", "--message-format=json", "-q"],
			{
				encoding: "utf-8",
				timeout: 60000,
				shell: true,
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
	const { dirname, join } = require("node:path");
	const { existsSync } = require("node:fs");

	let dir = filePath;
	for (let i = 0; i < 10; i++) {
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

function parseClippyOutput(raw: string, targetFile: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const msg = JSON.parse(line);
			if (msg.message?.spans) {
				for (const span of msg.message.spans) {
					if (span.file_name?.includes(targetFile.replace(/\\/g, "/"))) {
						const diagFilePath = targetFile;
						diagnostics.push({
							id: `clippy-${span.line_start || 0}-${msg.message.code?.code || "unknown"}`,
							message: msg.message.message,
							filePath: diagFilePath,
							line: span.line_start,
							column: span.column_start,
							severity: msg.level === "error" ? "error" : "warning",
							semantic: msg.level === "error" ? "blocking" : "warning",
							tool: "clippy",
							rule: msg.message.code?.code || "clippy",
						});
					}
				}
			}
		} catch {
			// Not JSON, skip
		}
	}

	return diagnostics;
}

export default rustClippyRunner;
