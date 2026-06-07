/**
 * Local re-implementation of the host SDK's `isToolCallEventType`.
 *
 * Why this exists instead of importing from `@earendil-works/pi-coding-agent`:
 * pi installs extension dependencies with `npm install --omit=dev`, so the host
 * coding-agent package is NOT present in the extension's `node_modules` at
 * runtime. Importing a *runtime value* from it therefore fails to resolve on a
 * clean install. Pulling it in as a real dependency is worse — it drags a huge
 * transitive tree (LLM provider SDKs) whose deeply nested paths exceed Windows'
 * MAX_PATH, which breaks `git clean -fdx` during `pi update`.
 *
 * The SDK function is a one-line discriminant check, so we inline it and keep
 * every `@earendil-works/pi-coding-agent` import type-only (types compile away).
 */
export function isToolCallEventType<T extends string>(
	toolName: T,
	event: unknown,
): boolean {
	return (
		!!event &&
		typeof event === "object" &&
		(event as { toolName?: unknown }).toolName === toolName
	);
}
