export type DependencyResult =
	| { ok: true; binaryPath: string; oxlintVersion: string; message?: never }
	| { ok: false; message: string };

export function validateTypeAwareDependency(options?: {
	resolve?: (name: string) => string;
	readPackage?: (file: string) => Record<string, any>;
	fileExists?: (file: string) => boolean;
}): DependencyResult;

export function runAdvisory(options?: {
	args?: string[];
	spawn?: (
		command: string,
		args: string[],
		options: object,
	) => { status: number | null };
	resolve?: (name: string) => string;
	readPackage?: (file: string) => Record<string, any>;
	fileExists?: (file: string) => boolean;
}): number;
