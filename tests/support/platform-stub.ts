/**
 * Force `process.platform` for a test. Only code that reads the platform live
 * (not into a module-load-time const) observes it. The one home for this stub:
 * eight suites had each hand-rolled the same `Object.defineProperty(process,
 * "platform", ...)` pair (#1506 net-count fold).
 */
export function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

/**
 * Run `body` under `platform`, restoring the real one even if it throws. A
 * promise-returning `body` keeps the platform until the promise settles: a
 * synchronous restore on return would let every `await` in the body resume
 * under the host platform (#5715 F2).
 */
export function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
	const original = process.platform;
	setPlatform(platform);
	let result: T;
	try {
		result = body();
	} catch (error) {
		setPlatform(original);
		throw error;
	}
	if (result instanceof Promise) {
		return result.finally(() => setPlatform(original)) as T;
	}
	setPlatform(original);
	return result;
}
