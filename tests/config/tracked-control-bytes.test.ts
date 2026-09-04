import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

export interface ControlByteFinding {
	offset: number;
	byte: number;
}

/** Return every byte below U+0020 except the three source line controls. */
export function findForbiddenControlBytes(
	bytes: Uint8Array,
): ControlByteFinding[] {
	const findings: ControlByteFinding[] = [];
	for (let offset = 0; offset < bytes.length; offset++) {
		const byte = bytes[offset];
		if (byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte)) {
			findings.push({ offset, byte });
		}
	}
	return findings;
}

function trackedSourceFiles(): string[] {
	const output = gitExecFileSync(
		"git",
		["ls-files", "-z", "--", "*.ts", "*.mjs", "*.md"],
		{ cwd: REPO_ROOT },
	) as Buffer;
	return output
		.toString("utf8")
		.split("\0")
		.filter((file): file is string => file.length > 0);
}

function scanTrackedSourceFiles(files: readonly string[]): string[] {
	const violations: string[] = [];
	for (const file of files) {
		const bytes = fs.readFileSync(path.join(REPO_ROOT, file));
		for (const finding of findForbiddenControlBytes(bytes)) {
			const codePoint = `U+${finding.byte.toString(16).padStart(4, "0").toUpperCase()}`;
			const escaped = `\\u${finding.byte.toString(16).padStart(4, "0")}`;
			violations.push(
				`${file}: byte 0x${finding.byte.toString(16).padStart(2, "0").toUpperCase()} (${codePoint}) at offset ${finding.offset}; use escaped spelling such as ${escaped}.`,
			);
		}
	}
	return violations;
}

describe("tracked source files contain no literal control bytes (#2571)", () => {
	it("scans a non-empty tracked TypeScript, JavaScript, and Markdown population", () => {
		const files = trackedSourceFiles();
		// Calibration: 1,786 tracked source files are scanned on this tree. Keep
		// the floor below half the population so a silently empty walk still reds.
		assertNonEmptyScan("git ls-files source population", files.length, 800);
		const violations = scanTrackedSourceFiles(files);
		expect(violations, violations.join("\n")).toEqual([]);
	});

	// Red-first fixture: this is an actual NUL byte in the input buffer, not the
	// two-character escaped spelling that the repository guard must recommend.
	it("reports a literal NUL with its escaped remediation", () => {
		const findings = findForbiddenControlBytes(
			Uint8Array.from([0x70, 0x00, 0x01, 0x1f, 0x69]),
		);
		expect(findings).toEqual([
			{ offset: 1, byte: 0x00 },
			{ offset: 2, byte: 0x01 },
			{ offset: 3, byte: 0x1f },
		]);
		const escaped = "\\u0000";
		expect(
			`U+${findings[0].byte.toString(16).padStart(4, "0")}; use escaped spelling such as ${escaped}.`,
		).toContain(escaped);
	});

	it("allows tab, line feed, and carriage return", () => {
		expect(
			findForbiddenControlBytes(Uint8Array.from([0x09, 0x0a, 0x0d])),
		).toEqual([]);
	});
});
