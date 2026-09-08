export const isProductionMutationFile = (file) =>
	/^(?:clients\/.*\.ts|scripts\/.*\.mjs)$/.test(file) &&
	!/(?:tests|fixtures)\//.test(file) &&
	!/(?:\.d\.mts|\.js)$/.test(file);
