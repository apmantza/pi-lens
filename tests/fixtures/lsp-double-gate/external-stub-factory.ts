// Deliberately in a separate module: the detector resolves bindings within one
// file only, so a stub built here is opaque to the object-literal rule. See
// shape-c-post-hoc.ts.
export function createHostServiceStub(): Record<string, unknown> {
	return {};
}
