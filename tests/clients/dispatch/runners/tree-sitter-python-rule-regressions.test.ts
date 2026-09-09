import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";

const { recordEntitySnapshotDiffMock } = vi.hoisted(() => ({
	recordEntitySnapshotDiffMock: vi.fn(() => ({
		added: [] as string[],
		removed: [] as string[],
		modified: [] as string[],
	})),
}));

vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: recordEntitySnapshotDiffMock,
	}),
);

import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

let env: RealRunnerEnv;

beforeAll(async () => {
	env = makeRealRunnerEnv();
	await assertGrammarAvailable("python");
});
afterAll(() => env?.cleanup());

function messageFor(
	diagnostics: Awaited<ReturnType<typeof treeSitterRunner.run>>["diagnostics"],
	rule: string,
): string {
	const diagnostic = diagnostics.find((candidate) => candidate.rule === rule);
	if (!diagnostic) throw new Error(`missing ${rule} diagnostic`);
	return diagnostic.message;
}

describe("tree-sitter Python rule regressions (#2576)", () => {
	it("runs the production YAML rules and renders their capture messages", async () => {
		const hallucinated = env.addFile(
			"hallucinated.py",
			"from requests import JSONResponse\n",
		);
		const crossLanguage = env.addFile(
			"cross-language.py",
			"items.push(item)\n",
		);
		const sqlInjection = env.addFile(
			"raw-sql.py",
			"def find(session):\n    return session.query(Model)\n",
		);

		const [hallucinatedResult, crossLanguageResult, sqlInjectionResult] =
			await Promise.all([
				treeSitterRunner.run(hallucinated.ctx),
				treeSitterRunner.run(crossLanguage.ctx),
				treeSitterRunner.run(sqlInjection.ctx),
			]);

		expect(firedRuleIds(hallucinatedResult)).toContain(
			"python-hallucinated-import",
		);
		expect(
			messageFor(hallucinatedResult.diagnostics, "python-hallucinated-import"),
		).toBe("Hallucinated import — 'JSONResponse' does not exist in 'requests'");
		expect(firedRuleIds(crossLanguageResult)).toContain(
			"python-cross-language-method",
		);
		expect(
			messageFor(
				crossLanguageResult.diagnostics,
				"python-cross-language-method",
			),
		).toBe(
			"'push' is not a Python method — likely a cross-language idiom leaking in",
		);
		expect(firedRuleIds(sqlInjectionResult)).toContain("python-sql-injection");
		expect(
			messageFor(sqlInjectionResult.diagnostics, "python-sql-injection"),
		).toBe("Potential SQL injection sink — use parameterized queries");
	}, 30_000);

	it("suppresses only production-proven Python SQL safe forms", async () => {
		const safeSession = env.addFile(
			"safe-session.py",
			"from sqlalchemy.orm import Session\ndef find(db: Session):\n    return db.query(Model)\n",
		);
		const safeSessionAlias = env.addFile(
			"safe-session-alias.py",
			"from sqlalchemy.orm import Session as DbSession\ndef find(db: DbSession):\n    return db.query(Model)\n",
		);
		const safePsycopg = env.addFile(
			"safe-psycopg.py",
			'from psycopg import sql\ncursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n',
		);
		const safePsycopgAlias = env.addFile(
			"safe-psycopg-alias.py",
			'import psycopg2 as pg\ncursor.execute(pg.sql.SQL("SELECT * FROM {}").format(pg.sql.Identifier(table)))\n',
		);
		const safeConstructors = env.addFile(
			"safe-constructors.py",
			'from psycopg.sql import SQL as Query, Identifier as Ident\ncursor.execute(Query("SELECT * FROM {}").format(Ident(table)))\n',
		);
		const results = await Promise.all([
			treeSitterRunner.run(safeSession.ctx),
			treeSitterRunner.run(safeSessionAlias.ctx),
			treeSitterRunner.run(safePsycopg.ctx),
			treeSitterRunner.run(safePsycopgAlias.ctx),
			treeSitterRunner.run(safeConstructors.ctx),
		]);

		for (const result of results) {
			expect(firedRuleIds(result)).not.toContain("python-sql-injection");
		}
	}, 30_000);

	it("suppresses the four production consumer shapes but not unsafe lookalikes", async () => {
		const sessionQueries = env.addFile(
			"consumer-session.py",
			`from sqlalchemy.orm import Session

def accessible_lessons(session: Session, user_id):
    rows = session.query(Lesson).filter(Lesson.user_id == user_id).all()
    progress = {item.id: item for item in session.query(LessonProgress).filter(LessonProgress.user_id == user_id).all()}
    for lesson, week_id, _, version_id in rows:
        pass
    return progress
`,
		);
		const psycopgCommands = env.addFile(
			"consumer-psycopg.py",
			`import psycopg
from psycopg import sql

def create_and_drop(url, name):
    with psycopg.connect(url) as admin, admin.cursor() as cursor:
        cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    with psycopg.connect(url) as admin, admin.cursor() as cursor:
        cursor.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(name)))
`,
		);
		const unsafeSession = env.addFile(
			"consumer-session-rebound.py",
			`from sqlalchemy.orm import Session

def accessible_lessons(session: Session):
    for lesson, week_id, _, version_id in rows:
        pass
    session = unsafe_session
    return session.query(Lesson)
`,
		);
		const unsafePsycopg = env.addFile(
			"consumer-psycopg-dynamic.py",
			`from psycopg import sql
cursor.execute(sql.SQL(template).format(sql.Identifier(name)))
`,
		);
		const results = await Promise.all([
			treeSitterRunner.run(sessionQueries.ctx),
			treeSitterRunner.run(psycopgCommands.ctx),
			treeSitterRunner.run(unsafeSession.ctx),
			treeSitterRunner.run(unsafePsycopg.ctx),
		]);
		for (const result of results.slice(0, 2)) {
			expect(firedRuleIds(result)).not.toContain("python-sql-injection");
			expect(firedRuleIds(result)).not.toContain(
				"python-cross-language-method",
			);
		}
		for (const result of results.slice(2)) {
			expect(firedRuleIds(result)).toContain("python-sql-injection");
		}
	}, 30_000);

	it("keeps production keyword-pattern captures diagnostic without tainting keyword names", async () => {
		const sqlCapture = env.addFile(
			"keyword-pattern-sql.py",
			`from psycopg import sql
def run(value):
    match value:
        case Wrapper(sql=sql):
            pass
    cursor.execute(sql.SQL("SELECT {} ").format(sql.Identifier(table)))
`,
		);
		const sessionCapture = env.addFile(
			"keyword-pattern-session.py",
			`from sqlalchemy.orm import Session
def run(value, db: Session):
    match value:
        case Wrapper(session=Session):
            pass
    return db.query(Model)
`,
		);
		const nonBindingPatterns = env.addFile(
			"keyword-pattern-non-binding.py",
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
		const results = await Promise.all([
			treeSitterRunner.run(sqlCapture.ctx),
			treeSitterRunner.run(sessionCapture.ctx),
			treeSitterRunner.run(nonBindingPatterns.ctx),
		]);
		for (const result of results.slice(0, 2)) {
			expect(firedRuleIds(result)).toContain("python-sql-injection");
		}
		expect(firedRuleIds(results[2]!)).not.toContain("python-sql-injection");
	}, 30_000);

	it("keeps production provenance fail-closed across namespace and binder hazards", async () => {
		const sink =
			'cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))';
		const cases = [
			[
				"walrus.py",
				`from psycopg import sql\ndef run():\n    [(sql := unsafe_sql) for _ in values]\n    ${sink}`,
			],
			["star.py", `from psycopg import sql\nfrom plugin import *\n${sink}`],
			[
				"dynamic.py",
				`from psycopg import sql\nglobals()["sql"] = unsafe_sql\n${sink}`,
			],
			[
				"class-comprehension.py",
				`class C:\n    from psycopg import sql\n    rows = [${sink} for table in tables]`,
			],
			[
				"assignment-alias.py",
				`from psycopg import sql\nalias = sql\ncursor.execute(alias.SQL("SELECT * FROM {}").format(alias.Identifier(table)))`,
			],
			[
				"eight-hop.py",
				`from psycopg import sql\na1 = sql\na2 = a1\na3 = a2\na4 = a3\na5 = a4\na6 = a5\na7 = a6\na8 = a7\ncursor.execute(a8.SQL("SELECT * FROM {}").format(a8.Identifier(table)))`,
			],
			[
				"global.py",
				`from psycopg import sql\ndef run():\n    global sql\n    ${sink}`,
			],
			[
				"nonlocal.py",
				`from psycopg import sql\ndef outer():\n    def run():\n        nonlocal sql\n        ${sink}\n    return run`,
			],
			// A parse error anywhere invalidates the whole summary: provenance
			// cannot be read off a tree the grammar did not accept (#2577 F4).
			[
				"parse-error.py",
				`from sqlalchemy.orm import Session\nfrom models import User\ndef find(db: Session):\n    return db.query(User)\ndef broken(`,
			],
		];
		const results = await Promise.all(
			cases.map(([name, source]) =>
				treeSitterRunner.run(env.addFile(name, source).ctx),
			),
		);
		for (const result of results) {
			expect(firedRuleIds(result)).toContain("python-sql-injection");
		}
	}, 30_000);

	it("fails closed when production SQL provenance is absent, shadowed, rebound, or late", async () => {
		const safeSessionAliasChain = env.addFile(
			"safe-session-alias-chain.py",
			"from sqlalchemy.orm import Session\nDbSession = Session\ndef find(db: DbSession):\n    return db.query(Model)\n",
		);
		const safePsycopgConstructorAliasChain = env.addFile(
			"safe-psycopg-constructor-alias-chain.py",
			'from psycopg2.sql import SQL, Identifier\nQuery = SQL\nIdent = Identifier\ncursor.execute(Query("SELECT * FROM {}").format(Ident(table)))\n',
		);
		const reboundReceiver = env.addFile(
			"rebound-session-receiver.py",
			"from sqlalchemy.orm import Session\ndef find(db: Session):\n    db = unsafe_receiver\n    return db.query(Model)\n",
		);
		const innerPsycopgShadow = env.addFile(
			"shadowed-psycopg.py",
			'from psycopg import sql\ndef run():\n    sql = unsafe_sql\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n',
		);
		const latePsycopgImport = env.addFile(
			"late-psycopg-import.py",
			'cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\nfrom psycopg import sql\n',
		);
		const fromPsycopgPackage = env.addFile(
			"from-psycopg-package.py",
			'from psycopg import psycopg\ncursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))\n',
		);
		const fromPsycopg2Package = env.addFile(
			"from-psycopg2-package.py",
			'from psycopg2 import psycopg2\ncursor.execute(psycopg2.sql.SQL("SELECT * FROM {}").format(psycopg2.sql.Identifier(table)))\n',
		);
		const results = await Promise.all([
			treeSitterRunner.run(safeSessionAliasChain.ctx),
			treeSitterRunner.run(safePsycopgConstructorAliasChain.ctx),
			treeSitterRunner.run(reboundReceiver.ctx),
			treeSitterRunner.run(innerPsycopgShadow.ctx),
			treeSitterRunner.run(latePsycopgImport.ctx),
			treeSitterRunner.run(fromPsycopgPackage.ctx),
			treeSitterRunner.run(fromPsycopg2Package.ctx),
		]);

		for (const result of results) {
			expect(firedRuleIds(result)).toContain("python-sql-injection");
		}
	}, 30_000);

	it("keeps production SQL provenance lexical across scopes and bounded aliases", async () => {
		const parameterShadow = env.addFile(
			"parameter-shadow.py",
			'from psycopg import sql\ndef run(sql):\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n',
		);
		const comprehensionShadow = env.addFile(
			"comprehension-shadow.py",
			'from psycopg import sql\nresults = [cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources]\n',
		);
		const lateLocalBinding = env.addFile(
			"late-local-binding.py",
			'from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    sql = unsafe_sql\n',
		);
		const classImport = env.addFile(
			"class-import.py",
			'class Repository:\n    import psycopg\n    def run(self):\n        cursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))\n',
		);
		const moduleImport = env.addFile(
			"module-import.py",
			'import psycopg\nclass Repository:\n    def run(self):\n        cursor.execute(psycopg.sql.SQL("SELECT * FROM {}").format(psycopg.sql.Identifier(table)))\n',
		);
		const sessionParameterShadow = env.addFile(
			"session-parameter-shadow.py",
			"from sqlalchemy.orm import Session\ndef outer(Session):\n    def find(db: Session):\n        return db.query(Model)\n    return find\n",
		);
		const boundedAliases = env.addFile(
			"bounded-aliases.py",
			'from psycopg import sql\nfirst = sql\nsecond = first\nthird = second\ncursor.execute(third.SQL("SELECT * FROM {}").format(third.Identifier(table)))\n',
		);
		const results = await Promise.all([
			treeSitterRunner.run(parameterShadow.ctx),
			treeSitterRunner.run(comprehensionShadow.ctx),
			treeSitterRunner.run(lateLocalBinding.ctx),
			treeSitterRunner.run(classImport.ctx),
			treeSitterRunner.run(moduleImport.ctx),
			treeSitterRunner.run(sessionParameterShadow.ctx),
			treeSitterRunner.run(boundedAliases.ctx),
		]);

		for (const result of [
			results[0],
			results[1],
			results[2],
			results[3],
			results[5],
			results[6],
		]) {
			expect(firedRuleIds(result!)).toContain("python-sql-injection");
		}
		expect(firedRuleIds(results[4]!)).not.toContain("python-sql-injection");
	}, 30_000);

	it("fails closed for production binder inventory and alias boundaries", async () => {
		const withAs = env.addFile(
			"with-as.py",
			'from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    with connection.cursor() as sql:\n        pass\n',
		);
		const exceptAs = env.addFile(
			"except-as.py",
			'from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    try:\n        pass\n    except Error as sql:\n        pass\n',
		);
		const matchCapture = env.addFile(
			"match-capture.py",
			'from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    match value:\n        case sql:\n            pass\n',
		);
		const destructuring = env.addFile(
			"destructuring.py",
			'from psycopg import sql\ndef run():\n    cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table)))\n    first, (sql, last) = values\n',
		);
		const comprehension = env.addFile(
			"comprehension-binder.py",
			'from psycopg import sql\nresults = [cursor.execute(sql.SQL("SELECT * FROM {}").format(sql.Identifier(table))) for sql in sources]\n',
		);
		const aliases = (count: number) =>
			Array.from({ length: count }, (_, index) => {
				const name = `a${index + 1}`;
				return `${name} = ${index === 0 ? "sql" : `a${index}`}`;
			}).join("\n");
		const eightHops = env.addFile(
			"eight-alias-hops.py",
			`from psycopg import sql\n${aliases(8)}\ncursor.execute(a8.SQL("SELECT * FROM {}").format(a8.Identifier(table)))\n`,
		);
		const nineHops = env.addFile(
			"nine-alias-hops.py",
			`from psycopg import sql\n${aliases(9)}\ncursor.execute(a9.SQL("SELECT * FROM {}").format(a9.Identifier(table)))\n`,
		);
		const results = await Promise.all([
			treeSitterRunner.run(withAs.ctx),
			treeSitterRunner.run(exceptAs.ctx),
			treeSitterRunner.run(matchCapture.ctx),
			treeSitterRunner.run(destructuring.ctx),
			treeSitterRunner.run(comprehension.ctx),
			treeSitterRunner.run(eightHops.ctx),
			treeSitterRunner.run(nineHops.ctx),
		]);

		for (const result of results) {
			expect(firedRuleIds(result!)).toContain("python-sql-injection");
		}
	}, 30_000);
	it("keeps canonical SQLAlchemy 2.x statement execution quiet (#2577 review)", async () => {
		const executeSelect = env.addFile(
			"sa-execute-select.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session):
    return db.execute(select(User)).all()
`,
		);
		const scalarsSelect = env.addFile(
			"sa-scalars-select.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session):
    return db.scalars(select(User)).all()
`,
		);
		const scalarSelect = env.addFile(
			"sa-scalar-select.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session):
    return db.scalar(select(User))
`,
		);
		const asyncExecuteSelect = env.addFile(
			"sa-async-execute-select.py",
			`from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

async def find(db: AsyncSession):
    return await db.execute(select(User))
`,
		);
		const boundStatement = env.addFile(
			"sa-bound-statement.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session):
    stmt = select(User)
    return db.execute(stmt)
`,
		);
		const fastApiDependency = env.addFile(
			"sa-fastapi-dependency.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session = Depends(get_db)):
    stmt = select(User)
    return db.execute(stmt).all()
`,
		);
		const unprovableReceiver = env.addFile(
			"sa-unprovable-receiver.py",
			`from sqlalchemy import select

def rows(conn):
    return conn.execute(select(User))
`,
		);
		const unannotatedReceiver = env.addFile(
			"sa-unannotated-session.py",
			`def find(session, stmt):
    return session.execute(stmt)
`,
		);
		const staticText = env.addFile(
			"sa-static-text.py",
			`from sqlalchemy import text
from sqlalchemy.orm import Session

def find(db: Session):
    return db.execute(text("SELECT 1"))
`,
		);

		const fixtures = {
			"db.execute(select(User))": executeSelect,
			"db.scalars(select(User))": scalarsSelect,
			"db.scalar(select(User))": scalarSelect,
			"await db.execute(select(User)) on AsyncSession": asyncExecuteSelect,
			"stmt = select(User); db.execute(stmt)": boundStatement,
			"db: Session = Depends(get_db); db.execute(stmt)": fastApiDependency,
			"unannotated session.execute(stmt)": unannotatedReceiver,
			"conn.execute(select(User)) on an unprovable receiver":
				unprovableReceiver,
			'db.execute(text("SELECT 1"))': staticText,
		};
		const results = await Promise.all(
			Object.entries(fixtures).map(
				async ([label, fixture]) =>
					[label, await treeSitterRunner.run(fixture.ctx)] as const,
			),
		);
		for (const [label, result] of results) {
			expect
				.soft(firedRuleIds(result), label)
				.not.toContain("python-sql-injection");
		}
	}, 30_000);

	it("keeps composed SQL strings diagnostic in SQLAlchemy sinks (#2577 review)", async () => {
		const rawConcat = env.addFile(
			"raw-concat.py",
			`cursor.execute("SELECT * FROM users WHERE id = " + uid)
`,
		);
		const percentFormat = env.addFile(
			"raw-percent.py",
			`cursor.execute("SELECT * FROM users WHERE id = %s" % uid)
`,
		);
		const textConcat = env.addFile(
			"raw-text-concat.py",
			`from sqlalchemy import text
from sqlalchemy.orm import Session

def find(db: Session, uid):
    return db.execute(text("SELECT * FROM users WHERE id = " + uid))
`,
		);
		const textFormat = env.addFile(
			"raw-text-format.py",
			`from sqlalchemy import text
from sqlalchemy.orm import Session

def find(db: Session, uid):
    return db.execute(text("SELECT * FROM users WHERE id = {}".format(uid)))
`,
		);
		const opaqueStatement = env.addFile(
			"raw-opaque-statement.py",
			`from sqlalchemy.orm import Session

def run(db: Session, statement):
    return db.execute(statement)
`,
		);
		const reboundStatement = env.addFile(
			"raw-rebound-statement.py",
			`from sqlalchemy import select
from sqlalchemy.orm import Session

def find(db: Session, tainted):
    stmt = tainted
    stmt = select(User)
    return db.execute(stmt)
`,
		);

		const fixtures = {
			"cursor.execute('...' + uid)": rawConcat,
			"cursor.execute('...' % uid)": percentFormat,
			'db.execute(text("..." + uid))': textConcat,
			'db.execute(text("...".format(uid)))': textFormat,
			"db.execute(opaque_parameter)": opaqueStatement,
			"stmt bound twice — tainted, then select()": reboundStatement,
		};
		const results = await Promise.all(
			Object.entries(fixtures).map(
				async ([label, fixture]) =>
					[label, await treeSitterRunner.run(fixture.ctx)] as const,
			),
		);
		for (const [label, result] of results) {
			expect
				.soft(firedRuleIds(result), label)
				.toContain("python-sql-injection");
		}
	}, 30_000);
	it("keeps composed and opaque Session.query arguments diagnostic (#2577 round 2)", async () => {
		// F1: a proven Session receiver must not suppress `query` regardless of
		// what it is handed. `Session.query` takes mapped classes, so an entity
		// name stays quiet while SQL text or an opaque local value does not.
		const header = `from sqlalchemy import text
from sqlalchemy.orm import Session
from models import User

`;
		const fires = {
			"c01 db.query('...' + uid)": env.addFile(
				"q-c01-concat.py",
				`${header}def find(db: Session, uid):
    return db.query("SELECT * FROM t WHERE id=" + uid)
`,
			),
			"c02 db.query(text('...' + uid))": env.addFile(
				"q-c02-text-concat.py",
				`${header}def find(db: Session, uid):
    return db.query(text("SELECT * FROM t WHERE id=" + uid))
`,
			),
			"c03 db.query('...' % uid)": env.addFile(
				"q-c03-percent.py",
				`${header}def find(db: Session, uid):
    return db.query("SELECT * FROM t WHERE id=%s" % uid)
`,
			),
			"x2 q = build_sql(uid); db.query(q)": env.addFile(
				"q-x2-bound-to-call.py",
				`${header}def find(db: Session, uid):
    q = build_sql(uid)
    return db.query(q)
`,
			),
			// Accepted noise: a model built at runtime is indistinguishable from
			// x2 statically, and losing x2 is the worse trade (#2577 round 3 N-2).
			"n1 User = get_model(); db.query(User) — accepted noise": env.addFile(
				"q-n1-dynamic-model.py",
				`from sqlalchemy.orm import Session

def find(db: Session):
    User = get_model()
    return db.query(User)
`,
			),
			"c06 db.query(opaque_parameter)": env.addFile(
				"q-c06-opaque.py",
				`${header}def find(db: Session, q):
    return db.query(q)
`,
			),
		};
		const quiet = {
			"c04 db.query(User)": env.addFile(
				"q-c04-entity.py",
				`${header}def find(db: Session):
    return db.query(User)
`,
			),
			"c05 db.query(User).filter(...)": env.addFile(
				"q-c05-entity-filter.py",
				`${header}def find(db: Session, uid):
    return db.query(User).filter(User.id == uid).all()
`,
			),
		};
		const results = await Promise.all(
			[...Object.entries(fires), ...Object.entries(quiet)].map(
				async ([label, fixture]) =>
					[label, await treeSitterRunner.run(fixture.ctx)] as const,
			),
		);
		for (const [label, result] of results) {
			const expectation = expect.soft(firedRuleIds(result), label);
			if (label.startsWith("c04") || label.startsWith("c05")) {
				expectation.not.toContain("python-sql-injection");
			} else {
				expectation.toContain("python-sql-injection");
			}
		}
	}, 30_000);

	it("keeps builder-shaped laundering diagnostic (#2577 round 2)", async () => {
		// F2: an attribute callee counts as a statement builder only when its
		// object is a proven sqlalchemy import, and no builder call launders a
		// composed SQL string.
		// Nine wrappers put the concatenation one level past
		// EXPRESSION_DEPTH_CAP, where carriesComposedSql must fail CLOSED.
		const deepWrap = (inner: string, depth: number) =>
			`${Array.from({ length: depth }, (_, index) => `f${index + 1}(`).join(
				"",
			)}${inner}${")".repeat(depth)}`;
		const fires = {
			"d1 composed SQL nested past EXPRESSION_DEPTH_CAP": env.addFile(
				"b-d1-deep-composed.py",
				`import sqlalchemy as sa
from sqlalchemy.orm import Session

def find(db: Session, uid):
    return db.execute(sa.select(${deepWrap('"SELECT * FROM t WHERE id=" + uid', 9)}))
`,
			),
			"w1 db.execute(repo.update('...' + uid))": env.addFile(
				"b-w1-repo-update.py",
				`from sqlalchemy.orm import Session

def find(db: Session, repo, uid):
    return db.execute(repo.update("UPDATE t SET x=" + uid))
`,
			),
			"w2 db.execute(repo.delete('...' + uid))": env.addFile(
				"b-w2-repo-delete.py",
				`from sqlalchemy.orm import Session

def find(db: Session, repo, uid):
    return db.execute(repo.delete("DELETE FROM t WHERE id=" + uid))
`,
			),
			"w3 stmt = repo.update('...' + uid); db.execute(stmt)": env.addFile(
				"b-w3-bound-repo-update.py",
				`from sqlalchemy.orm import Session

def find(db: Session, repo, uid):
    stmt = repo.update("UPDATE t SET x=" + uid)
    return db.execute(stmt)
`,
			),
			"w5 unproven receiver, repo.update('...' + uid)": env.addFile(
				"b-w5-unproven-receiver.py",
				`def find(conn, repo, uid):
    return conn.execute(repo.update("UPDATE t SET x=" + uid))
`,
			),
			"w7 db.execute(repo.update(value)) — unproven module": env.addFile(
				"b-w7-repo-update-opaque.py",
				`from sqlalchemy.orm import Session

def find(db: Session, repo, value):
    return db.execute(repo.update(value))
`,
			),
			"w6 db.execute(sa.select('...' + uid))": env.addFile(
				"b-w6-sa-select-concat.py",
				`import sqlalchemy as sa
from sqlalchemy.orm import Session

def find(db: Session, uid):
    return db.execute(sa.select("SELECT * FROM t WHERE id=" + uid))
`,
			),
			"sa.text('...' + uid)": env.addFile(
				"b-sa-text-concat.py",
				`import sqlalchemy as sa
from sqlalchemy.orm import Session

def find(db: Session, uid):
    return db.execute(sa.text("SELECT * FROM t WHERE id=" + uid))
`,
			),
		};
		const quiet = {
			"w4 db.execute(sa.select(User))": env.addFile(
				"b-w4-sa-select.py",
				`import sqlalchemy as sa
from sqlalchemy.orm import Session
from models import User

def find(db: Session):
    return db.execute(sa.select(User))
`,
			),
		};
		const results = await Promise.all(
			[...Object.entries(fires), ...Object.entries(quiet)].map(
				async ([label, fixture]) =>
					[label, await treeSitterRunner.run(fixture.ctx)] as const,
			),
		);
		for (const [label, result] of results) {
			const expectation = expect.soft(firedRuleIds(result), label);
			if (label.startsWith("w4")) {
				expectation.not.toContain("python-sql-injection");
			} else {
				expectation.toContain("python-sql-injection");
			}
		}
	}, 30_000);
});
