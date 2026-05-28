import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";

export interface PiLensSemgrepConfig {
	enabled?: boolean;
	/** Semgrep config: local path, auto, p/<pack>, r/<rule>, or omitted for local auto-discovery. */
	config?: string;
}

export interface ResolvedSemgrepConfig {
	enabled: boolean;
	/** Value to pass after --config. */
	configArg?: string;
	source: "local" | "pi-lens" | "flag" | "disabled";
	reason?: string;
}

export const LOCAL_SEMGREP_CONFIG_NAMES = [
	".semgrep.yml",
	".semgrep.yaml",
	"semgrep.yml",
	"semgrep.yaml",
] as const;

function walkUp(startDir: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(startDir || process.cwd());
	while (true) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

export function findLocalSemgrepConfig(startDir: string): string | undefined {
	for (const dir of walkUp(startDir)) {
		for (const name of LOCAL_SEMGREP_CONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function findPiLensSemgrepConfigPath(
	startDir: string,
): string | undefined {
	// Check the configured data dir for the project first (respects PILENS_DATA_DIR)
	const dataCandidate = path.join(getProjectDataDir(startDir), "semgrep.json");
	if (fs.existsSync(dataCandidate)) return dataCandidate;
	// Fall back to legacy walk-up search for backwards compatibility
	for (const dir of walkUp(startDir)) {
		const candidate = path.join(dir, ".pi-lens", "semgrep.json");
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function getPiLensSemgrepConfigPath(cwd: string): string {
	return path.join(getProjectDataDir(path.resolve(cwd || process.cwd())), "semgrep.json");
}

export function loadPiLensSemgrepConfig(
	startDir: string,
): PiLensSemgrepConfig | undefined {
	const configPath = findPiLensSemgrepConfigPath(startDir);
	if (!configPath) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const raw = parsed as Record<string, unknown>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			config: typeof raw.config === "string" ? raw.config : undefined,
		};
	} catch {
		return undefined;
	}
}

export function savePiLensSemgrepConfig(
	cwd: string,
	config: PiLensSemgrepConfig,
): string {
	const configPath = getPiLensSemgrepConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		`${configPath}.tmp`,
		`${JSON.stringify(config, null, "\t")}\n`,
	);
	fs.renameSync(`${configPath}.tmp`, configPath);
	return configPath;
}

export function removePiLensSemgrepConfig(cwd: string): boolean {
	const configPath = getPiLensSemgrepConfigPath(cwd);
	if (!fs.existsSync(configPath)) return false;
	fs.unlinkSync(configPath);
	return true;
}

function isRegistryOrAutoConfig(config: string): boolean {
	return (
		config === "auto" || config.startsWith("p/") || config.startsWith("r/")
	);
}

export function normalizeSemgrepConfigArg(
	config: string | undefined,
	cwd: string,
): string | undefined {
	if (!config) return undefined;
	const trimmed = config.trim();
	if (!trimmed) return undefined;
	if (isRegistryOrAutoConfig(trimmed)) return trimmed;
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

export function resolveSemgrepConfig(
	cwd: string,
	flags?: { enabled?: boolean; config?: string | boolean | undefined },
): ResolvedSemgrepConfig {
	const localConfig = findLocalSemgrepConfig(cwd);
	const persisted = loadPiLensSemgrepConfig(cwd);
	const flagConfig =
		typeof flags?.config === "string" && flags.config.trim()
			? flags.config.trim()
			: undefined;

	if (persisted?.enabled === false && !flags?.enabled) {
		return {
			enabled: false,
			source: "disabled",
			reason: "disabled in .pi-lens/semgrep.json",
		};
	}

	if (flags?.enabled) {
		const configArg = normalizeSemgrepConfigArg(flagConfig ?? localConfig, cwd);
		if (!configArg) {
			return {
				enabled: false,
				source: "disabled",
				reason:
					"--lens-semgrep was set but no Semgrep config was found; pass --lens-semgrep-config auto|p/<pack>|<path> or create .semgrep.yml",
			};
		}
		return {
			enabled: true,
			configArg,
			source: "flag",
		};
	}

	if (persisted?.enabled) {
		const configArg = normalizeSemgrepConfigArg(
			persisted.config ?? localConfig,
			cwd,
		);
		if (!configArg) {
			return {
				enabled: false,
				source: "disabled",
				reason:
					"Semgrep is enabled in .pi-lens/semgrep.json but no config is set or discovered",
			};
		}
		return {
			enabled: true,
			configArg,
			source: "pi-lens",
		};
	}

	if (localConfig) {
		return {
			enabled: true,
			configArg: localConfig,
			source: "local",
		};
	}

	return {
		enabled: false,
		source: "disabled",
		reason: "no local semgrep config and semgrep not explicitly enabled",
	};
}

export function createStarterSemgrepConfig(cwd: string): string {
	const configPath = path.join(
		path.resolve(cwd || process.cwd()),
		".semgrep.yml",
	);
	if (fs.existsSync(configPath)) return configPath;
	const contents = `rules:
  - id: pi-lens.no-eval
    pattern: eval(...)
    message: Avoid eval; use a safer, explicit parser or allowlisted operation.
    languages: [javascript, typescript]
    severity: ERROR
    metadata:
      pi-lens:
        semantic: blocking
        defect_class: injection
        confidence: high
        fix: Replace eval with a constrained parser or an explicit allowlist.
`;
	fs.writeFileSync(configPath, contents);
	return configPath;
}
