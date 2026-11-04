/**
 * The `SessionBootstrapAccess` a fixture holding concrete clients hands to
 * `handleSessionStart` (#2467 review).
 *
 * `SessionStartDeps` used to carry fifteen optional analyzer-client fields
 * beside the seam, so a fixture could supply either shape — and so could a
 * production caller that forgot one: a dropped client field compiled and
 * silently skipped every startup scan. There is one shape now, and this is
 * how a caller that already HOLDS its clients presents them.
 *
 * It delegates to the PRODUCTION wrapper rather than re-implementing `peek`
 * and `request`, so a fixture cannot be served by a seam production would not
 * have built. It lives in its own file, and not in `bootstrap-mock.ts`,
 * because that module is imported from inside `vi.doMock` factories FOR
 * `clients/bootstrap.js` — a static import of the module being mocked from
 * inside its own factory deadlocks the mock resolution.
 */
import {
	type BootstrapClients,
	type SessionBootstrapAccess,
	residentBootstrapAccess,
} from "../../clients/bootstrap.js";

/** Add the seam to a fixture's loose client stubs, in place. */
export function withResidentBootstrap<T extends object>(
	deps: T,
): T & { bootstrap: SessionBootstrapAccess } {
	return {
		...deps,
		bootstrap: residentBootstrapAccess(deps as unknown as BootstrapClients),
	};
}
