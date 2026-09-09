import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSortedRegistry } from "../support/sweep-kit.js";

describe("DegradationKind registry (#2671)", () => {
	it("keeps the literal members alphabetically ordered", () => {
		// Recurrence: parallel PRs appended kinds in different positions, making
		// the shared telemetry vocabulary a recurring merge-conflict magnet.
		const source = fs.readFileSync(
			path.join(process.cwd(), "clients/degradation-ledger.ts"),
			"utf8",
		);
		const body = source.match(
			/export type DegradationKind =([\s\S]*?)\n\nexport interface DegradationRecord/,
		)?.[1];
		expect(body).toBeDefined();
		const keys = [...(body ?? "").matchAll(/\| "([^"]+)"/g)].map(
			(match) => match[1],
		);
		assertSortedRegistry("DegradationKind", keys);
	});
});
