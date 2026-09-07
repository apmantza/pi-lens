/** Lazy dispatch integration seam for startup-cost control (#1394). */
import { createLazyImport } from "../lazy-import.js";

type DispatchIntegration = typeof import("./integration.js");

const lazyIntegration = createLazyImport<DispatchIntegration>(
	() => import("./integration.js"),
);

/** Start loading the runner graph once; callers may fire-and-forget this. */
export function warmDispatchIntegration(): Promise<DispatchIntegration> {
	return lazyIntegration.get();
}

/** Await the same promise used by session-start warming and first use. */
export function loadDispatchIntegration(): Promise<DispatchIntegration> {
	return warmDispatchIntegration();
}
