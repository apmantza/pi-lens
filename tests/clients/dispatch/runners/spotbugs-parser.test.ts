import { describe, expect, it } from "vitest";
import { parseSpotbugsXml } from "../../../../clients/dispatch/runners/spotbugs.js";

// Mirrors real `spotbugs -textui -xml:withMessages` output (verified against
// SpotBugs 4.10.2 on the dev box): each BugInstance carries class/method/primary
// SourceLines, and the primary one is the defect location. Covers one bug per
// (severity × category) so the priority→severity and category→defectClass maps
// are both exercised (#133).
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<BugCollection version="4.10.2">
  <BugInstance type="NP_ALWAYS_NULL" priority="1" category="CORRECTNESS" cweid="476">
    <ShortMessage>Null pointer dereference</ShortMessage>
    <LongMessage>Null pointer dereference of x in Foo.bar(). It is reachable on some path.</LongMessage>
    <Class classname="Foo" primary="true">
      <SourceLine classname="Foo" start="1" end="20" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
    </Class>
    <Method classname="Foo" name="bar">
      <SourceLine classname="Foo" start="3" end="9" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
    </Method>
    <SourceLine classname="Foo" primary="true" start="7" end="7" sourcefile="Foo.java" sourcepath="com/x/Foo.java" role="SOURCE_LINE_DEREF"/>
  </BugInstance>
  <BugInstance type="DM_NUMBER_CTOR" priority="3" category="PERFORMANCE">
    <ShortMessage>Inefficient number ctor</ShortMessage>
    <LongMessage>Foo.bar() invokes inefficient Integer ctor</LongMessage>
    <SourceLine primary="true" start="12" end="12" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
  </BugInstance>
  <BugInstance type="SQL_INJECTION_JDBC" priority="2" category="SECURITY">
    <ShortMessage>Possible SQL injection</ShortMessage>
    <LongMessage>Foo.bar() passes a nonconstant String to an execute method on an SQL statement</LongMessage>
    <SourceLine primary="true" start="15" end="15" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
  </BugInstance>
  <BugInstance type="IS_INCONSISTENT_SYNC" priority="2" category="MT_CORRECTNESS">
    <ShortMessage>Inconsistent synchronization</ShortMessage>
    <LongMessage>Inconsistent synchronization of Foo.field</LongMessage>
    <SourceLine primary="true" start="18" end="18" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
  </BugInstance>
  <BugInstance type="DE_MIGHT_IGNORE" priority="2" category="BAD_PRACTICE">
    <ShortMessage>Exception ignored</ShortMessage>
    <LongMessage>Foo.bar() might ignore an exception</LongMessage>
    <SourceLine primary="true" start="22" end="22" sourcefile="Foo.java" sourcepath="com/x/Foo.java"/>
  </BugInstance>
  <BugInstance type="NO_SOURCE_LINE_BUG" priority="2" category="CORRECTNESS">
    <ShortMessage>No location</ShortMessage>
    <LongMessage>This one has no SourceLine and must be dropped</LongMessage>
  </BugInstance>
</BugCollection>`;

describe("parseSpotbugsXml (#133)", () => {
	const diags = parseSpotbugsXml(FIXTURE);
	const byRule = new Map(diags.map((d) => [d.rule, d]));

	it("maps SpotBugs priority → severity (1=error, 2=warning, 3=info)", () => {
		expect(byRule.get("NP_ALWAYS_NULL")?.severity).toBe("error");
		expect(byRule.get("SQL_INJECTION_JDBC")?.severity).toBe("warning");
		expect(byRule.get("DM_NUMBER_CTOR")?.severity).toBe("info");
	});

	it("maps SpotBugs category → pi-lens defectClass", () => {
		expect(byRule.get("NP_ALWAYS_NULL")?.defectClass).toBe("correctness");
		expect(byRule.get("IS_INCONSISTENT_SYNC")?.defectClass).toBe("correctness"); // MT_CORRECTNESS
		expect(byRule.get("SQL_INJECTION_JDBC")?.defectClass).toBe("safety"); // SECURITY
		expect(byRule.get("DM_NUMBER_CTOR")?.defectClass).toBe("style"); // PERFORMANCE
		expect(byRule.get("DE_MIGHT_IGNORE")?.defectClass).toBe("style"); // BAD_PRACTICE
	});

	it("uses the primary SourceLine for the defect location, not the class span", () => {
		// Class span is 1-20, method 3-9; the primary deref is line 7.
		expect(byRule.get("NP_ALWAYS_NULL")?.line).toBe(7);
		expect(byRule.get("NP_ALWAYS_NULL")?.filePath).toBe("com/x/Foo.java");
	});

	it("keeps every bug advisory (semantic=warning) regardless of severity", () => {
		for (const d of diags) expect(d.semantic).toBe("warning");
	});

	it("surfaces the first sentence of the LongMessage as fixSuggestion + sets rule/tool", () => {
		const np = byRule.get("NP_ALWAYS_NULL");
		expect(np?.tool).toBe("spotbugs");
		expect(np?.rule).toBe("NP_ALWAYS_NULL");
		expect(np?.fixSuggestion).toBe("Null pointer dereference of x in Foo.bar().");
		expect(np?.fixKind).toBe("suggestion");
	});

	it("drops bug instances with no source mapping", () => {
		expect(byRule.has("NO_SOURCE_LINE_BUG")).toBe(false);
		expect(diags).toHaveLength(5);
	});
});
