// flake-shape: real-process-spawn — the regression must run the real installer against executable fake package-manager boundaries.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { pipScriptsDir } from "../../../clients/installer/index.js";

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];

function scratchDir(): string {
	const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pip-pep668-"));
	scratchDirs.push(dir);
	return dir;
}

function writeExecutable(file: string, source: string): void {
	fs.writeFileSync(file, source, { mode: 0o750 });
}

function writeFakePip(
	binDir: string,
	mode: "pep668" | "private" | "genuine",
): string {
	const log = path.join(path.dirname(binDir), "pip.log");
	const behavior =
		mode === "pep668"
			? 'echo "error: externally-managed-environment" >&2; exit 1'
			: mode === "genuine"
				? 'echo "No matching distribution found" >&2; exit 1'
				: [
						'case " $* " in *" --break-system-packages "*)',
						'mkdir -p "$PYTHONUSERBASE/bin"',
						'printf "#!/bin/sh\\necho ruff 1.0\\n" > "$PYTHONUSERBASE/bin/ruff"',
						'chmod 750 "$PYTHONUSERBASE/bin/ruff"',
						"exit 0;;",
						'*) echo "error: externally-managed-environment" >&2; exit 1;; esac',
					].join("\n");
	writeExecutable(
		path.join(binDir, "pip3"),
		`#!/bin/sh\necho "$*" >> "$FAKE_PIP_LOG"\n${behavior}\n`,
	);
	return log;
}

function writeFakePythonWithVenv(binDir: string): void {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  root="$3"
  mkdir -p "$root/bin"
  printf '#!/bin/sh\necho venv-pip\n' > "$root/bin/pip"
  chmod 750 "$root/bin/pip"
  printf '#!/bin/sh\necho ruff 2.0\n' > "$root/bin/ruff"
  chmod 750 "$root/bin/ruff"
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "site" ]; then
  echo "$FAKE_USER_BASE"
  exit 0
fi
exit 1
`,
	);
}

function writeFakePythonWithoutVenv(binDir: string): void {
	writeExecutable(
		path.join(binDir, "python3"),
		'#!/bin/sh\necho "No module named venv" >&2\nexit 1\n',
	);
}

async function runInstaller(
	home: string,
	binDir: string,
	tool = "ruff",
	extraEnv: NodeJS.ProcessEnv = {},
	repeat = false,
) {
	const program = `import(${JSON.stringify(path.resolve("clients/installer/index.js"))}).then(async m => {
  const installed = await m.installTool(${JSON.stringify(tool)});
  ${repeat ? `await m.installTool(${JSON.stringify(tool)});` : ""}
  const resolved = await m.getToolPath(${JSON.stringify(tool)});
  const summary = (await import(${JSON.stringify(path.resolve("clients/degradation-ledger.js"))})).getDegradationSummary();
  console.log(JSON.stringify({ installed, resolved, path: process.env.PATH, reason: m.getInstallFailureReason(${JSON.stringify(tool)}), summary }));
}).catch(error => { console.error(error); process.exitCode = 1; });`;
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		["-e", program],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_LENS_HOME: home,
				PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
				PI_LENS_DISABLE_TOOL_INSTALL: "0",
				PI_LENS_DEBUG: "1",
				...extraEnv,
			},
		},
	);
	return { result: JSON.parse(stdout.trim()), stderr };
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("real pip installer PEP 668 strategy selection (#2916)", () => {
	it("uses pipx before other pip strategies", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		const pipxBin = path.join(root, "pipx-bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(pipxBin, { recursive: true });
		writeExecutable(
			path.join(bin, "pipx"),
			`#!/bin/sh
if [ "$1" = "install" ]; then
  mkdir -p "$FAKE_PIPX_BIN"
  printf '#!/bin/sh\\necho ruff 3.0\\n' > "$FAKE_PIPX_BIN/ruff"
  chmod 750 "$FAKE_PIPX_BIN/ruff"
elif [ "$1" = "environment" ]; then
  echo "$FAKE_PIPX_BIN"
fi
`,
		);
		const program = await runInstaller(root, bin, "ruff", {
			FAKE_PIPX_BIN: pipxBin,
		});
		expect(program.result.installed).toBe(true);
		expect(program.result.path).toContain("pipx-bin");
	});

	it("creates and resolves the pi-lens venv", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithVenv(bin);
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: log,
			FAKE_USER_BASE: path.join(root, "user-base"),
		});
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("pip-tools", "bin"));
		expect(fs.existsSync(path.join(root, "pip-tools", "bin", "pip"))).toBe(
			true,
		);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("does not treat a PEP 668 refusal as a normal user success", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithoutVenv(bin);
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(false);
		expect(result.result.reason).toContain("externally-managed-environment");
	});

	it("uses break-system-packages only with PYTHONUSERBASE under PI_LENS_HOME", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "private");
		writeFakePythonWithoutVenv(bin);
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("pip-user", "bin"));
		const attempts = fs.readFileSync(log, "utf8").trim().split("\n");
		expect(attempts[0]).not.toContain("--break-system-packages");
		expect(
			attempts.some((attempt) => attempt.includes("--break-system-packages")),
		).toBe(true);
	});

	it("classifies externally-managed-environment refusals", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithoutVenv(bin);
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.reason).toMatch(/externally-managed-environment/);
	});

	it("resolves Windows Scripts binaries", () => {
		expect(pipScriptsDir("C:\\Users\\user\\AppData\\Python", "win32")).toBe(
			path.join("C:\\Users\\user\\AppData\\Python", "Scripts"),
		);
	});

	it("records one refusal per tool and strategy", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithoutVenv(bin);
		const result = await runInstaller(
			root,
			bin,
			"ruff",
			{ FAKE_PIP_LOG: log },
			true,
		);
		const row = result.result.summary.find(
			(entry: { kind: string }) => entry.kind === "pip-pep668-strategy-refused",
		);
		expect(row?.count).toBe(2);
	});

	it("preserves genuine nonexistent-package failures", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "genuine");
		writeFakePythonWithoutVenv(bin);
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(false);
		expect(result.result.reason).toContain("No matching distribution");
		expect(fs.readFileSync(log, "utf8")).not.toContain(
			"--break-system-packages",
		);
	});
});
