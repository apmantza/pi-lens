export function stripForPack<T extends { devDependencies?: unknown }>(
	pkg: T,
): Omit<T, "devDependencies">;

export function restore(): void;
