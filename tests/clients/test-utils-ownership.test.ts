import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("test fixture ownership cleanup (#2912)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeAll(() => {
		env = setupTestEnvironment("pi-lens-ownership-setup-");
		createTempFile(env.tmpDir, "shared.txt", "shared\n");
	});
	afterAll(() => env.cleanup());

	it("keeps a beforeAll fixture for the first test", () => {
		expect(fs.readFileSync(`${env.tmpDir}/shared.txt`, "utf8")).toBe(
			"shared\n",
		);
	});

	it("keeps a beforeAll fixture for later tests in the file", () => {
		expect(fs.readFileSync(`${env.tmpDir}/shared.txt`, "utf8")).toBe(
			"shared\n",
		);
	});
});
