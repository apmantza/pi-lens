#!/usr/bin/env node
/**
 * playground-chrome.mjs — dedicated headless Chrome for pi-lens's playground
 * verifier script. Adapted from GreedySearch-pi's bin/launch.mjs
 * (https://github.com/apmantza/GreedySearch-pi) with the following changes:
 *   - Port 9224 (GreedySearch uses 9222; the user's main Chrome may use 9223)
 *   - Profile dir <tmpdir>/pilens-playground-profile/ (not GreedySearch's)
 *   - No "Allow remote debugging?" dialog suppression divergence (kept
 *     --disable-features=DevToolsPrivacyUI for parity)
 *   - Simpler mode (always headless) — visible mode is not useful for a
 *     non-interactive verifier
 *
 * Usage:
 *   node scripts/playground-chrome.mjs launch     # start headless Chrome
 *   node scripts/playground-chrome.mjs kill       # stop it
 *   node scripts/playground-chrome.mjs status     # is it running?
 *
 * Env:
 *   PILENS_PLAYGROUND_CHROME  Path to chrome.exe (default: auto-detect)
 *   PILENS_PLAYGROUND_PORT    CDP port (default: 9224)
 *   PILENS_PLAYGROUND_KEEP    If set, don't clean up the profile dir on kill
 */

import { execSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PILENS_PLAYGROUND_PORT) || 9224;
const PROFILE_DIR = join(tmpdir(), "pilens-playground-profile");
const ACTIVE_PORT = join(PROFILE_DIR, "DevToolsActivePort");
const PID_FILE = join(tmpdir(), "pilens-playground.pid");
const MODE_FILE = join(tmpdir(), "pilens-playground-mode");

