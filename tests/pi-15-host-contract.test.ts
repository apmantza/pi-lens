/** #5199: pin coercion and validation at pi's real model/tool boundary. */
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { readProjectTrustFromContext } from "../clients/project-trust.js";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	fauxAssistantMessage,
	fauxToolCall,
	hostPackageDir,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

const fixture = piSessionFixture();
const hostPackage = hostPackageDir();
const hostVersion = JSON.parse(
	fs.readFileSync(path.join(hostPackage, "package.json"), "utf8"),
).version;

describe("pi 1.5 tool contracts (#5199)", () => {
	it("coerces a scalar array argument before activating a pi-lens tool", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			responses: [
				fauxAssistantMessage(
					fauxToolCall("pi_lens_activate_tools", { tools: "ast_grep_search" }),
				),
				fauxAssistantMessage("done"),
			],
		});
		await handle.prompt("activate search");
		const result = handle.requests[1]?.find(
			(message) => message.role === "toolResult",
		);
		expect(result?.isError).toBe(false);
		expect(result?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(
					/^Activated: ast_grep_search\. Available starting next turn\./,
				),
			}),
		]);
	});

	it("coerces a numeric string before a pi-lens module report", async () => {
		const cwd = path.join(fixture.root, "numeric", "proj");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(
			path.join(cwd, "example.ts"),
			"export function greet() { return 'hello'; }\n",
		);
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [
				fauxAssistantMessage(
					fauxToolCall("module_report", {
						path: "example.ts",
						maxRefsPerSymbol: "1",
					}),
				),
				fauxAssistantMessage("done"),
			],
		});
		await handle.prompt("report on example.ts");
		const result = handle.requests[1]?.find(
			(message) => message.role === "toolResult",
		);
		expect(result?.isError).toBe(false);
		expect(JSON.stringify(result?.content)).toContain("greet");
	});

	it.skipIf(hostVersion !== "1.5.0")(
		"delivers pi-schema validation wording unchanged to the agent (requires resolved pi 1.5.0)",
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				responses: [
					fauxAssistantMessage(
						fauxToolCall("module_report", {
							path: "example.ts",
							maxRefsPerSymbol: "invalid",
						}),
					),
					fauxAssistantMessage("done"),
				],
			});
			await handle.prompt("report with invalid limit");
			const result = handle.requests[1]?.find(
				(message) => message.role === "toolResult",
			);
			expect(result?.isError).toBe(true);
			expect(result?.content).toEqual([
				{
					type: "text",
					text: 'Validation failed for tool "module_report":\n  - maxRefsPerSymbol: expected number, got string\n\nReceived arguments:\n{\n  "path": "example.ts",\n  "maxRefsPerSymbol": "invalid"\n}',
				},
			]);
		},
	);
});

// #5199: a saved refusal must reach pi-lens even with the host configured
// to auto-trust by default; use pi's persisted store rather than a boolean double.
it("reads a saved Do not trust decision despite defaultProjectTrust always", async () => {
	const dist = path.join(hostPackage, "dist");
	const { ProjectTrustStore, hasTrustRequiringProjectResources } = await import(
		pathToFileURL(path.join(dist, "core/trust-manager.js")).href
	);
	const { resolveProjectTrusted } = await import(
		pathToFileURL(path.join(dist, "core/project-trust.js")).href
	);
	// #5200 F3: the filesystem root has no ancestors to contribute skills.
	// Only read it; the persisted store stays inside the disposable fixture.
	const cwd = path.parse(fixture.root).root;
	expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
	const agentDir = path.join(fixture.root, "trust", "agent");
	const store = new ProjectTrustStore(agentDir);
	store.set(cwd, false);
	const reopened = new ProjectTrustStore(agentDir);
	expect(reopened.get(cwd)).toBe(false);
	const trusted = await resolveProjectTrusted({
		cwd,
		trustStore: reopened,
		defaultProjectTrust: "always",
		projectTrustContext: { hasUI: false },
	});
	expect(readProjectTrustFromContext({ isProjectTrusted: () => trusted })).toBe(
		"untrusted",
	);
});
