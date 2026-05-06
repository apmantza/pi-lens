import * as astGrep from "./ast-grep/index.js";
import * as lspNavigation from "./lsp-navigation.js";
import * as read from "./read.js";

export const LANGUAGES = [
	"c",
	"cpp",
	"csharp",
	"css",
	"dart",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"sql",
	"swift",
	"tsx",
	"typescript",
	"yaml",
] as const;

export { astGrep, lspNavigation, read };
