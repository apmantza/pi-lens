import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as piCodingAgent from "@mariozechner/pi-coding-agent";

const DEBUG_LOG_DIR = path.join(os.homedir(), ".pi-lens");
const DEBUG_LOG = path.join(DEBUG_LOG_DIR, "sessionstart.log");

export function dbg(msg: string): void {
	// Skip file logging during tests to isolate test output from production logs
	if (process.env.PI_LENS_TEST_MODE === "1" || process.env.VITEST) {
		return;
	}
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		nodeFs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
		nodeFs.appendFileSync(DEBUG_LOG, line);
	} catch (e) {
		// Pipeline error logged
		console.error("[pi-lens-debug] write failed:", e);
	}
}

// No-op log function (verbose console logging was removed with lens-verbose flag)
export function log(_msg: string): void {
	// Previously tied to --lens-verbose flag, now disabled
}

export function normalizeCommandArgs(args: unknown): string[] {
	if (Array.isArray(args)) {
		return args.filter((arg): arg is string => typeof arg === "string");
	}
	if (typeof args === "string") {
		return args.trim().split(/\s+/).filter(Boolean);
	}
	return [];
}

export function getToolCallRawFilePath(
	toolName: string,
	event: { input?: unknown },
): string | undefined {
	const inputObj = (event.input ?? {}) as Record<string, unknown>;

	if (
		piCodingAgent.isToolCallEventType("write", event as any) ||
		piCodingAgent.isToolCallEventType("edit", event as any)
	) {
		const filePath = (event.input as { path?: unknown }).path;
		return typeof filePath === "string" ? filePath : undefined;
	}

	if (toolName === "read") {
		if (typeof inputObj.path === "string") return inputObj.path;
		if (typeof inputObj.filePath === "string") return inputObj.filePath;
		return undefined;
	}

	if (toolName === "lsp_navigation") {
		return typeof inputObj.filePath === "string"
			? inputObj.filePath
			: undefined;
	}

	return undefined;
}

export function resolveToolCallFilePath(
	rawFilePath: string | undefined,
	cwd: string | undefined,
	projectRoot: string,
): string | undefined {
	if (!rawFilePath) return undefined;
	if (path.isAbsolute(rawFilePath)) return rawFilePath;
	return path.resolve(cwd ?? projectRoot, rawFilePath);
}

export function getNewContentFromToolCall(event: unknown): string | undefined {
	if (piCodingAgent.isToolCallEventType("write", event as any)) {
		return ((event as { input?: unknown }).input as { content?: string })
			.content;
	}
	if (piCodingAgent.isToolCallEventType("edit", event as any)) {
		const edits = (
			(event as { input?: unknown }).input as {
				edits?: Array<{ newText?: string }>;
			}
		).edits;
		return edits?.map((edit) => edit.newText ?? "").join("\n");
	}
	return undefined;
}

export function cleanStaleTsBuildInfo(cwd: string): string[] {
	const cleaned: string[] = [];
	try {
		// Find all tsbuildinfo files in the project (max depth 3 to avoid crawling)
		const candidates = nodeFs
			.readdirSync(cwd)
			.filter((f) => f.endsWith(".tsbuildinfo"))
			.map((f) => path.join(cwd, f));

		for (const infoPath of candidates) {
			try {
				const data = JSON.parse(nodeFs.readFileSync(infoPath, "utf-8"));
				const root: string[] = data.root ?? [];
				const dir = path.dirname(infoPath);
				const isStale = root.some(
					(f) => !nodeFs.existsSync(path.resolve(dir, f)),
				);
				if (isStale) {
					nodeFs.unlinkSync(infoPath);
					cleaned.push(infoPath);
				}
			} catch {
				// Malformed or unreadable - skip
			}
		}
	} catch {
		// readdirSync failed - skip
	}
	return cleaned;
}

export async function fileExists(path: nodeFs.PathLike): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
	}
	return false;
}
