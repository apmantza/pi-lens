/**
 * Native Rust Core Client for pi-lens
 *
 * High-performance analysis via pi-lens-core binary:
 * - Fast file scanning with gitignore support
 * - State matrix similarity detection
 * - Parallel project indexing
 * - Tree-sitter query execution
 *
 * Communicates via JSON-RPC over stdin/stdout
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const _isWin = process.platform === "win32";
const _binName = _isWin ? "pi-lens-core.exe" : "pi-lens-core";

/**
 * Walk up from startDir looking for rust/target/{release,debug}/pi-lens-core.
 * Returns the first found path, or undefined. Works regardless of install depth.
 */
function findRustBinaryNearDir(startDir: string): string | undefined {
	let current = startDir;
	const fsRoot = path.parse(current).root;
	while (current !== fsRoot) {
		for (const profile of ["release", "debug"]) {
			const candidate = path.join(current, "rust", "target", profile, _binName);
			if (fs.existsSync(candidate)) return candidate;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/** Recursively collect all `.rs` files under a directory. */
async function collectRustSourceFiles(dir: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const nested = await Promise.all(
		entries.map(async (e) => {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) return collectRustSourceFiles(full);
			return e.name.endsWith(".rs") ? [full] : [];
		}),
	);
	return nested.flat();
}

// --- Types matching Rust API ---

export interface ScanRequest {
	command: "scan";
	project_root: string;
	extensions: string[];
}

export interface BuildIndexRequest {
	command: "build_index";
	project_root: string;
	files: string[];
}

export interface SimilarityRequest {
	command: "similarity";
	project_root: string;
	file_path: string;
	threshold: number;
}

export interface QueryRequest {
	command: "query";
	project_root: string;
	language: string;
	query: string;
	file_path: string;
}

export type AnalyzeRequest =
	| ScanRequest
	| BuildIndexRequest
	| SimilarityRequest
	| QueryRequest;

export interface FileEntry {
	path: string;
	size: number;
	modified: number;
}

export interface FunctionEntry {
	id: string;
	file_path: string;
	name: string;
	line: number;
	signature: string;
	matrix_hash: string;
}

export interface IndexData {
	entry_count: number;
	functions: FunctionEntry[];
}

export interface SimilarityMatch {
	source_id: string;
	target_id: string;
	similarity: number;
}

export interface QueryMatch {
	line: number;
	column: number;
	text: string;
}

export type ResponseData =
	| { files: FileEntry[] }
	| { index: IndexData }
	| { similarities: SimilarityMatch[] }
	| { query_results: QueryMatch[] }
	| { empty: null };

export interface AnalyzeResponse {
	success: boolean;
	data: ResponseData;
	error?: string;
}

// --- Client ---

export class NativeRustCoreClient {
	private binaryPath: string | null = null;
	private binaryAvailable: boolean | null = null;
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[rust-core] ${msg}`)
			: () => {};
	}

	/**
	 * Find the pi-lens-core binary
	 */
	private findBinary(): string | null {
		if (this.binaryPath) return this.binaryPath;

		// Possible locations (in order of preference):
		// 1. Walk up from this file's directory — finds rust/target in dev or mono-repo layouts
		// 2. ~/.pi-lens/bin — managed install location for shipped binaries
		// 3. Global PATH
		const managed = path.join(os.homedir(), ".pi-lens", "bin", _binName);
		const walkResult = findRustBinaryNearDir(__dirname);
		const candidates = [
			...(walkResult ? [walkResult] : []),
			managed,
			_binName,
		];

		for (const candidate of candidates) {
			try {
				if (candidate.includes("\\") || candidate.includes("/")) {
					if (fs.existsSync(candidate)) {
						this.binaryPath = candidate;
						this.log(`Found binary: ${candidate}`);
						return candidate;
					}
				} else {
					// Try to spawn from PATH
					const result = spawnSync(candidate, ["--version"], {
						timeout: 3000,
						encoding: "utf-8",
						windowsHide: true,
					});
					if (!result.error && result.status === 0) {
						this.binaryPath = candidate;
						return candidate;
					}
				}
			} catch (err) {
				void err;
			}
		}

		return null;
	}

	/**
	 * Check if native core is available
	 */
	isAvailable(): boolean {
		if (this.binaryAvailable !== null) return this.binaryAvailable;
		this.binaryAvailable = this.findBinary() !== null;
		if (this.binaryAvailable) {
			this.log(`Native Rust core available: ${this.binaryPath}`);
		} else {
			this.log("Native Rust core not found");
		}
		return this.binaryAvailable;
	}

	/**
	 * Check if the binary is up-to-date relative to the Rust source files.
	 *
	 * Returns true when:
	 * - No binary exists (needs a build)
	 * - Binary mtime is older than any `.rs` or `Cargo.toml` source file
	 *
	 * Returns false when the binary is fresh (nothing to do).
	 */
	async isBinaryStale(): Promise<boolean> {
		const rustDir = path.join(__dirname, "..", "rust");
		if (!fs.existsSync(rustDir)) return false;

		// Collect mtime of the binary (if it exists).
		const binaryPath = this.findBinary();
		let binaryMtime = 0;
		if (binaryPath) {
			try {
				binaryMtime = (await fs.promises.stat(binaryPath)).mtimeMs;
			} catch {
				return true; // Can't stat the binary — treat as stale.
			}
		} else {
			return true; // No binary at all.
		}

		// Walk rust/src/*.rs and Cargo.toml; find the newest mtime.
		const sourceFiles = await collectRustSourceFiles(path.join(rustDir, "src"));
		sourceFiles.push(path.join(rustDir, "Cargo.toml"));

		for (const src of sourceFiles) {
			try {
				const { mtimeMs } = await fs.promises.stat(src);
				if (mtimeMs > binaryMtime) {
					this.log(`Stale: ${path.basename(src)} is newer than binary`);
					return true;
				}
			} catch {
				/* file vanished between readdir and stat — ignore */
			}
		}

		return false;
	}

	/**
	 * Build the binary if in development mode
	 */
	async build(): Promise<boolean> {
		const rustDir = path.join(__dirname, "..", "rust");
		if (!fs.existsSync(rustDir)) {
			this.log("No rust directory found");
			return false;
		}

		// Check if cargo is available via our workaround
		const cargo = this.findCargo();
		if (!cargo) {
			this.log("Cargo not available for building");
			return false;
		}

		this.log("Building pi-lens-core...");

		return new Promise((resolve) => {
			const proc = spawn(cargo, ["build", "--release"], {
				cwd: rustDir,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: {
					...process.env,
					PATH: `${process.env.PATH};${path.dirname(cargo)}`,
				},
			});

			let output = "";
			proc.stdout?.on("data", (data) => {
				output += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				output += data.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					this.log("Build successful");
					this.binaryPath = null; // Reset to find the new binary
					this.binaryAvailable = null;
					resolve(true);
				} else {
					this.log(`Build failed: ${output}`);
					resolve(false);
				}
			});

			proc.on("error", (err) => {
				this.log(`Build error: ${err.message}`);
				resolve(false);
			});
		});
	}

	/**
	 * Find cargo executable (using workaround for rustup issues)
	 */
	private findCargo(): string | null {
		const candidates = [
			// Direct toolchain path (our workaround)
			path.join(
				process.env.HOME || "",
				".rustup",
				"toolchains",
				"stable-x86_64-pc-windows-gnu",
				"bin",
				"cargo.exe",
			),
			path.join(
				process.env.HOME || "",
				".rustup",
				"toolchains",
				"stable-x86_64-pc-windows-gnu",
				"bin",
				"cargo",
			),
			// Standard cargo
			path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
			path.join(process.env.HOME || "", ".cargo", "bin", "cargo"),
			"cargo.exe",
			"cargo",
		];

		for (const candidate of candidates) {
			try {
				if (candidate.includes("\\") || candidate.includes("/")) {
					if (fs.existsSync(candidate)) {
						return candidate;
					}
				}
			} catch {
				// ignore
			}
		}

		return null;
	}

	/**
	 * Send a request to the native core
	 */
	private async sendRequest(req: AnalyzeRequest): Promise<AnalyzeResponse> {
		const binary = this.findBinary();
		if (!binary) {
			return {
				success: false,
				data: { empty: null },
				error: "Native core binary not found",
			};
		}

		return new Promise((resolve) => {
			const proc = spawn(binary, [], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					this.log(`Process exited with code ${code}: ${stderr}`);
					resolve({
						success: false,
						data: { empty: null },
						error: `Process failed: ${stderr || "unknown error"}`,
					});
					return;
				}

				try {
					const response: AnalyzeResponse = JSON.parse(stdout);
					resolve(response);
				} catch (err) {
					this.log(`Failed to parse response: ${err}`);
					resolve({
						success: false,
						data: { empty: null },
						error: `Invalid JSON response: ${err}`,
					});
				}
			});

			proc.on("error", (err) => {
				this.log(`Process error: ${err.message}`);
				resolve({
					success: false,
					data: { empty: null },
					error: `Process error: ${err.message}`,
				});
			});

			// Guard stdin against ERR_STREAM_DESTROYED / EPIPE if the process
			// crashes between spawn and the write below.
			proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ERR_STREAM_DESTROYED" || err.code === "EPIPE") return;
				this.log(`stdin error: ${err.message}`);
			});

			// Send the request
			proc.stdin?.write(JSON.stringify(req));
			proc.stdin?.end();
		});
	}

	/**
	 * Scan project for files
	 */
	async scanProject(
		projectRoot: string,
		extensions: string[],
	): Promise<FileEntry[]> {
		const req = {
			command: {
				scan: { extensions },
			},
			project_root: projectRoot,
		};

		const resp = await this.sendRequest(req as unknown as AnalyzeRequest);
		if (!resp.success || !("files" in resp.data)) {
			this.log(`Scan failed: ${resp.error}`);
			return [];
		}

		return (resp.data as { files: FileEntry[] }).files;
	}

	/**
	 * Build project index
	 */
	async buildIndex(
		projectRoot: string,
		files: string[],
	): Promise<IndexData | null> {
		const req = {
			command: {
				build_index: { files },
			},
			project_root: projectRoot,
		};

		const resp = await this.sendRequest(req as unknown as AnalyzeRequest);
		if (!resp.success || !("index" in resp.data)) {
			this.log(`Index build failed: ${resp.error}`);
			return null;
		}

		return (resp.data as { index: IndexData }).index;
	}

	/**
	 * Find similar functions
	 */
	async findSimilarities(
		projectRoot: string,
		filePath: string,
		threshold = 0.9,
	): Promise<SimilarityMatch[]> {
		const req = {
			command: {
				similarity: { file_path: filePath, threshold },
			},
			project_root: projectRoot,
		};

		const resp = await this.sendRequest(req as unknown as AnalyzeRequest);
		if (!resp.success || !("similarities" in resp.data)) {
			this.log(`Similarity check failed: ${resp.error}`);
			return [];
		}

		return (resp.data as { similarities: SimilarityMatch[] }).similarities;
	}

	/**
	 * Run tree-sitter query
	 */
	async runQuery(
		projectRoot: string,
		language: string,
		query: string,
		filePath: string,
	): Promise<QueryMatch[]> {
		const req = {
			command: {
				query: { language, query, file_path: filePath },
			},
			project_root: projectRoot,
		};

		const resp = await this.sendRequest(req as unknown as AnalyzeRequest);
		if (!resp.success || !("query_results" in resp.data)) {
			this.log(`Query failed: ${resp.error}`);
			return [];
		}

		return (resp.data as { query_results: QueryMatch[] }).query_results;
	}
}

// --- Singleton ---

let globalClient: NativeRustCoreClient | null = null;

export function getNativeRustCoreClient(verbose = false): NativeRustCoreClient {
	if (!globalClient) {
		globalClient = new NativeRustCoreClient(verbose);
	}
	return globalClient;
}

export function resetNativeRustCoreClient(): void {
	globalClient = null;
}
