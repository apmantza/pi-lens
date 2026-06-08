import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piLens from "../index.js";
import { createPiMock, makeCtx, type PiMock } from "./support/pi-mock.js";

// Template for #171: a command test driven entirely through the shared
// createPiMock() harness — no bespoke ExtensionAPI mock. Run the real entry,
// then invoke the registered command handler and assert captured UI calls.

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-toggle-config-"));
	tmpDirs.push(dir);
	process.env.PI_LENS_CONFIG_PATH = path.join(dir, "missing-config.json");
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function installLens(flagValues: Record<string, boolean | string> = {}): PiMock {
	const pi = createPiMock(flagValues);
	piLens(pi.asExtensionAPI());
	return pi;
}

describe("lens-toggle command", () => {
	it("registers the single session-level lens toggle command", () => {
		const pi = installLens();

		expect(pi.flags.has("no-lens")).toBe(true);
		expect(pi.getCommand("lens-toggle")).toBeDefined();
		expect(pi.getCommand("lens-widget-toggle")).toBeDefined();
		expect(pi.getCommand("lens-enable")).toBeUndefined();
		expect(pi.getCommand("lens-disable")).toBeUndefined();
		expect(pi.getCommand("lens-status")).toBeUndefined();
		expect(pi.getCommand("lens")).toBeUndefined();
	});

	it("toggles an enabled session off and back on", async () => {
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-toggle", "", ctx);
		await pi.runCommand("lens-toggle", "", ctx);

		expect(ctx.notifications[0]).toEqual({
			message:
				"pi-lens disabled for this session. Run /lens-toggle again to resume.",
			type: "warning",
		});
		expect(ctx.notifications[1]).toEqual({
			message: "pi-lens enabled for this session.",
			type: "info",
		});
	});

	it("re-enables a session started with --no-lens", async () => {
		const pi = installLens({ "no-lens": true });
		const ctx = makeCtx();

		await pi.runCommand("lens-toggle", "", ctx);

		expect(ctx.notifications).toContainEqual({
			message: "pi-lens enabled for this session.",
			type: "info",
		});
	});

	it("toggles the diagnostics widget off and on", async () => {
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);
		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: undefined,
			options: undefined,
		});
		expect(ctx.widgetCalls[1].key).toBe("pi-lens");
		expect(typeof ctx.widgetCalls[1].content).toBe("function");
		expect(ctx.widgetCalls[1].options).toEqual({ placement: "belowEditor" });

		expect(ctx.notifications[0]).toEqual({
			message: "pi-lens widget hidden. Run /lens-widget-toggle to show it.",
			type: "info",
		});
		expect(ctx.notifications[1]).toEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});

	it("starts the diagnostics widget hidden from global config", async () => {
		const configPath = process.env.PI_LENS_CONFIG_PATH;
		expect(configPath).toBeDefined();
		fs.writeFileSync(
			configPath as string,
			JSON.stringify({ widget: { visible: false } }),
			"utf-8",
		);
		const pi = installLens();
		const ctx = makeCtx();

		await pi.runCommand("lens-widget-toggle", "", ctx);

		expect(ctx.widgetCalls[0]).toEqual({
			key: "pi-lens",
			content: expect.any(Function),
			options: { placement: "belowEditor" },
		});
		expect(ctx.notifications).toContainEqual({
			message: "pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			type: "info",
		});
	});
});
