import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArchitectClient } from "../../clients/architect-client.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("architect-client", () => {
	it("skips invalid regex patterns without throwing", () => {
		const env = setupTestEnvironment("pi-lens-architect-");
		try {
			const configDir = path.join(env.tmpDir, ".pi-lens");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(
				path.join(configDir, "architect.yaml"),
				"version: '1'\nrules:\n  - pattern: '**/*.ts'\n    must_not:\n      - pattern: '(unclosed'\n        message: 'invalid regex'\n      - pattern: 'console\\.log\\('\n        message: 'no console calls'\n",
			);

			const client = new ArchitectClient(false);
			expect(client.loadConfig(env.tmpDir)).toBe(true);
			expect(() => client.checkFile("src/app.ts", "console.log('x');\n")).not.toThrow();
			expect(
				client.checkFile("src/app.ts", "console.log('x');\n").map((v) => v.message),
			).toEqual(["no console calls"]);
		} finally {
			env.cleanup();
		}
	});
});
