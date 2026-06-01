import * as fs from "node:fs";
import * as path from "node:path";

export type FrameworkConfidence = "high" | "medium" | "low";

export interface FrameworkDetection {
	id: string;
	confidence: FrameworkConfidence;
	signals: string[];
}

export interface AgentDocSummary {
	filePath: string;
	lineCount: number;
}

export interface ProjectConventions {
	frameworks: FrameworkDetection[];
	testRunners: string[];
	buildTools: string[];
	agentDocs: AgentDocSummary[];
}

interface PackageJsonShape {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
}

function readPackageJson(cwd: string): PackageJsonShape | undefined {
	const pkgPath = path.join(cwd, "package.json");
	try {
		const raw = fs.readFileSync(pkgPath, "utf-8");
		return JSON.parse(raw) as PackageJsonShape;
	} catch {
		return undefined;
	}
}

function hasDep(pkg: PackageJsonShape | undefined, name: string): boolean {
	if (!pkg) return false;
	return Boolean(
		pkg.dependencies?.[name] ??
			pkg.devDependencies?.[name] ??
			pkg.peerDependencies?.[name],
	);
}

function fileExists(cwd: string, ...segments: string[]): boolean {
	try {
		return fs.existsSync(path.join(cwd, ...segments));
	} catch {
		return false;
	}
}

function dirExists(cwd: string, ...segments: string[]): boolean {
	try {
		const target = path.join(cwd, ...segments);
		const stat = fs.statSync(target);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

function detectReact(
	_cwd: string,
	pkg: PackageJsonShape | undefined,
): FrameworkDetection | undefined {
	const signals: string[] = [];
	if (hasDep(pkg, "react")) signals.push("package.json:dependencies.react");
	if (hasDep(pkg, "react-dom"))
		signals.push("package.json:dependencies.react-dom");
	if (hasDep(pkg, "@types/react"))
		signals.push("package.json:devDependencies.@types/react");
	if (signals.length === 0) return undefined;
	const confidence: FrameworkConfidence = hasDep(pkg, "react-dom")
		? "high"
		: "medium";
	return { id: "react", confidence, signals };
}

function detectNext(
	cwd: string,
	pkg: PackageJsonShape | undefined,
): FrameworkDetection | undefined {
	const signals: string[] = [];
	if (hasDep(pkg, "next")) signals.push("package.json:dependencies.next");
	for (const candidate of [
		"next.config.js",
		"next.config.mjs",
		"next.config.ts",
	]) {
		if (fileExists(cwd, candidate)) signals.push(candidate);
	}
	if (dirExists(cwd, "src", "pages")) signals.push("src/pages/");
	else if (dirExists(cwd, "pages")) signals.push("pages/");
	if (dirExists(cwd, "src", "app")) signals.push("src/app/");
	else if (dirExists(cwd, "app")) signals.push("app/");
	if (signals.length === 0) return undefined;
	const confidence: FrameworkConfidence =
		hasDep(pkg, "next") &&
		signals.some((s) => s.startsWith("next.config."))
			? "high"
			: hasDep(pkg, "next")
				? "medium"
				: "low";
	return { id: "next", confidence, signals };
}

function detectVite(
	cwd: string,
	pkg: PackageJsonShape | undefined,
): FrameworkDetection | undefined {
	const signals: string[] = [];
	if (hasDep(pkg, "vite")) signals.push("package.json:devDependencies.vite");
	for (const candidate of [
		"vite.config.ts",
		"vite.config.js",
		"vite.config.mjs",
		"vite.config.mts",
	]) {
		if (fileExists(cwd, candidate)) signals.push(candidate);
	}
	if (signals.length === 0) return undefined;
	const confidence: FrameworkConfidence =
		hasDep(pkg, "vite") && signals.some((s) => s.startsWith("vite.config."))
			? "high"
			: "medium";
	return { id: "vite", confidence, signals };
}

function detectVitest(
	cwd: string,
	pkg: PackageJsonShape | undefined,
): FrameworkDetection | undefined {
	const signals: string[] = [];
	if (hasDep(pkg, "vitest"))
		signals.push("package.json:devDependencies.vitest");
	for (const candidate of [
		"vitest.config.ts",
		"vitest.config.js",
		"vitest.config.mjs",
		"vitest.config.mts",
	]) {
		if (fileExists(cwd, candidate)) signals.push(candidate);
	}
	if (signals.length === 0) return undefined;
	const confidence: FrameworkConfidence = hasDep(pkg, "vitest")
		? "high"
		: "medium";
	return { id: "vitest", confidence, signals };
}

const AGENT_DOC_CANDIDATES = [
	"AGENTS.md",
	"CLAUDE.md",
	".cursorrules",
] as const;

function summarizeAgentDocs(cwd: string): AgentDocSummary[] {
	const docs: AgentDocSummary[] = [];
	for (const candidate of AGENT_DOC_CANDIDATES) {
		const abs = path.join(cwd, candidate);
		try {
			const raw = fs.readFileSync(abs, "utf-8");
			const lineCount = raw.split(/\r?\n/).length;
			docs.push({ filePath: candidate, lineCount });
		} catch {
			// candidate not present
		}
	}
	return docs;
}

export function detectProjectConventions(cwd: string): ProjectConventions {
	let cwdExists = false;
	try {
		cwdExists = fs.statSync(cwd).isDirectory();
	} catch {
		cwdExists = false;
	}
	if (!cwdExists) {
		return { frameworks: [], testRunners: [], buildTools: [], agentDocs: [] };
	}

	const pkg = readPackageJson(cwd);
	const detectors: Array<(
		cwd: string,
		pkg: PackageJsonShape | undefined,
	) => FrameworkDetection | undefined> = [
		detectReact,
		detectNext,
		detectVite,
		detectVitest,
	];
	const frameworks: FrameworkDetection[] = [];
	for (const detector of detectors) {
		const detection = detector(cwd, pkg);
		if (detection) frameworks.push(detection);
	}

	const testRunners: string[] = [];
	if (frameworks.some((f) => f.id === "vitest")) testRunners.push("vitest");

	const buildTools: string[] = [];
	if (frameworks.some((f) => f.id === "vite")) buildTools.push("vite");
	if (frameworks.some((f) => f.id === "next")) buildTools.push("next");

	const agentDocs = summarizeAgentDocs(cwd);

	return { frameworks, testRunners, buildTools, agentDocs };
}
