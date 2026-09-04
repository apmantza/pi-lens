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
		// Calibration: 1,514 TypeScript, 99 MJS, and 175 Markdown files are
		// tracked on this tree. Each floor is below half its live population.
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
			80,
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

	it("bounds records and reports the dropped count without losing identity", () => {
		const fixtureRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-control-byte-dense-"),
		);
		try {
			const file = "dense.md";
			fs.writeFileSync(path.join(fixtureRoot, file), Buffer.alloc(128, 0x00));
			const result = scanTrackedSourceFiles([file], fixtureRoot);
			expect(result.violations.length).toBeGreaterThan(0);
			expect(result.violations.length).toBeLessThanOrEqual(100);
			expect(
				result.violations.every(
					(violation) => violation.file === file && violation.byte === 0x00,
				),
			).toBe(true);
			expect(result.dropped).toBe(128 - result.violations.length);
			expect(formatControlByteScan(result)).toContain(
				`... ${result.dropped} additional control-byte findings omitted after the report limit.`,
			);
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
