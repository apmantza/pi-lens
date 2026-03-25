import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Creates a temporary file within the given temp directory.
 * Automatically creates parent directories if they don't exist.
 */
export function createTempFile(
	tmpDir: string,
	name: string,
	content: string,
): string {
	const filePath = path.join(tmpDir, name);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(filePath, content);
	return filePath;
}

/**
 * Creates a temporary directory for testing.
 * Returns the path and a cleanup function.
 */
export function setupTestEnvironment(prefix: string): {
	tmpDir: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const cleanup = () => {
		if (tmpDir && fs.existsSync(tmpDir)) {
			fs.rmSync(tmpDir, { recursive: true });
		}
	};
	return { tmpDir, cleanup };
}
