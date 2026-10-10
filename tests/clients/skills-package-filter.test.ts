/**
 * #1416: skills excluded through a settings package filter must STAY excluded
 * once pi-lens is bound.
 *
 * pi applies `packages[].skills` filters (`[]`, `!pattern`, `-path`) only to
 * the package's manifest-declared resources. pi-lens used to register its
 * whole `<packageRoot>/skills` directory through the extension's
 * `resources_discover` handler, which pi merged in raw, so every filtered-out
 * skill came back at bind time (report: #1416 comment 5950946380, observed on
 * pi-lens 4.3.0 against pi 0.99.2 and 1.0.0).
 *
 * These cases drive pi's REAL `DefaultResourceLoader` and a REAL `AgentSession`
 * (`bindExtensions` -> `ExtensionRunner.emitResourcesDiscover` -> loader
 * `extendResources`) with the REAL extension factory imported from
 * `index.js`. The hook's skill paths are produced by pi-lens's own handler, not
 * shaped by the test. The fixture package declares `pi.skills` resolving to
 * symlinks of the repo's real `skills/`, so the reporter's relative filter form
 * (`!skills/<name>/SKILL.md` / `-skills/<name>/SKILL.md`) applies to the same
 * files the handler would have re-added.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../../index.js";
import { setupTestEnvironment } from "./test-utils.js";
import { withEnv } from "../support/with-env.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_SKILLS = path.join(REPO_ROOT, "skills");
const ENTRY = path.join(REPO_ROOT, "index.js");

const SHIPPED = [
	"pi-lens-ast-grep",
	"pi-lens-lsp-navigation",
	"pi-lens-write-ast-grep-rule",
	"pi-lens-write-tree-sitter-rule",
];
const EXCLUDED = "pi-lens-ast-grep";

let env: ReturnType<typeof setupTestEnvironment>;
let restoreHome: (() => void) | undefined;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-1416-");
	// #4244: pi's resource loader also scans ~/.agents/skills, so a host's
	// installed third-party skill must not change this package-filter witness.
	const ambientHome = path.join(env.tmpDir, "ambient-home");
	const foreignSkill = path.join(
		ambientHome,
		".agents",
		"skills",
		"foreign-skill",
	);
	fs.mkdirSync(foreignSkill, { recursive: true });
	fs.writeFileSync(
		path.join(foreignSkill, "SKILL.md"),
		"---\nname: foreign-skill\ndescription: host skill witness\n---\n",
	);
	restoreHome = withEnv({ HOME: ambientHome, USERPROFILE: ambientHome });
});

afterEach(() => {
	restoreHome?.();
	restoreHome = undefined;
	env.cleanup();
});

type PackageFilter = string[] | undefined;

/** A package whose manifest skills resolve (through a symlink) to the repo's. */
function writeFixture(
	filter: PackageFilter,
	opts: { declareExtension?: boolean } = {},
): {
	agentDir: string;
	projectDir: string;
} {
	const root = env.tmpDir;
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const packageRoot = path.join(root, "package");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(packageRoot, { recursive: true });
	fs.symlinkSync(REPO_SKILLS, path.join(packageRoot, "skills"), "dir");
	const pi: { skills: string[]; extensions?: string[] } = {
		skills: ["./skills"],
	};
	if (opts.declareExtension === true) {
		// A `pi.extensions` manifest entry loads the extension by FILE PATH, so
		// `getExtensionSourceLabel` (`agent-session.js`) derives
		// `extension:index` from the basename. An inline factory gets
		// `extension:inline:1`, so only this shape can witness the real
		// registrar (F5).
		pi.extensions = ["./index.js"];
		fs.writeFileSync(
			path.join(packageRoot, "index.js"),
			`export { default } from ${JSON.stringify(pathToFileURL(ENTRY).href)};\n`,
		);
	}
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({
			name: "pi-lens-1416-fixture",
			version: "0.0.0",
			pi,
		}),
	);
	const entry: { source: string; skills?: string[] } = {
		source: packageRoot,
	};
	if (filter !== undefined) entry.skills = filter;
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [entry] }),
	);
	return { agentDir, projectDir };
}

