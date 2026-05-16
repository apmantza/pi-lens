import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piLens from "../index.js";

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

type CommandHandler = (
	args: unknown,
	ctx: {
		ui: {
			notify: ReturnType<typeof vi.fn>;
			setWidget?: ReturnType<typeof vi.fn>;
		};
	},
) => Promise<void> | void;

type Harness = {
	commands: Map<string, { description?: string; handler: CommandHandler }>;
	flags: Map<string, { default?: unknown }>;
};

function installLens(flagValues: Record<string, unknown> = {}): Harness {
	const commands = new Map<
		string,
		{ description?: string; handler: CommandHandler }
	>();
	const flags = new Map<string, { default?: unknown }>();
	const handlers = new Map<string, Function[]>();

	const pi = {
		events: { emit: vi.fn() },
		registerFlag: vi.fn((name: string, config: { default?: unknown }) => {
			flags.set(name, config);
		}),
		getFlag: vi.fn((name: string) => {
			if (Object.hasOwn(flagValues, name)) {
				return flagValues[name];
			}
			return flags.get(name)?.default ?? false;
		}),
		registerCommand: vi.fn(
			(
				name: string,
				config: { description?: string; handler: CommandHandler },
			) => {
				commands.set(name, config);
			},
		),
		registerTool: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		sendUserMessage: vi.fn(),
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};

	piLens(pi as any);
	return { commands, flags };
}

describe("lens-toggle command", () => {
	it("registers the single session-level lens toggle command", () => {
		const { commands, flags } = installLens();

		expect(flags.has("no-lens")).toBe(true);
		expect(commands.has("lens-toggle")).toBe(true);
		expect(commands.has("lens-widget-toggle")).toBe(true);
		expect(commands.has("lens-enable")).toBe(false);
		expect(commands.has("lens-disable")).toBe(false);
		expect(commands.has("lens-status")).toBe(false);
		expect(commands.has("lens")).toBe(false);
	});

	it("toggles an enabled session off and back on", async () => {
		const { commands } = installLens();
		const notify = vi.fn();
		const command = commands.get("lens-toggle");

		expect(command).toBeDefined();
		await command?.handler([], { ui: { notify } });
		await command?.handler([], { ui: { notify } });

		expect(notify).toHaveBeenNthCalledWith(
			1,
			"pi-lens disabled for this session. Run /lens-toggle again to resume.",
			"warning",
		);
		expect(notify).toHaveBeenNthCalledWith(
			2,
			"pi-lens enabled for this session.",
			"info",
		);
	});

	it("re-enables a session started with --no-lens", async () => {
		const { commands } = installLens({ "no-lens": true });
		const notify = vi.fn();
		const command = commands.get("lens-toggle");

		await command?.handler([], { ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			"pi-lens enabled for this session.",
			"info",
		);
	});

	it("toggles the diagnostics widget off and on", async () => {
		const { commands } = installLens();
		const notify = vi.fn();
		const setWidget = vi.fn();
		const command = commands.get("lens-widget-toggle");

		expect(command).toBeDefined();
		await command?.handler([], { ui: { notify, setWidget } });
		await command?.handler([], { ui: { notify, setWidget } });

		expect(setWidget).toHaveBeenNthCalledWith(1, "pi-lens", undefined);
		expect(setWidget).toHaveBeenNthCalledWith(
			2,
			"pi-lens",
			expect.any(Function),
			{ placement: "belowEditor" },
		);
		expect(notify).toHaveBeenNthCalledWith(
			1,
			"pi-lens widget hidden. Run /lens-widget-toggle to show it.",
			"info",
		);
		expect(notify).toHaveBeenNthCalledWith(
			2,
			"pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			"info",
		);
	});

	it("starts the diagnostics widget hidden from global config", async () => {
		const configPath = process.env.PI_LENS_CONFIG_PATH;
		expect(configPath).toBeDefined();
		fs.writeFileSync(
			configPath as string,
			JSON.stringify({ widget: { visible: false } }),
			"utf-8",
		);
		const { commands } = installLens();
		const notify = vi.fn();
		const setWidget = vi.fn();
		const command = commands.get("lens-widget-toggle");

		await command?.handler([], { ui: { notify, setWidget } });

		expect(setWidget).toHaveBeenCalledWith("pi-lens", expect.any(Function), {
			placement: "belowEditor",
		});
		expect(notify).toHaveBeenCalledWith(
			"pi-lens widget shown. Run /lens-widget-toggle to hide it.",
			"info",
		);
	});
});