function findChrome() {
	const os = platform();
	const env = process.env.PILENS_PLAYGROUND_CHROME;
	const candidates =
		os === "win32"
			? [
					env,
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
				]
			: os === "darwin"
				? [
						env,
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: [
						env,
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium-browser",
						"/usr/bin/chromium",
						"/snap/bin/chromium",
					];
	return candidates.filter(Boolean).find(existsSync) || null;
}

function getChromeVersion(chromePath) {
	try {
		const appDir = join(chromePath, "..");
		const entries = readdirSync(appDir);
		const ver = entries.find((e) =>
			/^\d{1,10}\.\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(e),
		);
		if (ver) return ver.split(".")[0];
	} catch {}
	try {
		const out = execSync(`"${chromePath}" --version`, {
			encoding: "utf8",
			timeout: 5000,
		}).trim();
		const m = out.match(/(\d{1,10})\.\d{1,10}\.\d{1,10}/);
		if (m) return m[1];
	} catch {}
	return null;
}

const BASE_FLAGS = [
	`--remote-debugging-port=${PORT}`,
	"--disable-features=DevToolsPrivacyUI",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-default-apps",
	"--disable-blink-features=AutomationControlled",
	`--user-data-dir=${PROFILE_DIR}`,
	"--profile-directory=Default",
	"--window-size=1920,1080",
	"--lang=en-US",
	"--force-color-profile=srgb",
	"--disable-background-timer-throttling",
	"--disable-renderer-backgrounding",
	"--disable-backgrounding-occluded-windows",
];

function buildFlags(chromePath) {
	const flags = [...BASE_FLAGS, "--headless=new"];
	const major = getChromeVersion(chromePath) || "136";
	flags.push(
		`--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
	);
	flags.push("about:blank");
	return flags;
}

function getPortPid(port) {
	try {
		if (platform() === "win32") {
			const out = execSync("netstat -ano -p TCP 2>nul", { encoding: "utf8" });
			const re = new RegExp(
				String.raw`TCP\s+\S+:${port}\s+\S+:0\s+LISTENING\s+(\d+)`,
				"i",
			);
			return (out.match(re) || [])[1] ? parseInt(out.match(re)[1], 10) : null;
		}
		const out = execSync(
			`lsof -i :${port} -t 2>/dev/null || ss -tlnp 2>/dev/null | grep :${port} | grep -oP 'pid=\\K\\d+'`,
			{ encoding: "utf8" },
		).trim();
		return out ? parseInt(out.split("\n")[0], 10) : null;
	} catch {
		return null;
	}
}

function killProcessTree(pid) {
	if (!pid) return;
	try {
		if (platform() === "win32") {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
		} else {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {}
}

async function httpGet(url, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ ok: true, body, status: res.statusCode }));
		});
		req.on("error", () => resolve({ ok: false }));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve({ ok: false });
		});
	});
}

async function writePortFile(timeoutMs = 15_000) {
	// Chrome writes DevToolsActivePort only in VISIBLE mode; headless=new
	// omits the file. So we always poll /json/version, parse the
	// webSocketDebuggerUrl, and write the port file ourselves.
	// webSocketDebuggerPath is `undefined` in some Chrome versions
	// (only webSocketDebuggerUrl is populated) — derive the path.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await httpGet(`http://localhost:${PORT}/json/version`, 1000);
		if (v.ok) {
			const json = JSON.parse(v.body);
			let wsPath = json.webSocketDebuggerPath;
			if (!wsPath && json.webSocketDebuggerUrl) {
				// extract "/devtools/browser/<id>" from "ws://host:port/devtools/browser/<id>"
				const m = json.webSocketDebuggerUrl.match(/ws:\/\/[^/]+(\/.*)$/);
				if (m) wsPath = m[1];
				else wsPath = "/devtools/browser";
			}
			if (!wsPath) wsPath = "/devtools/browser";
			writeFileSync(ACTIVE_PORT, `${PORT}\n${wsPath}`, "utf-8");
			return;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(
		`Chrome did not respond on port ${PORT} within ${timeoutMs}ms`,
	);
}

function readPortFile() {
	if (!existsSync(ACTIVE_PORT)) return null;
	return readFileSync(ACTIVE_PORT, "utf-8").trim().split("\n");
}

async function launch() {
	if (readPortFile()) {
		console.log(`# already running on port ${PORT} (${ACTIVE_PORT})`);
		return;
	}
	const chromePath = findChrome();
	if (!chromePath) {
		console.error(
			`# chrome not found. Set PILENS_PLAYGROUND_CHROME or install Chrome.`,
		);
		process.exit(2);
	}
	console.error(`# launching ${chromePath} on port ${PORT}...`);
	mkdirSync(PROFILE_DIR, { recursive: true });
	const flags = buildFlags(chromePath);
	const proc = spawn(chromePath, flags, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.unref();
	console.error(`# chrome spawned (pid ${proc.pid || "?"})`);
	try {
		writeFileSync(PID_FILE, String(proc.pid || ""), "utf-8");
		writeFileSync(MODE_FILE, "headless", "utf-8");
	} catch (e) {
		console.error(`# warning: could not write pid/mode files: ${e.message}`);
	}
	console.error(`# waiting for /json/version on port ${PORT}...`);
	try {
		await writePortFile();
	} catch (e) {
		console.error(`# error: ${e.message}`);
		throw e;
	}
	console.log(
		`# launched (pid ${proc.pid || "?"}, port ${PORT}, profile ${PROFILE_DIR})`,
	);
}

async function kill() {
	const lines = readPortFile();
	if (!lines) {
		console.log("# not running");
		return;
	}
	const pid = getPortPid(PORT);
	if (pid) killProcessTree(pid);
	try {
		unlinkSync(ACTIVE_PORT);
	} catch {}
	try {
		unlinkSync(PID_FILE);
	} catch {}
	try {
		unlinkSync(MODE_FILE);
	} catch {}
	if (!process.env.PILENS_PLAYGROUND_KEEP) {
		try {
			execSync(`rm -rf "${PROFILE_DIR}"`, { stdio: "ignore" });
		} catch {}
	}
	console.log(`# killed (was pid ${pid || "?"})`);
}

function status() {
	const lines = readPortFile();
	if (!lines) {
		console.log("not running");
		process.exit(1);
	}
	const pid = getPortPid(PORT);
	console.log(
		`running — pid ${pid || "?"}, port ${PORT}, profile ${PROFILE_DIR}`,
	);
}

const [cmd] = process.argv.slice(2);
const handlers = { launch, kill, status };
const handler = handlers[cmd];
if (!handler) {
	console.error(
		`Usage: playground-chrome.mjs <${Object.keys(handlers).join("|")}>`,
	);
	process.exit(2);
}
try {
	const result = handler();
	if (result && typeof result.catch === "function") {
		result.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
	}
} catch (e) {
	console.error(e.message);
	process.exit(1);
}
