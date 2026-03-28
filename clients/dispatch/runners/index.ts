/**
 * Runner definitions for pi-lens dispatch system
 */

import { registerRunner } from "../dispatcher.js";

// Import all runners
import astGrepRunner from "./ast-grep.js";
import biomeRunner from "./biome.js";
import ruffRunner from "./ruff.js";
import tsLspRunner from "./ts-lsp.js";
import typeSafetyRunner from "./type-safety.js";
import architectRunner from "./architect.js";
import goVetRunner from "./go-vet.js";
import rustClippyRunner from "./rust-clippy.js";

// Register all runners (ordered by priority)
registerRunner(tsLspRunner);
registerRunner(biomeRunner);
registerRunner(ruffRunner);
registerRunner(typeSafetyRunner);
registerRunner(astGrepRunner);
registerRunner(architectRunner);
registerRunner(goVetRunner);
registerRunner(rustClippyRunner);
