import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE_COMPLETENESS_TIMEOUT_MS = 120_000;

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function getPinnedNpmVersion(cwd = process.cwd()) {
	const value = readJson(join(cwd, "package.json")).packageManager;
	const match =
		typeof value === "string" && value.match(/^npm@(\d+\.\d+\.\d+)$/);
	if (!match) {
		throw new Error(
			`package.json packageManager must be an exact npm pin (npm@x.y.z); got ${String(value)}`,
		);
	}
	return match[1];
}

function nodeModulesKeys(file) {
	const packages = readJson(file).packages ?? {};
	return new Set(
		Object.keys(packages).filter((key) => key.startsWith("node_modules/")),
	);
}

function firstKeyChange(before, after) {
	const added = [...after].filter((key) => !before.has(key)).sort();
	if (added.length > 0) return `added ${added[0]}`;
	const removed = [...before].filter((key) => !after.has(key)).sort();
	if (removed.length > 0) return `removed ${removed[0]}`;
	return "no added/removed node_modules/ key";
}

export function runLockfileCompleteness({
	cwd = process.cwd(),
	spawn = spawnSync,
	timeoutMs = LOCKFILE_COMPLETENESS_TIMEOUT_MS,
	env = process.env,
} = {}) {
	const root = resolve(cwd);
	const originalLockfile = join(root, "package-lock.json");
	if (!existsSync(originalLockfile))
		throw new Error("package-lock.json is missing");
	const pin = getPinnedNpmVersion(root);
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-lens-lockfile-complete-"));
	const copy = join(tempRoot, "tree");
	try {
		const packageJson = readJson(join(root, "package.json"));
		mkdirSync(copy, { recursive: true });
		copyFileSync(join(root, "package.json"), join(copy, "package.json"));
		copyFileSync(originalLockfile, join(copy, "package-lock.json"));
		const workspaces = Array.isArray(packageJson.workspaces)
			? packageJson.workspaces
			: packageJson.workspaces?.packages;
		for (const workspace of workspaces ?? []) {
			for (const manifest of globSync(`${workspace}/package.json`, {
				cwd: root,
				nodir: true,
			})) {
				const target = join(copy, manifest);
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(join(root, manifest), target);
			}
		}
		const copiedLockfile = join(copy, "package-lock.json");
		const before = readFileSync(copiedLockfile);
		const result = spawn(
			process.platform === "win32" ? "npx.cmd" : "npx",
			[
				"-y",
				`npm@${pin}`,
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			],
			{
				cwd: copy,
				env: {
					...env,
					npm_config_cache:
						env.npm_config_cache ?? join(root, ".probe-home", "npm-cache"),
				},
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs,
			},
		);
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		if (result.error || result.status !== 0) {
			const unavailable =
				result.error?.code === "ETIMEDOUT" ||
				/\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EAI_AGAIN|ENOTFOUND|FetchError|ENOTCACHED)\b/i.test(
					output,
				);
			if (unavailable)
				return {
					ok: false,
					inconclusive: true,
					pin,
					reason: "npm pin unavailable",
					output,
				};
			const reason =
				result.error?.code === "ETIMEDOUT"
					? `timed out after ${timeoutMs}ms`
					: (result.error?.message ?? `exited with status ${result.status}`);
			return { ok: false, pin, reason, output };
		}
		const after = readFileSync(copiedLockfile);
		if (before.equals(after)) return { ok: true, pin };
		return {
			ok: false,
			pin,
			reason: `package-lock.json changed; first ${firstKeyChange(nodeModulesKeys(originalLockfile), nodeModulesKeys(copiedLockfile))}`,
			output,
		};
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const result = runLockfileCompleteness();
		if (!result.ok && !result.inconclusive) {
			console.error(`lockfile:complete: ${result.reason}`);
			if (result.output) console.error(result.output);
			process.exitCode = 1;
		} else if (result.inconclusive) {
			console.error("lockfile:complete: inconclusive: npm pin unavailable");
			if (result.output) console.error(result.output);
			process.exitCode = 3;
		} else {
			console.log(
				`lockfile:complete: package-lock.json is stable under npm@${result.pin} ✓`,
			);
		}
	} catch (error) {
		console.error(
			`lockfile:complete: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
