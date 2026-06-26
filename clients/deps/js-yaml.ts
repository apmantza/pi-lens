/**
 * Centralized accessor for `js-yaml`. See ./typescript.ts for the rationale.
 * Exposes both the default export (callers that do `import yaml from …`) and the
 * named `dump`/`load` helpers, sourced from the one import.
 */
import yaml from "js-yaml";

export default yaml;
export const dump = yaml.dump;
export const load = yaml.load;
