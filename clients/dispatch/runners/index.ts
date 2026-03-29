/**
 * Runner definitions for pi-lens dispatch system
 */

import { registerRunner } from "../dispatcher.js";
import architectRunner from "./architect.js";
// Import all runners
import astGrepRunner from "./ast-grep.js";
import biomeRunner from "./biome.js";
import goVetRunner from "./go-vet.js";
import pyrightRunner from "./pyright.js";
import ruffRunner from "./ruff.js";
import rustClippyRunner from "./rust-clippy.js";
import tsLspRunner from "./ts-lsp.js";
import typeSafetyRunner from "./type-safety.js";

// Register all runners (ordered by priority)
registerRunner(tsLspRunner); // TypeScript type-checking
registerRunner(pyrightRunner); // Python type-checking
registerRunner(biomeRunner);
registerRunner(ruffRunner);
registerRunner(typeSafetyRunner);
registerRunner(astGrepRunner);
registerRunner(architectRunner);
registerRunner(goVetRunner);
registerRunner(rustClippyRunner);