/** Real loader + real session; returns every skill pi would advertise. */
async function boundSkills(options: {
	agentDir: string;
	projectDir: string;
	extensionFactories?: boolean;
	manifestExtension?: boolean;
}): Promise<{
	afterReload: string[];
	afterBind: string[];
	afterBindSources: Array<string | undefined>;
	inPrompt: string[];
}> {
	const pinnedHome = path.join(env.tmpDir, "pinned-home");
	fs.mkdirSync(pinnedHome, { recursive: true });
	const restoreHome = withEnv({
		HOME: pinnedHome,
		USERPROFILE: pinnedHome,
	});
	try {
		const loader = new DefaultResourceLoader({
			cwd: options.projectDir,
			agentDir: options.agentDir,
			...(options.manifestExtension === true
				? {}
				: options.extensionFactories === false
					? { additionalExtensionPaths: [ENTRY] }
					: { extensionFactories: [extension] }),
		});
		await loader.reload();
		const afterReload = skillNames(loader);
		const { session } = await createAgentSession({
			cwd: options.projectDir,
			agentDir: options.agentDir,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			await session.bindExtensions({});
			return {
				afterReload,
				afterBind: skillNames(loader),
				afterBindSources: skillSources(loader),
				inPrompt: SHIPPED.filter((name) => session.systemPrompt.includes(name)),
			};
		} finally {
			session.dispose();
		}
	} finally {
		restoreHome();
	}
}

function skillNames(loader: DefaultResourceLoader): string[] {
	return loader
		.getSkills()
		.skills.map((skill) => skill.name)
		.sort();
}

function skillSources(
	loader: DefaultResourceLoader,
): Array<string | undefined> {
	return loader.getSkills().skills.map((skill) => skill.sourceInfo?.source);
}

describe("package skill filters survive resources_discover (#1416)", () => {
	it("keeps a per-skill exclusion (`!pattern`) absent and the other three present", async () => {
		const { agentDir, projectDir } = writeFixture([
			`!skills/${EXCLUDED}/SKILL.md`,
		]);
		const { afterReload, afterBind, inPrompt } = await boundSkills({
			agentDir,
			projectDir,
		});
		expect(afterReload).toEqual(SHIPPED.filter((n) => n !== EXCLUDED).sort());
		expect(afterBind).toEqual(SHIPPED.filter((n) => n !== EXCLUDED).sort());
		expect(inPrompt).not.toContain(EXCLUDED);
	});

	it("keeps a per-skill exact exclusion (`-path`) absent and the other three present", async () => {
		const { agentDir, projectDir } = writeFixture([
			`-skills/${EXCLUDED}/SKILL.md`,
		]);
		const { afterBind } = await boundSkills({ agentDir, projectDir });
		expect(afterBind).toEqual(SHIPPED.filter((n) => n !== EXCLUDED).sort());
	});

	it("keeps an all-skill exclusion (`[]`) empty", async () => {
		const { agentDir, projectDir } = writeFixture([]);
		const { afterReload, afterBind, inPrompt } = await boundSkills({
			agentDir,
			projectDir,
		});
		expect(afterReload).toEqual([]);
		expect(afterBind).toEqual([]);
		expect(inPrompt).toEqual([]);
	});

	it("does not drop the shipped skills when no filter is set (only-default answer)", async () => {
		const { agentDir, projectDir } = writeFixture(undefined);
		const { afterReload, afterBind, inPrompt } = await boundSkills({
			agentDir,
			projectDir,
		});
		expect(afterReload).toEqual([...SHIPPED].sort());
		expect(afterBind).toEqual([...SHIPPED].sort());
		expect(inPrompt).toEqual([...SHIPPED].sort());
	});

	it("labels held skills with the package registrar, never the extension handler", async () => {
		// F5: load the extension through the package manifest (`pi.extensions`),
		// so its real path yields the `extension:index` registrar on the pre-fix
		// handler. An inline factory is labelled `extension:inline:1` and this
		// cell would pass on base.
		const { agentDir, projectDir } = writeFixture(
			[`!skills/${EXCLUDED}/SKILL.md`],
			{ declareExtension: true },
		);
		const { afterBind, afterBindSources } = await boundSkills({
			agentDir,
			projectDir,
			manifestExtension: true,
		});
		expect(afterBind).toEqual(SHIPPED.filter((n) => n !== EXCLUDED).sort());
		expect(afterBindSources).not.toContain("extension:index");
	});
});

describe("direct (non-package) extension loading (#1416 supported-mode witness)", () => {
	it("delivers no skills without the package manifest, and contributes no handler paths", async () => {
		// Not a documented pi-lens install (README installs packages: `npm:`,
		// `git:`, `./path`). Witnessed so the supported package path and this
		// path have independent behaviour, and so the loss is deliberate.
		const agentDir = path.join(env.tmpDir, "agent-direct");
		const projectDir = path.join(env.tmpDir, "project-direct");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), "{}");
		const { afterReload, afterBind } = await boundSkills({
			agentDir,
			projectDir,
			extensionFactories: false,
		});
		expect(afterReload).toEqual([]);
		expect(afterBind).toEqual([]);
	});
});
