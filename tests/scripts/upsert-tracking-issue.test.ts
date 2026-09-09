import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../scripts/upsert-tracking-issue.mjs";

function run(args: string[], existing: unknown[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-lens-upsert-"));
	const body = join(dir, "body.md");
	writeFileSync(body, "body");
	const calls: string[][] = [];
	const out = main([...args, "--body-file", body], (call) => {
		calls.push(call);
		return call[1] === "list" ? JSON.stringify(existing) : "ok";
	});
	return {
		out,
		calls,
	};
}

describe("upsert-tracking-issue.mjs", () => {
	it("creates, updates with a recurrence comment, and closes through one argv seam", () => {
		const created = run(["--title", "tracker", "--label", "area:tests"]);
		expect(created.calls.some((a) => a[1] === "create")).toBe(true);

		const updated = run(
			["--title", "tracker", "--label", "area:tests", "--comment", "again"],
			[{ number: 7, title: "tracker" }],
		);
		expect(updated.calls.some((a) => a[1] === "edit")).toBe(true);
		expect(updated.calls.some((a) => a[1] === "comment")).toBe(true);

		const clean = run(
			[
				"--title",
				"tracker",
				"--label",
				"area:tests",
				"--clean",
				"--close-when-clean",
			],
			[{ number: 7, title: "tracker" }],
		);
		expect(clean.calls.some((a) => a[1] === "close")).toBe(true);

		const noClose = run(
			["--title", "tracker", "--label", "area:tests", "--clean"],
			[{ number: 7, title: "tracker" }],
		);
		expect(noClose.calls.some((a) => a[1] === "close")).toBe(false);
	});

	it("propagates the gh failure for the CLI to report", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-upsert-failure-"));
		const body = join(dir, "body.md");
		writeFileSync(body, "body");
		expect(() =>
			main(
				["--title", "tracker", "--label", "area:tests", "--body-file", body],
				() => {
					throw new Error("gh unavailable");
				},
			),
		).toThrow("gh unavailable");
	});
});
