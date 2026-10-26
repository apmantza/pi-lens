#!/usr/bin/env node
// Stand-in build server for tests/fixtures/tool-smoke/swift-xcode (#4880).
//
// `buildServer.json` is the BSP connection file `xcode-build-server` writes at
// an Xcode project root, and it is the marker `SwiftServer.root` resolves on
// when the project has no `Package.swift` (#4854, fixed by #4857). A real Xcode
// host runs `xcode-build-server`, which serves the compiler arguments
// xcodebuild logged for each source file. This fixture has no Xcode, so this
// script answers the same BSP requests from the fixture's own sources: the
// module's files type-check together, and `Greeting` in Greeting.swift resolves
// from ContentView.swift.
//
// The message shapes are the ones a working client/server pair actually sends:
// `xcode-build-server` server.py at
// https://github.com/SolaWing/xcode-build-server/blob/2adba72/server.py
// (`build_initialize`, `workspace_buildTargets`, `buildTarget_sources`,
// `textDocument_sourceKitOptions`), plus sourcekit-lsp's own BSP test server,
// Sources/SKTestSupport/INPUTS/AbstractBuildServer.py and
// Tests/BuildServerIntegrationTests/ExternalBuildServerTests.swift at
// https://github.com/swiftlang/sourcekit-lsp/tree/6f60525.
//
// Residual: the compiler-argument LIST is the batch `-typecheck` invocation a
// SwiftPM build server hands sourcekitd (every module file, no `-primary-file`),
// not xcodebuild's per-file `-c -primary-file` command line. Nothing on the CI
// runner can confirm sourcekit-lsp accepts it, because sourcekit-lsp has no
// installer-registry entry and is absent from the nightly image (#241); the
// fixture's own test pins the protocol and the arguments instead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The workspace root the request named, set by `build/initialize`. */
let root = "";

const send = (message) => {
	const json = JSON.stringify(message);
	process.stdout.write(
		`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
	);
};

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

const replyError = (id, message) =>
	send({ jsonrpc: "2.0", id, error: { code: -32601, message } });

const toPath = (uri) => {
	const parsed = new URL(uri);
	return path.resolve(decodeURIComponent(parsed.pathname));
};

const toUri = (file) => `file://${file.split(path.sep).join("/")}`;

const swiftSources = (dir) => {
	const found = [];
	const walk = (current) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".swift")) found.push(full);
		}
	};
	walk(dir);
	return found;
};

// xcodebuild's Swift compile command carries the SDK on macOS, and the
// fallback build settings sourcekit-lsp synthesizes add the same flag; without
// it a type-check on a Darwin host cannot find the standard library. Linux
// toolchains place their stdlib already, so the flag is Darwin-only.
const sdkArguments = () => {
	if (process.platform !== "darwin") return [];
	try {
		const sdk = execFileSync(
			"xcrun",
			["--show-sdk-path", "--sdk", "macosx"],
			{ encoding: "utf8", timeout: 10_000 },
		).trim();
		return sdk ? ["-sdk", sdk] : [];
	} catch {
		return [];
	}
};

const buildTarget = {
	uri: "bsp://swift-xcode",
	displayName: "App",
	tags: [],
	capabilities: {},
	languageIds: ["swift"],
	dependencies: [],
};

const initialize = (params) => {
	root = toPath(params.rootUri);
	return {
		displayName: "swift-xcode fixture build server",
		version: "1",
		bspVersion: "2.0",
		rootUri: params.rootUri,
		capabilities: { languageIds: ["swift"] },
		data: {
			// Pull-based settings: sourcekit-lsp asks `textDocument/sourceKitOptions`
			// per file instead of waiting for a pushed notification.
			sourceKitOptionsProvider: true,
		},
		dataKind: "sourceKit",
	};
};

const sourceKitOptions = (uri) => {
	const requested = toPath(uri);
	if (!root || !requested.startsWith(`${root}${path.sep}`)) return null;
	const others = swiftSources(path.join(root, "Sources")).filter(
		(source) => source !== requested,
	);
	return {
		compilerArguments: [
			"-module-name",
			"App",
			"-typecheck",
			requested,
			...others,
			...sdkArguments(),
		],
		workingDirectory: root,
	};
};

const handle = (message) => {
	const { id, method, params } = message;
	switch (method) {
		case "build/initialize":
			return reply(id, initialize(params ?? {}));
		case "build/initialized":
			return;
		case "workspace/buildTargets":
			return reply(id, { targets: [buildTarget] });
		case "buildTarget/sources":
			return reply(id, {
				items: (params?.targets ?? [buildTarget]).map((target) => ({
					target,
					// One directory source covers the whole module (xcode-build-server
					// answers the same way, kind 2 = directory).
					sources: [{ uri: toUri(root), kind: 2, generated: false }],
				})),
			});
		case "buildTarget/prepare":
		case "workspace/waitForBuildSystemUpdates":
			return reply(id, {});
		case "textDocument/registerForChanges":
			return reply(id, null);
		case "textDocument/sourceKitOptions":
			return reply(id, sourceKitOptions(params?.textDocument?.uri ?? ""));
		case "build/shutdown":
			return reply(id, null);
		case "build/exit":
			// Flush before exiting: a piped stdout write is asynchronous, and sourcekit-lsp
			// (or a test driving the frames in one batch) would lose the last responses.
			return process.stdout.write("", () => process.exit(0));
		case "buildTarget/didChange":
		case "$/cancelRequest":
			return;
		default:
			if (id !== undefined) replyError(id, `Method not found: ${method}`);
	}
};

let buffer = Buffer.alloc(0);
const pump = () => {
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("ascii");
		const length = /content-length:\s*(\d+)/i.exec(header);
		const start = headerEnd + 4;
		if (!length) {
			buffer = buffer.subarray(start);
			continue;
		}
		const size = Number(length[1]);
		if (buffer.length < start + size) return;
		const body = buffer.subarray(start, start + size).toString("utf8");
		buffer = buffer.subarray(start + size);
		try {
			handle(JSON.parse(body));
		} catch {
			// A client that stops mid-frame is a client that went away; the next
			// stdin data event re-synchronizes, and EOF ends the process below.
		}
	}
};

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	pump();
});
// Parent-death backstop, like tests/fixtures/fake-lsp-server.mjs: sourcekit-lsp
// closes this process's stdin when it shuts the build server down.
process.stdin.on("end", () => process.exit(0));
