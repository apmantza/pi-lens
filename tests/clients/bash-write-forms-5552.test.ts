/**
 * #5552: the bash prescan names what `mv a.ts src/`, `rsync` and `tar x` write.
 *
 * Recurrence prevented: #5581 recovered an mtime-preserving write by content
 * only where the prescan named the destination FILE, and
 * `scanShellWriteScopes` returned nothing for a directory destination, an
 * rsync or a tar extraction, so those writes stayed behind the mtime filter
 * and no consumer saw them (writer-route audit, 2026-11-13).
 *
 * Every case reads the REAL filesystem (a directory is a directory by what
 * `stat` says), so the fixture lays out `src/`, a source directory and files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isEditClassToolResult,
	scanShellWriteScopes,
} from "../../clients/bash-file-access.js";
import { removeTempDirSync } from "./test-utils.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-bwf-"));
	for (const dir of ["src", "in", "src/sub"])
		fs.mkdirSync(path.join(tmp, dir), { recursive: true });
	for (const file of ["a.ts", "in/x.ts", "src/a.ts", "src/sub/b.ts"])
		fs.writeFileSync(path.join(tmp, file), "x\n");
});

afterEach(() => {
	removeTempDirSync(tmp);
});

const at = (...parts: string[]) => path.join(tmp, ...parts);

function scan(command: string, cwd = tmp) {
	const { written, writtenDirs } = scanShellWriteScopes(command, cwd);
	return { written, writtenDirs };
}

describe("a directory destination of cp, mv and install (#5552)", () => {
	// Recurrence prevented: `mv a.ts src/` named the directory, which the scan
	// dropped as no source file, so the moved bytes were never credited.
	it.each([
		["mv a.ts src/", "a trailing slash"],
		["mv a.ts src", "an existing directory with no slash"],
		["cp -p a.ts src/", "cp -p"],
		["install a.ts src/", "install"],
		["git mv a.ts src/", "git mv"],
	])("%s names src/a.ts and no scope (%s)", (command) => {
		expect(scan(command)).toEqual({
			written: [at("src", "a.ts")],
			writtenDirs: [],
		});
	});

	it("names one file per source", () => {
		expect(scan("mv a.ts in/x.ts src/").written).toEqual([
			at("src", "a.ts"),
			at("src", "x.ts"),
		]);
	});

	// Recurrence prevented: a trailing slash keeps a directory a directory even
	// when it does not exist yet (`mv a.ts newdir/` fails, but names newdir/a.ts).
	it("reads a trailing slash as a directory that does not exist yet", () => {
		expect(scan("mv a.ts nowhere/").written).toEqual([at("nowhere", "a.ts")]);
	});

	// Controls: a file destination keeps naming the file, whatever else exists.
	it.each(["mv a.ts b.ts", "cp a.ts b.ts"])(
		"%s still names the file",
		(command) => {
			expect(scan(command).written).toEqual([at("b.ts")]);
			expect(scan(command).writtenDirs ?? []).toEqual([]);
		},
	);

	// Recurrence prevented: a source that is a directory writes files argv never
	// names, and the joined `src/in` is no source file to name.
	it.each(["cp -r in src/", "cp -a in src", "mv in src/", "cp -r in/ src/"])(
		"%s fills src: it is the scope",
		(command) => {
			expect(scan(command).writtenDirs).toEqual([at("src")]);
		},
	);

	it("reads the destination a command creates, once it exists", () => {
		fs.mkdirSync(at("fresh"));
		expect(scan("cp -a in fresh").writtenDirs).toEqual([at("fresh")]);
	});

	it("resolves the destination against the cd in effect", () => {
		expect(scan("cd src && mv ../a.ts sub/").written).toEqual([
			at("src", "sub", "a.ts"),
		]);
	});

	it("names the -t destination as before, with no scope for files", () => {
		expect(scan("cp -t src a.ts").written).toEqual([at("src", "a.ts")]);
		expect(scan("cp -t src a.ts").writtenDirs ?? []).toEqual([]);
	});
});

describe("rsync (#5552)", () => {
	// Recurrence prevented: the sources and their slashes decide what lands
	// under the destination, never which directory it lands under.
	it.each([
		"rsync -a in/ src/",
		"rsync -a in src",
		"rsync -av --delete in/ src/",
		"rsync -a --delete-after in/ src/",
		"rsync -a in/ src/sub/ src/",
		"rsync -a --exclude '*.log' in/ src/",
		"rsync -a -e 'ssh -p 22' in/ src/",
		"rsync -ae 'ssh -p 22' in/ src/",
		"rsync -a in/ src/ --exclude node_modules",
		"rsync -a in/ src/ -e ssh",
		"rsync -a in/ src/ -ae ssh",
		"rsync -a in/ src/ --rsh ssh",
		"rsync -a in/ src/ --filter='- *.log'",
		"rsync -a --info progress2 in/ src/",
		"rsync -a host:dir/ src/",
		"rsync -a -- in/ src/",
	])("%s fills src", (command) => {
		expect(scan(command)).toEqual({ written: [], writtenDirs: [at("src")] });
	});

	it("names a file destination as the one written path", () => {
		expect(scan("rsync -a a.ts b.ts")).toEqual({
			written: [at("b.ts")],
			writtenDirs: [],
		});
	});

	// Recurrence prevented: a destination the scan cannot read must not read as
	// "no writes"; it falls back to the working directory.
	it.each(['rsync -a in/ "$D"', "rsync -a in/ $D", "rsync -a in/ `pwd`"])(
		"%s falls back to the working directory",
		(command) => {
			expect(scan(command)).toEqual({ written: [], writtenDirs: [tmp] });
		},
	);

	// A remote destination and a listing write nothing on this host.
	it.each([
		"rsync -a in/ host:dir/",
		"rsync -a in/ user@host:dir/",
		"rsync -a in/ rsync://host/mod/",
		"rsync -a in/ host::mod",
		"rsync -a in/",
		"rsync --list-only in/",
		"rsync --version",
	])("%s writes nothing here", (command) => {
		expect(scan(command)).toEqual({ written: [], writtenDirs: [] });
	});

	it("resolves the destination against the cd in effect", () => {
		expect(scan("cd src && rsync -a ../in/ sub/").writtenDirs).toEqual([
			at("src", "sub"),
		]);
	});
});

describe("tar x (#5552)", () => {
	// Recurrence prevented: the archive names the files, not argv, so the scope
	// is the extraction directory: the working directory unless -C moves it.
	it.each([
		"tar x -f a.tar",
		"tar -xf a.tar",
		"tar xf a.tar",
		"tar xzf a.tgz",
		"tar -xzvf a.tgz",
		"tar --extract --file a.tar",
		"tar --get -f a.tar",
		"tar -x < a.tar",
		"tar -xf a.tar --strip-components 1",
		"tar -xf a.tar --exclude '*.log'",
	])("%s extracts into the working directory", (command) => {
		expect(scan(command)).toEqual({ written: [], writtenDirs: [tmp] });
	});

	it.each([
		"tar -xf a.tar -C src",
		"tar -C src -xf a.tar",
		"tar xf a.tar -Csrc",
		"tar -xCsrc -f a.tar",
		"tar xCf src a.tar",
		"tar -xf a.tar --directory src",
		"tar -xf a.tar --directory=src",
		"tar --extract --directory=src --file a.tar",
		"tar -xf a.tar -C src/",
	])("%s extracts into src", (command) => {
		expect(scan(command)).toEqual({ written: [], writtenDirs: [at("src")] });
	});

	// Each -C is relative to the one before it, as tar reads them.
	it("chains a relative -C from the previous one", () => {
		expect(scan("tar -xf a.tar -C src -C sub").writtenDirs).toEqual([
			at("src"),
			at("src", "sub"),
		]);
	});

	it("extracts into the directory a cd moved to", () => {
		expect(scan("cd src && tar xf ../a.tar").writtenDirs).toEqual([at("src")]);
	});

	// Recurrence prevented: an unreadable -C is the working directory, never silence.
	it.each(['tar -xf a.tar -C "$D"', "tar -xf a.tar -C $D", "tar -xf a.tar -C"])(
		"%s falls back to the working directory",
		(command) => {
			expect(scan(command).writtenDirs).toEqual([tmp]);
		},
	);

	// Controls: only an extraction writes the project tree.
	it.each([
		"tar -cf a.tar src",
		"tar -czf out.tgz -C src .",
		"tar -tf a.tar",
		"tar cf a.tar src",
		"tar -cfx src",
		"tar --list --file a.tar",
		"tar --version",
		"echo tar -xf a.tar",
	])("%s writes no directory scope", (command) => {
		expect(scan(command).writtenDirs).toEqual([]);
	});
});

describe("isEditClassToolResult counts a filled directory as an edit (#5552)", () => {
	// Recurrence prevented: the read-only wall bounded an rsync or a tar
	// extraction's dispatch at the read budget, because only a named FILE made
	// a bash result edit-class.
	it.each(["rsync -a in/ src/", "tar xf a.tar", "mv a.ts src/"])(
		"%s is edit-class",
		(command) => {
			expect(
				isEditClassToolResult({ toolName: "bash", input: { command } }, tmp),
			).toBe(true);
		},
	);

	it.each(["tar tf a.tar", "rsync -a in/ host:dir/"])(
		"%s is not",
		(command) => {
			expect(
				isEditClassToolResult({ toolName: "bash", input: { command } }, tmp),
			).toBe(false);
		},
	);
});
