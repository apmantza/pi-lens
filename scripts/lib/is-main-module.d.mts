export function isMainModule(
	selfUrl: string,
	options?: {
		argv1?: string | undefined;
		realpath?: (path: string) => string;
	},
): boolean;
