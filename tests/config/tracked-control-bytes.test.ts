import * as fs from "node:fs";
import * as os from "node:os";
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
const MAX_REPORTED_CONTROL_BYTE_FINDINGS = 100;

export interface ControlByteViolation {
	file: string;
	offset: number;
	byte: number;
}

export interface ControlByteScanResult {
	violations: ControlByteViolation[];
	dropped: number;
}

function isForbiddenControlByte(byte: number): boolean {
	return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte);
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

export function scanTrackedSourceFiles(
	files: readonly string[],
	root = REPO_ROOT,
): ControlByteScanResult {
	const violations: ControlByteViolation[] = [];
	let dropped = 0;
	for (const file of files) {
		const bytes = fs.readFileSync(path.join(root, file));
		for (let offset = 0; offset < bytes.length; offset++) {
			const byte = bytes[offset];
			if (!isForbiddenControlByte(byte)) continue;
			if (violations.length < MAX_REPORTED_CONTROL_BYTE_FINDINGS) {
				violations.push({ file, offset, byte });
			} else {
				dropped++;
			}
		}
	}
	return { violations, dropped };
}

export function formatControlByteViolation(
	violation: ControlByteViolation,
): string {
	const codePoint = `U+${violation.byte.toString(16).padStart(4, "0").toUpperCase()}`;
	const escaped =
		violation.byte === 0
			? "\\^@"
			: `\\u${violation.byte.toString(16).padStart(4, "0")}`;
	return `${violation.file}: byte 0x${violation.byte.toString(16).padStart(2, "0").toUpperCase()} (${codePoint}) at offset ${violation.offset}; use escaped spelling such as ${escaped}.`;
}

export function formatControlByteScan(result: ControlByteScanResult): string {
	const lines = result.violations.map(formatControlByteViolation);
	if (result.dropped > 0) {
		lines.push(
			`... ${result.dropped} additional control-byte findings omitted after the report limit.`,
		);
	}
	return lines.join("\n");
}

describe("tracked source files contain no literal control bytes (#2571)", () => {
	it("scans a non-empty tracked TypeScript, JavaScript, and Markdown population", () => {
		const files = trackedSourceFiles();
		// Calibration: 1,514 TypeScript, 99 MJS, and 64 Markdown files are
		// tracked on this tree OUTSIDE `.changelog/`. Each floor is below half
		// its live population. The Markdown floor deliberately ignores the
		// `.changelog/*.md` fragments: they are transient and vanish on every
		// release roll (the 4.1.4 bump consumed 151 of them and a floor of 80,
		// calibrated while they existed, went red on the release PR).
		assertNonEmptyScan("git ls-files source population", files.length, 800);
		assertNonEmptyScan(
			"git ls-files TypeScript population",
			files.filter((file) => file.endsWith(".ts")).length,
			700,
		);
		assertNonEmptyScan(
			"git ls-files MJS population",
			files.filter((file) => file.endsWith(".mjs")).length,
			45,
		);
		assertNonEmptyScan(
			"git ls-files Markdown population",
			files.filter((file) => file.endsWith(".md")).length,
			30,
		);
		const result = scanTrackedSourceFiles(files);
		const report = formatControlByteScan(result);
		expect(result.violations, report).toEqual([]);
		expect(result.dropped, report).toBe(0);
	});

	it("reports a literal NUL through the real scan and formatting seam", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-"),
		);
		try {
			const file = "fixture.ts";
			fs.writeFileSync(
				path.join(fixtureRoot, file),
				Buffer.from([0x70, 0x00, 0x69]),
			);
			const result = scanTrackedSourceFiles([file], fixtureRoot);
			expect(result.violations).toEqual([{ file, offset: 1, byte: 0x00 }]);
			expect(formatControlByteScan(result)).toContain(
				`${file}: byte 0x00 (U+0000) at offset 1; use escaped spelling such as \\^@.`,
			);
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("reports 0x01, 0x1B, and 0x1F control bytes with the correct code point and escaped remediation", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-nonnul-"),
		);
		try {
			const cases: ReadonlyArray<{
				file: string;
				byte: number;
				codePoint: string;
				escaped: string;
			}> = [
				{ file: "soh.ts", byte: 0x01, codePoint: "U+0001", escaped: "\\u0001" },
				{ file: "esc.ts", byte: 0x1b, codePoint: "U+001B", escaped: "\\u001b" },
				{ file: "us.ts", byte: 0x1f, codePoint: "U+001F", escaped: "\\u001f" },
			];
			for (const { file, byte, codePoint, escaped } of cases) {
				fs.writeFileSync(
					path.join(fixtureRoot, file),
					Buffer.from([0x61, byte, 0x62]),
				);
				const result = scanTrackedSourceFiles([file], fixtureRoot);
				expect(result.violations).toEqual([{ file, offset: 1, byte }]);
				const hex = byte.toString(16).padStart(2, "0").toUpperCase();
				expect(formatControlByteScan(result)).toContain(
					`${file}: byte 0x${hex} (${codePoint}) at offset 1; use escaped spelling such as ${escaped}.`,
				);
			}
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("bounds records across files and reports the dropped count without losing per-file identity", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-dense-"),
		);
		try {
			const fileA = "dense-a.md";
			const fileB = "dense-b.md";
			// 60 + 60 = 120 violations across two files against a 100-record cap:
			// the first 60 come from fileA, the cap is reached 40 bytes into
			// fileB, and fileB's remaining 20 bytes are dropped. This pins that
			// the shared cap is enforced across files, not reset per file, and
			// that dropped findings from a later file are still visible (by
			// name in the report, and by count) rather than silently absorbed
			// into the earlier file's tally.
			fs.writeFileSync(path.join(fixtureRoot, fileA), Buffer.alloc(60, 0x00));
			fs.writeFileSync(path.join(fixtureRoot, fileB), Buffer.alloc(60, 0x00));
			const result = scanTrackedSourceFiles([fileA, fileB], fixtureRoot);
			expect(result.violations.length).toBe(100);
			expect(
				result.violations.filter((violation) => violation.file === fileA)
					.length,
			).toBe(60);
			expect(
				result.violations.filter((violation) => violation.file === fileB)
					.length,
			).toBe(40);
			expect(result.dropped).toBe(20);
			const report = formatControlByteScan(result);
			expect(report).toContain(fileB);
			expect(report).toContain(
				"... 20 additional control-byte findings omitted after the report limit.",
			);
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("does not treat printable space (0x20) as a control byte", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-space-"),
		);
		try {
			const file = "space.ts";
			fs.writeFileSync(path.join(fixtureRoot, file), Buffer.from([0x20]));
			const result = scanTrackedSourceFiles([file], fixtureRoot);
			expect(result).toEqual({ violations: [], dropped: 0 });
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("allows tab, line feed, and carriage return", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-allowed-"),
		);
		try {
			const file = "allowed.ts";
			fs.writeFileSync(
				path.join(fixtureRoot, file),
				Buffer.from([0x09, 0x0a, 0x0d]),
			);
			const result = scanTrackedSourceFiles([file], fixtureRoot);
			expect(result).toEqual({ violations: [], dropped: 0 });
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
// flake-shape: real-process-spawn — real git bytes are the tracked-control contention boundary
