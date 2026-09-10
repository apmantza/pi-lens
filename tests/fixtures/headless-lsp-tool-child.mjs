// #2507 — a headless pi child, reduced to the parts that matter.
//
// This fixture imports the COMPILED extension entry (`../../index.js`) and the
// compiled `clients/*.js`, not the `.ts` sources: the defect is a property of
// the RUNTIME event loop, so it can only be observed against the artifact pi
// actually loads. Run `npm run build` first.
//
// It reproduces the reporter's environment exactly where it matters: no TUI,
// no other extension, stdin `ignore` (the parent spawns it that way), and
// nothing on the event loop except what pi-lens itself puts there. The host is
// a stub with only the surface `index.ts` touches — the real pi API is not
// installable here, and the point of the fixture is what happens BETWEEN
// `registerTool` and the tool's promise settling, which any faithful host
// drives identically.
//
// The tool is taken from the map `pi.registerTool` was called with, so the
// call goes through the real registration boundary
// (`clients/tool-definition.ts#normalizeToolDefinition`) exactly as a host
// call does — not through a tool object assembled by this fixture.
//
// Deliberately does NOT call `process.exit()`: the second half of the contract
// is that the process still exits BY ITSELF once the call is done (the reason
// the LSP handles are unref'd at all), so the exit has to be the event loop's
// own decision.
import * as path from "node:path";

const root = process.cwd();
const tools = new Map();
const pi = {
	registerFlag() {},
	registerCommand() {},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	on() {},
	getFlag() {
		return undefined;
	},
	registerMessageRenderer() {},
	registerEntryRenderer() {},
	sendMessage() {},
	appendEntry() {},
	getActiveTools() {
		return [...tools.keys()];
	},
	setActiveTools() {},
};

const extension = (await import(new URL("../../index.js", import.meta.url)))
	.default;
await extension(pi);
process.stdout.write(`activated:${tools.size}\n`);

const { initLSPConfig } = await import(
	new URL("../../clients/lsp/config.js", import.meta.url)
);
await initLSPConfig(root);

const tool = tools.get("lens_diagnostics");
if (!tool) {
	process.stdout.write("no-tool:lens_diagnostics\n");
	process.exit(2);
}

// Driven from inside a function, not as a top-level await: an unsettled
// top-level await makes Node exit 13 with a warning, and the reported defect
// is a SILENT exit 0 — the fixture must not substitute its own exit code for
// the one the issue is about.
async function run() {
	process.stdout.write("tool-start\n");
	const result = await tool.execute(
		"headless-keepalive-probe",
		{ source: "lsp", scope: "paths", paths: [path.join(root, "mod.py")], severity: "all", serverScope: "all" },
		new AbortController().signal,
		null,
		{ cwd: root },
	);
	process.stdout.write(
		`tool-resolved:${result?.details?.filesChecked ?? "unknown"}\n`,
	);
}

void run();
