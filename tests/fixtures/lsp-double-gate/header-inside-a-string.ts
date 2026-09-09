// A `// lsp-double:` line that is not a comment must not admit anything.
// #2585 round 4, F3: the header used to be matched on raw file text, so this
// file — which carries the marker only inside a template literal — satisfied
// the admission gate while being, at the level that matters, a string.
export const generatedSnippet = `
// lsp-double: this one is inside a template literal and grants nothing #2592
`;

export const alsoAString =
	"// lsp-double: and this one is a plain string, also nothing #2592";
