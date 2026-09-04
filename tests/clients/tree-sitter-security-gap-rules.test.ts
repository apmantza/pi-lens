import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sec-gap-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, `sample.${ext}`);
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter security gap rules", () => {
	it("matches python ssrf sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile(
			"py",
			`import requests\nrequests.get(user_url)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python literal URL request", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile(
			"py",
			`import requests\nrequests.get("https://example.com")\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python path traversal sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open(base + user_path)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match static python file path", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open("/tmp/safe.txt")\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python sql injection sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id = " + user_id)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match parameterized python sql", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id=%s", (user_id,))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("does not match a structurally proven SQLAlchemy Session query", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef find(db: Session):\n    return db.query(MyModel)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches).toHaveLength(0);
	});

	it("keeps a receiver-named session query without Session provenance", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`def find(session):\n    return session.query(MyModel)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("keeps a Session query when the imported Session name is shadowed", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef find(db: Session):\n    Session = object\n    return db.query(MyModel)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match structurally proven psycopg Identifier composition", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from psycopg import sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches).toHaveLength(0);
	});

	it("does not match structurally proven psycopg2 Identifier composition", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from psycopg2 import sql as postgres_sql\ncursor.execute(postgres_sql.SQL("SELECT * FROM {}").format(postgres_sql.Identifier(table)))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches).toHaveLength(0);
	});

	it("keeps psycopg composition with a dynamic template, non-Identifier arg, or ambiguous sql binding", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const dynamicTemplate = writeTempFile(
			"py",
			`from psycopg import sql\ncursor.execute(sql.SQL(template).format(sql.Identifier(table)))\n`,
		);
		const nonIdentifierArg = writeTempFile(
			"py",
			`from psycopg import sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Literal(value)))\n`,
		);
		const reassignedImport = writeTempFile(
			"py",
			`from psycopg import sql\nsql = unsafe_sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n`,
		);
		expect(
			await client.runQueryOnFile(query, dynamicTemplate, "python"),
		).not.toHaveLength(0);
		expect(
			await client.runQueryOnFile(query, nonIdentifierArg, "python"),
		).not.toHaveLength(0);
		expect(
			await client.runQueryOnFile(query, reassignedImport, "python"),
		).not.toHaveLength(0);
	});

	it("keeps raw execute calls even when the receiver is Session-annotated", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef run(db: Session, statement):\n    return db.execute(statement)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("suppresses direct SQLAlchemy Session import aliases but not assignment aliases", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const importAlias = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session as DbSession\ndef find(db: DbSession):\n    return db.query(Model)\n`,
		);
		const aliasChain = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\nDbSession = Session\ndef find(db: DbSession):\n    return db.query(Model)\n`,
		);
		const nestedVisibleImport = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef outer():\n    def find(db: Session):\n        return db.query(Model)\n    return find\n`,
		);
		for (const filePath of [importAlias, nestedVisibleImport]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).toHaveLength(0);
		}
		expect(
			await client.runQueryOnFile(query, aliasChain, "python"),
		).not.toHaveLength(0);
	});

	it("keeps SQLAlchemy queries after receiver or Session provenance changes", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const receiverRebound = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef find(db: Session):\n    db = unsafe_receiver\n    return db.query(Model)\n`,
		);
		const innerSessionShadow = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef outer():\n    Session = object\n    def find(db: Session):\n        return db.query(Model)\n    return find\n`,
		);
		const useBeforeImport = writeTempFile(
			"py",
			`def find(db: Session):\n    return db.query(Model)\nfrom sqlalchemy.orm import Session\n`,
		);
		for (const filePath of [
			receiverRebound,
			innerSessionShadow,
			useBeforeImport,
		]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("suppresses direct psycopg import aliases but not assignment aliases", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const packageAlias = writeTempFile(
			"py",
			`import psycopg2 as pg\ncursor.execute(pg.sql.SQL("SELECT * FROM {}").format(pg.sql.Identifier(table)))\n`,
		);
		const moduleAliasChain = writeTempFile(
			"py",
			`from psycopg import sql\npg_sql = sql\ncursor.execute(pg_sql.SQL("SELECT * FROM {}").format(pg_sql.Identifier(table)))\n`,
		);
		const constructorAliases = writeTempFile(
			"py",
			`from psycopg.sql import SQL as Query, Identifier as Ident\ncursor.execute(Query("SELECT * FROM {}").format(Ident(table)))\n`,
		);
		const constructorAliasChain = writeTempFile(
			"py",
			`from psycopg2.sql import SQL, Identifier\nQuery = SQL\nIdent = Identifier\ncursor.execute(Query("SELECT * FROM {}").format(Ident(table)))\n`,
		);
		for (const filePath of [packageAlias, constructorAliases]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).toHaveLength(0);
		}
		for (const filePath of [moduleAliasChain, constructorAliasChain]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("keeps psycopg calls with shadowed, use-before-import, or rebound provenance", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const nestedShadow = writeTempFile(
			"py",
			`from psycopg import sql\ndef run():\n    sql = unsafe_sql\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n`,
		);
		const useBeforeImport = writeTempFile(
			"py",
			`cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\nfrom psycopg import sql\n`,
		);
		const reboundConstructor = writeTempFile(
			"py",
			`from psycopg.sql import SQL, Identifier\nSQL = unsafe_sql\ncursor.execute(SQL("SELECT * FROM {}").format(Identifier(table)))\n`,
		);
		for (const filePath of [
			nestedShadow,
			useBeforeImport,
			reboundConstructor,
		]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("keeps arbitrary object scalar and scalars calls diagnostic", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`client.scalar(statement)\nclient.scalars(statement)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches).toHaveLength(2);
	});

	it("keeps function-local and comprehension psycopg shadows diagnostic", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const parameterShadow = writeTempFile(
			"py",
			`from psycopg import sql\ndef run(sql):\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n`,
		);
		const laterLocalBinding = writeTempFile(
			"py",
			`from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    sql = unsafe_sql\n`,
		);
		const comprehensionShadows = [
			`results = [cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources]`,
			`results = {cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources}`,
			`results = {table: cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources}`,
			`results = (cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources)`,
		].map((expression) =>
			writeTempFile("py", `from psycopg import sql\n${expression}\n`),
		);
		for (const filePath of [
			parameterShadow,
			laterLocalBinding,
			...comprehensionShadows,
		]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("keeps function-local Session shadows diagnostic", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const parameterShadow = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef outer(Session):\n    def find(db: Session):\n        return db.query(Model)\n    return find\n`,
		);
		const laterLocalBinding = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session\ndef find(db: Session):\n    return db.query(Model)\n    Session = unsafe_session\n`,
		);
		for (const filePath of [parameterShadow, laterLocalBinding]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("keeps every statically discoverable function-local Python binder diagnostic", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const sink = `cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))`;
		const binders = [
			["destructuring", `x, (sql, y) = values`],
			["annotated", `sql: object = unsafe_sql`],
			["augmented", `sql += unsafe_sql`],
			["walrus", `if (sql := unsafe_sql):\n        pass`],
			["import", `from unsafe_module import sql`],
			["for", `for sql in values:\n        pass`],
			["with", `with connection.cursor() as sql:\n        pass`],
			["except", `try:\n        pass\n    except Error as sql:\n        pass`],
			[
				"except-star",
				`try:\n        pass\n    except* Error as sql:\n        pass`,
			],
			["del", `del sql`],
			["function", `def sql():\n        pass`],
			["class", `class sql:\n        pass`],
			["type-alias", `type sql = object`],
			["match-capture", `match value:\n        case sql:\n            pass`],
			["match-as", `match value:\n        case _ as sql:\n            pass`],
		].map(([name, binder]) => ({
			name,
			filePath: writeTempFile(
				"py",
				`from psycopg import sql\ndef run():\n    ${sink}\n    ${binder}\n`,
			),
		}));
		const asyncFor = writeTempFile(
			"py",
			`from psycopg import sql\nasync def run():\n    ${sink}\n    async for sql in values:\n        pass\n`,
		);
		const lambdaParameter = writeTempFile(
			"py",
			`from psycopg import sql\nrun = lambda sql: ${sink}\n`,
		);
		for (const { name, filePath } of binders) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
				name,
			).not.toHaveLength(0);
		}
		for (const filePath of [asyncFor, lambdaParameter]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("does not bind match wildcard underscore", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from psycopg import sql\ndef run():\n    match value:\n        case _:\n            pass\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n`,
		);
		expect(await client.runQueryOnFile(query, filePath, "python")).toHaveLength(
			0,
		);
	});

	it("indexes class-pattern keyword values without binding keyword names or qualified values", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const sqlCapture = writeTempFile(
			"py",
			`from psycopg import sql
def run(value):
    match value:
        case Wrapper(sql=sql):
            pass
    cursor.execute(sql.SQL("SELECT {} ").format(sql.Identifier(table)))
`,
		);
		const sessionCapture = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session
def run(value, db: Session):
    match value:
        case Wrapper(session=Session):
            pass
    return db.query(Model)
`,
		);
		const nonBindingPatterns = writeTempFile(
			"py",
			`from psycopg import sql
def run(value):
    match value:
        case Wrapper(sql=constants.VALUE):
            pass
        case constants.Other:
            pass
    cursor.execute(sql.SQL("SELECT {} ").format(sql.Identifier(table)))
`,
		);
		for (const filePath of [sqlCapture, sessionCapture]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
		expect(
			await client.runQueryOnFile(query, nonBindingPatterns, "python"),
		).toHaveLength(0);
	});

	it("does not use class imports for method-body psycopg provenance", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const classImport = writeTempFile(
			"py",
			`class Repository:\n    import psycopg\n    def run(self):\n        cursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))\n`,
		);
		const moduleImport = writeTempFile(
			"py",
			`import psycopg\nclass Repository:\n    def run(self):\n        cursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))\n`,
		);
		expect(
			await client.runQueryOnFile(query, classImport, "python"),
		).not.toHaveLength(0);
		expect(
			await client.runQueryOnFile(query, moduleImport, "python"),
		).toHaveLength(0);
	});

	it("keeps eight- and nine-hop assignment aliases diagnostic", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const aliases = (count: number) =>
			Array.from({ length: count }, (_, index) => {
				const name = `a${index + 1}`;
				const source = index === 0 ? "sql" : `a${index}`;
				return `${name} = ${source}`;
			}).join("\n");
		const eightHops = writeTempFile(
			"py",
			`from psycopg import sql\n${aliases(8)}\ncursor.execute(a8.SQL("SELECT * FROM {}").format(a8.Identifier(table)))\n`,
		);
		const nineHops = writeTempFile(
			"py",
			`from psycopg import sql\n${aliases(9)}\ncursor.execute(a9.SQL("SELECT * FROM {}").format(a9.Identifier(table)))\n`,
		);
		for (const filePath of [eightHops, nineHops]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("proves the consumer Session and psycopg SQL shapes without treating valid binders as hazards", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const sessionQueries = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session

def accessible_lessons(session: Session, user_id):
    rows = session.query(Lesson).filter(Lesson.user_id == user_id).all()
    progress = {item.id: item for item in session.query(LessonProgress).filter(LessonProgress.user_id == user_id).all()}
    for lesson, week_id, _, version_id in rows:
        pass
    return progress
`,
		);
		const psycopgCommands = writeTempFile(
			"py",
			`import psycopg
from psycopg import sql

def create_and_drop(url, name):
    with psycopg.connect(url) as admin, admin.cursor() as cursor:
        cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    with psycopg.connect(url) as admin, admin.cursor() as cursor:
        cursor.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(name)))
`,
		);
		for (const filePath of [sessionQueries, psycopgCommands]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).toHaveLength(0);
		}
	});

	it("keeps consumer-shape lookalikes diagnostic when a receiver or SQL proof changes", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const unsafeSession = writeTempFile(
			"py",
			`from sqlalchemy.orm import Session

def accessible_lessons(session: Session):
    for lesson, week_id, _, version_id in rows:
        pass
    session = unsafe_session
    return session.query(Lesson)
`,
		);
		const unsafePsycopg = [
			`from psycopg import sql\ncursor.execute("DROP DATABASE " + name)`,
			`from psycopg import sql\ncursor.execute(sql.SQL(template).format(sql.Identifier(name)))`,
			`from psycopg import sql\ncursor.execute(sql.SQL("DROP DATABASE {} ").format(sql.Literal(name)))`,
		].map((source) => writeTempFile("py", source));
		for (const filePath of [unsafeSession, ...unsafePsycopg]) {
			expect(
				await client.runQueryOnFile(query, filePath, "python"),
			).not.toHaveLength(0);
		}
	});

	it("fails closed for dynamic namespaces, conditional imports, and comprehension walruses", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const sink = `cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))`;
		const dynamicNamespaces = [
			`exec("sql = unsafe_sql")`,
			`eval("sql = unsafe_sql")`,
			`globals()["sql"] = unsafe_sql`,
			`locals()["sql"] = unsafe_sql`,
			`vars()["sql"] = unsafe_sql`,
		];
		const walruses = [
			`[(sql := unsafe_sql) for _ in values]`,
			`{(sql := unsafe_sql) for _ in values}`,
			`{key: (sql := unsafe_sql) for key in values}`,
			`((sql := unsafe_sql) for _ in values)`,
			`[(sql := unsafe_sql) for _ in values for _ in values]`,
		];
		const sources = [
			`if enabled:\n    from psycopg import sql\n${sink}`,
			`from psycopg import sql\nfrom plugin import *\n${sink}`,
			...dynamicNamespaces.map(
				(mutation) => `from psycopg import sql\n${mutation}\n${sink}`,
			),
			...walruses.map(
				(walrus) =>
					`from psycopg import sql\ndef run():\n    ${walrus}\n    ${sink}`,
			),
			`from psycopg import sql\ndef outer():\n    def run():\n        global sql\n        ${sink}`,
			`from psycopg import sql\ndef outer():\n    sql = unsafe_sql\n    def run():\n        nonlocal sql\n        ${sink}`,
			`class Repository:\n    from psycopg import sql\n    rows = [${sink} for table in tables]`,
		];
		for (const source of sources) {
			expect(
				await client.runQueryOnFile(
					query,
					writeTempFile("py", source),
					"python",
				),
			).not.toHaveLength(0);
		}
	});

	it("uses only direct imports and exact binding targets for provenance", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const safe = [
			`from psycopg import sql as pg\ncursor.execute(pg.SQL("SELECT * FROM {}").format(pg.Identifier(table)))`,
			`import psycopg\ncursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))`,
			`from psycopg.sql import SQL, Identifier\ncursor.execute(SQL("SELECT * FROM {}").format(Identifier(table)))`,
			`from psycopg2.sql import SQL as Query, Identifier as Ident\ncursor.execute(Query("SELECT * FROM {}").format(Ident(table)))`,
			`from psycopg import sql\nobj.sql = unsafe_sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))`,
			`from psycopg import sql\nitems[sql] = unsafe_sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))`,
		];
		for (const source of safe) {
			expect(
				await client.runQueryOnFile(
					query,
					writeTempFile("py", source),
					"python",
				),
			).toHaveLength(0);
		}
		const conditionalAlias = `from psycopg import sql\nalias = unsafe_sql\nif enabled:\n    alias = sql\ncursor.execute(alias.SQL("SELECT * FROM {}").format(alias.Identifier(table)))`;
		expect(
			await client.runQueryOnFile(
				query,
				writeTempFile("py", conditionalAlias),
				"python",
			),
		).not.toHaveLength(0);
	});

	it("matches raw cursor.execute(sql_identifier)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile("py", `cursor.execute(sql)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches python insecure deserialization sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile(
			"py",
			`import pickle\npickle.loads(payload)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python json deserialization", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile("py", `import json\njson.loads(payload)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python weak hash usage and exposes metadata", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-weak-hash");
		expect(query.cwe).toContain("CWE-327");
		expect(query.owasp).toContain("A02");
		expect(query.confidence).toBe("high");

		const filePath = writeTempFile("py", `import hashlib\nhashlib.md5(data)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go sql injection sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "fmt"\nfunc run(db DB, userID string){ db.Query(fmt.Sprintf("SELECT * FROM users WHERE id=%s", userID)) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match parameterized go sql", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nfunc run(db DB, id string){ db.Query("SELECT * FROM users WHERE id=$1", id) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBe(0);
	});

	it("matches typescript ssrf sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile("ts", `await fetch(userUrl);\n`);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// Regression coverage for #963: naming convention alone (e.g.
	// SCREAMING_SNAKE_CASE) must never be trusted as proof of a fixed URL.
	// Only a provably literal-initialized `const` in the same file is exempt.
	it("does not flag fetch of a const initialized with a string literal (#963)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const OPENAI_URL = "https://api.openai.com/v1";\nawait fetch(OPENAI_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a lowercase const initialized with a string literal", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const targetUrl = "https://example.com/api";\nawait fetch(targetUrl);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a const initialized with a substitution-free template literal", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const OPENAI_URL = `https://api.openai.com/v1`;\nawait fetch(OPENAI_URL);\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("still flags fetch of an all-caps identifier assigned from tainted input (#963 regression this rework must not repeat)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = req.query.url;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier assigned from a function call", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = getUserSuppliedUrl();\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier assigned from a member expression", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = settings.remoteEndpoint;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier that is a function parameter", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`async function callWebhook(WEBHOOK_URL) {\n  await fetch(WEBHOOK_URL);\n}\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a member expression (unchanged broad net)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile("ts", `await fetch(settings.endpoint);\n`);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a const reassigned after a literal initializer", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`let TARGET_URL = "https://example.com";\nTARGET_URL = req.query.url;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1000: fixed outbound endpoints built with `new URL(literal, fixedBase)`
	// must not be reported. Origin+path are fully fixed; dynamic query params
	// added via `searchParams.set(...)` do not control the destination.
	it("does not flag fetch of a new URL(literal, file-local const base).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const BASE = "https://api.example.com";\n' +
				'const authUrl = new URL("auth/authorize", `${BASE}/`);\n' +
				'authUrl.searchParams.set("callback_url", cb);\n' +
				"await fetch(authUrl.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a new URL(literal, imported base).toString() with an aliased URL ctor (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'import { URL as NodeURL } from "node:url";\n' +
				'import { BASE_URL_CLINE } from "../../constants.ts";\n' +
				'const authUrl = new NodeURL("auth/authorize", `${BASE_URL_CLINE}/`);\n' +
				'authUrl.searchParams.set("callback_url", cb);\n' +
				"await fetch(authUrl.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a single-arg new URL(literal).href (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("https://api.example.com/v1/userinfo");\n' +
				"await fetch(u.href);\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	// The exemption must NOT neuter real SSRF detection. Each case below MUST
	// still fire — they fail if the new-URL exemption is broadened past "literal
	// path + provably-fixed base".
	it("still flags fetch of new URL(literal, base-from-function-param).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"function f(base) {\n" +
				'  const u = new URL("auth", `${base}/`);\n' +
				"  return fetch(u.toString());\n" +
				"}\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(tainted-path, fixed-base).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL(req.query.next, "https://api.example.com");\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(literal, env-derived const base).toString() (#1000 over-exempt guard)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const BASE = process.env.API_BASE;\n" +
				'const u = new URL("auth", `${BASE}/`);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(user-controlled redirect/location).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const u = new URL(resp.headers.location);\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1008 (BUG 1 — regression the #1000 exemption introduced): mutating the
	// URL receiver's origin/host/path/href AFTER construction re-taints the
	// destination. `new URL(literal, fixedBase)` is only fixed until someone
	// writes `u.host = …`; the const-clean gate must treat any such property or
	// subscript write to the bound receiver as a reassignment and fail closed.
	it("still flags fetch of a new URL const whose host is mutated after construction (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				"u.host = req.query.h;\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a new URL const whose href is mutated after construction (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				"u.href = req.query.u;\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a new URL const whose host is mutated via subscript write (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				'u["host"] = req.query.h;\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1008 (BUG 2 — scope-blind base resolution): a request-tainted function
	// PARAMETER base must not be exempted just because an unrelated same-named
	// module-level `const` literal exists. The param shadows the const at the
	// sink, so the base is attacker-controlled and the sink must fire.
	it("still flags fetch of new URL(literal, param base) shadowing an unrelated same-named file-level const (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const base = "https://api.example.com";\n' +
				"function proxy(base) {\n" +
				'  const u = new URL("/x", `${base}/`);\n' +
				"  return fetch(u.toString());\n" +
				"}\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// Guard against over-correction: query-string-only mutation does not change
	// the origin/host/path, so it must STAY exempt.
	it("does not flag fetch of a new URL const with query-only searchParams mutation (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				'u.searchParams.set("q", req.query.q);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	// Guard against over-correction of BUG 2: a legitimate fixed base `const` in
	// the same (module) scope as the sink, with no shadowing param, must STAY
	// exempt.
	it("does not flag fetch of new URL(literal, same-scope fixed const base) (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const base = "https://api.example.com";\n' +
				'const u = new URL("/x", base);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("matches go path traversal sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-path-traversal");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "os"\nfunc run(base string, userPath string){ os.ReadFile(base + userPath) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go insecure random usage", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-insecure-random");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "math/rand"\nfunc run(){ _ = rand.Intn(10) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches typescript weak hash usage", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-weak-hash");
		const filePath = writeTempFile(
			"ts",
			`import crypto from "crypto";\ncrypto.createHash("md5").update(data);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("loads ruby insecure deserialization rule", async () => {
		const query = await getQuery("ruby-insecure-deserialization");
		expect(query.language).toBe("ruby");
		expect(query.id).toBe("ruby-insecure-deserialization");
	});

	it("loads ruby weak hash and insecure random rules", async () => {
		const weakHash = await getQuery("ruby-weak-hash");
		expect(weakHash.cwe).toContain("CWE-327");
		const weakRandom = await getQuery("ruby-insecure-random");
		expect(weakRandom.cwe).toContain("CWE-330");
	});
});
