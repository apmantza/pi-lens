/**
 * #3290 witness (ADR 0007) — actionable-warnings disposition and delivery
 * policy through the real pi host entry.
 *
 * This keeps the host boundary in the proof: index.ts's registered
 * turn_start/tool_result/turn_end/context handlers are real, while the
 * pipeline is doubled only at its process boundary. The cache manager,
 * runtime coordinator, durable disposition store, turn-end builder, and
 * advisory renderer remain real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ runPipeline: vi.fn() }));
vi.mock("../clients/pipeline.js", () => pipeline);

import { CacheManager } from "../clients/cache-manager.js";
import { markDisposition } from "../clients/diagnostic-dispositions.js";
import type { ActionableWarningRecord } from "../clients/actionable-warnings.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	makeContextWithSystemEvent,
	makeSessionStartEvent,
} from "./support/host-event-factory.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { useGlobalConfig } from "./support/global-config.js";

const SESSION_ID = "pi-3290-actionable-warnings-witness-session";
const GOLDEN = path.join(
	import.meta.dirname,
	"fixtures/witness/actionable-warnings/turn-end-delivery.txt",
);

let tmpDir: string;

beforeEach(() => {
	pipeline.runPipeline.mockReset();
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3290-witness-")),
	);
});

afterEach(async () => {
	// #5146: end the sessions the case started before the fixture root goes.
	await endMockSessions();
	removeTempDirSync(tmpDir);
});

function warning(
	filePath: string,
	line: number,
	message: string,
): ActionableWarningRecord {
	return {
		id: `aw:${path.basename(filePath)}:${line}`,
		filePath,
		displayPath: path.relative(tmpDir, filePath).replaceAll(path.sep, "/"),
		line,
		severity: "warning",
		tool: "ast-grep",
		rule: "no-console",
		message,
		actions: [
			{
				title: "Fix warning",
				kind: "quickfix",
				hasEdit: false,
				hasCommand: false,
				autoFixEligible: false,
			},
		],
		suppressed: false,
		origin: "dispatch",
	};
}

function mark(filePath: string, line: number, message: string): void {
	markDisposition(
		tmpDir,
		{
			cwd: tmpDir,
			filePath,
			tool: "ast-grep",
			rule: "no-console",
			message,
			line,
			content: fs.readFileSync(filePath, "utf8"),
		},
		"false-positive",
	);
}

async function edit(pi: ReturnType<typeof createPiMock>, filePath: string) {
	await pi.emit(
		"tool_result",
		{
			toolName: "edit",
			input: { path: filePath },
			details: { diff: "+  1 changed();" },
			content: [{ type: "text", text: "changed" }],
		},
		makeCtx({ cwd: tmpDir }),
	);
}

function tildeProbeHome(): string {
	const probeHome = path.resolve(process.env.PI_LENS_HOME ?? "");
	const home = os.homedir();
	const rel = path.relative(home, probeHome);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return "\u0000never-matches\u0000";
	}
	return `~/${rel.replace(/\\/g, "/")}`;
}

async function endTurn(pi: ReturnType<typeof createPiMock>): Promise<string> {
	await pi.emit("turn_end", {}, makeCtx({ cwd: tmpDir }));
	const injected = (await pi.emit(
		"context_with_system",
		makeContextWithSystemEvent([{ role: "user", content: "keep working" }]),
		makeCtx({ cwd: tmpDir }),
	)) as { messages?: Array<{ role?: string; content: string }> } | undefined;
	// #4631 round 5 (F2): the transcript leads with the host's system head, so the
	// golden records the messages pi-lens APPENDED. The assertion pins that the
	// head is still at index 0: a regression that dropped it would shift this
	// golden instead of slipping through.
	expect((injected?.messages ?? [])[0]?.role).toBe("system");
	return (
		(injected?.messages ?? [])
			.slice(1)
			.map((message) => message.content)
			.join("\n\n")
			.replaceAll(tmpDir, "<PROJECT>")
			.replaceAll(path.resolve(process.env.PI_LENS_HOME ?? ""), "<PROBE_HOME>")
			// `displayProjectDataPath` folds `$HOME` to `~` when the store is not
			// under cwd. CI runs with PI_LENS_HOME under $HOME, so the report path
			// renders as `~/.../cache/actionable-warnings.json` there while a
			// probe home outside $HOME renders absolute; scrub both spellings.
			.replaceAll(tildeProbeHome(), "<PROBE_HOME>")
			.replace(
				/<PROBE_HOME>\/projects\/[^/]+\/cache\/actionable-warnings\.json/g,
				"<ACTIONABLE_REPORT>",
			)
			.trimEnd()
	);
}

const setGlobalConfig = useGlobalConfig();

describe("#3290 witness: actionable warnings through pi", () => {
	it("matches the golden across disposition and delivered-location cells", async () => {
		const partial = path.join(tmpDir, "src", "partial.ts");
		const secret = path.join(tmpDir, "src", "secret.ts");
		const empty = path.join(tmpDir, "src", "empty.ts");
		fs.mkdirSync(path.dirname(partial), { recursive: true });
		fs.writeFileSync(partial, "console.log('marked');\nconsole.log('live');\n");
		fs.writeFileSync(
			secret,
			"const token = 'AKIA...';\nconst other = 'secret';\n",
		);
		fs.writeFileSync(empty, "console.log('only');\n");

		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"gitleaks",
			{
				success: true,
				scannedAt: "",
				findings: [
					{
						ruleId: "aws-access-token",
						file: secret,
						startLine: 1,
						description: "AWS key",
					},
				],
			},
			tmpDir,
		);

		pipeline.runPipeline.mockImplementation(
			async (ctx: { filePath: string }) => {
				const filePath = path.resolve(ctx.filePath);
				if (filePath === path.resolve(partial)) {
					return {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						actionableWarnings: [
							warning(partial, 1, "marked partial warning"),
							warning(partial, 2, "live partial warning"),
							{
								...warning(partial, 2, "third partial warning"),
								id: "aw:partial-third",
							},
						],
					};
				}
				if (filePath === path.resolve(secret)) {
					return {
						output: "",
						hasBlockers: false,
						isError: false,
						fileModified: false,
						actionableWarnings: [
							{
								...warning(secret, 1, "hardcoded secret"),
								rule: "no-hardcoded-secret-js",
							},
							{
								...warning(secret, 2, "other secret"),
								rule: "no-hardcoded-secret-js",
							},
						],
					};
				}
				return {
					output: "",
					hasBlockers: false,
					isError: false,
					fileModified: false,
					actionableWarnings: [warning(empty, 1, "only marked warning")],
				};
			},
		);

		setGlobalConfig({ actionableWarnings: { enabled: true } });
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: SESSION_ID }),
		);

		await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
		await edit(pi, partial);
		mark(partial, 1, "marked partial warning");
		const partialText = await endTurn(pi);

		await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
		await edit(pi, secret);
		const secretText = await endTurn(pi);

		await pi.emit("turn_start", {}, makeCtx({ cwd: tmpDir }));
		await edit(pi, empty);
		mark(empty, 1, "only marked warning");
		const emptyText = await endTurn(pi);

		const actual = [
			"=== marked 1-of-3: rendered 2 + suppression note ===",
			partialText,
			"",
			"=== delivered location: secret row suppressed ===",
			secretText,
			"",
			"=== empty survivors: no actionable-warnings section ===",
			emptyText,
			"",
		].join("\n");

		if (process.env.PI_LENS_WITNESS_UPDATE === "1") {
			fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
			fs.writeFileSync(GOLDEN, actual);
		}
		expect(actual).toBe(fs.readFileSync(GOLDEN, "utf8"));
	});
});
