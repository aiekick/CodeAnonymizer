import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { anonymize } from "../src/core/anonymizer";
import { parseConfig } from "../src/core/config";
import { RULES_TEMPLATE } from "../src/core/template";

function run(a_text: string, a_rules: unknown[], a_languageId = "cpp", a_forbidden: string[] = []) {
  const config = parseConfig(JSON.stringify({ rules: a_rules, forbidden: a_forbidden }));
  assert.deepEqual(config.errors, []);
  return anonymize(a_text, config, { languageId: a_languageId, relativePath: "src/main.cpp" });
}

function output(a_text: string, a_rules: unknown[], a_languageId = "cpp"): string {
  return run(a_text, a_rules, a_languageId).text;
}

describe("replace", () => {
  test("literal, with $ kept as is", () => {
    assert.equal(output("TOTO::te_uint32_type a;", [{ type: "replace", find: "TOTO::te_uint32_type", replace: "uint32_t" }]), "uint32_t a;");
    assert.equal(output("a.b", [{ type: "replace", find: ".", replace: "$1" }]), "a$1b");
  });

  test("regex with groups, case insensitive", () => {
    assert.equal(
      output("AcmeClient acmeServer", [{ type: "replace", find: "acme(\\w+)", replace: "X$1", regex: true, caseSensitive: false }]),
      "XClient XServer"
    );
  });

  test("whole word", () => {
    assert.equal(output("ab abc ab", [{ type: "replace", find: "ab", replace: "x", wholeWord: true }]), "x abc x");
  });

  test("restricted to comments", () => {
    assert.equal(
      output('acme(); // acme\nf("acme");', [{ type: "replace", find: "acme", replace: "x", in: "comment" }]),
      'acme(); // x\nf("acme");'
    );
  });

  test("counts the replacements", () => {
    assert.equal(run("a a a", [{ type: "replace", find: "a", replace: "b" }]).changes, 3);
  });
});

describe("replaceMap", () => {
  test("replaces a token inside a word, by nothing", () => {
    assert.equal(output("TOTO_toto TOTO_x", [{ type: "replaceMap", map: { TOTO_: "" } }]), "toto x");
  });

  test("wildcards: * is the rest of an identifier, captured as $1", () => {
    assert.equal(
      output("TOTO_toto TOTO_x a.TOTO_b", [{ type: "replaceMap", wildcard: true, map: { "TOTO_*": "$1" } }]),
      "toto x a.b"
    );
  });

  test("wildcards: most specific key first, ? is one character", () => {
    assert.equal(
      output("te_uint32_type te_int8_type te_u8 te_u16", [
        { type: "replaceMap", wildcard: true, wholeWord: true, map: { "te_*": "X", "te_*_type": "$1_t", "te_u?": "U$1" } }
      ]),
      "uint32_t int8_t U8 X"
    );
  });

  test("wildcards: per entry, and a literal star", () => {
    assert.equal(
      output("A_x te_u32* te_u32", [
        { type: "replaceMap", map: { "A_*": { replace: "", wildcard: true }, "te_u32*": "uint32_t*", "te_u32": "uint32_t" } }
      ]),
      " uint32_t* uint32_t"
    );
    assert.equal(
      output("a* ab", [{ type: "replaceMap", wildcard: true, map: { "a\\*": "S" } }]),
      "S ab"
    );
  });

  test("wildcards: case insensitive, whole word", () => {
    assert.equal(
      output("toto_A xTOTO_B TOTO_C", [{ type: "replaceMap", wildcard: true, wholeWord: true, caseSensitive: false, map: { "TOTO_*": "$1" } }]),
      "A xTOTO_B C"
    );
  });

  test("an entry overrides the wholeWord of the rule", () => {
    assert.equal(
      output("TOTO_u32 TOTO_toto u32x", [
        { type: "replaceMap", wholeWord: true, map: { TOTO_u32: "uint32_t", u32: "X", TOTO_: { replace: "", wholeWord: false } } }
      ]),
      "uint32_t toto u32x"
    );
  });

  test("longest token first", () => {
    assert.equal(
      output("te_u32 te_u32_ptr", [{ type: "replaceMap", map: { te_u32: "uint32_t", te_u32_ptr: "uint32_t*" } }]),
      "uint32_t uint32_t*"
    );
  });
});

describe("removeLines", () => {
  test("removes matching lines", () => {
    assert.equal(
      output('#include "acme/x.h"\n#include <vector>\n', [{ type: "removeLines", match: "acme/" }]),
      "#include <vector>\n"
    );
  });
});

describe("removeBlock", () => {
  const text = "a\n  // BEGIN\n  secret\n  // END\nb\n";

  test("removes the markers and their content, inserts the replacement indented", () => {
    assert.equal(
      output(text, [{ type: "removeBlock", begin: "BEGIN", end: "END", replace: "// removed" }]),
      "a\n  // removed\nb\n"
    );
  });

  test("keepMarkers", () => {
    assert.equal(
      output(text, [{ type: "removeBlock", begin: "BEGIN", end: "END", keepMarkers: true }]),
      "a\n  // BEGIN\n  // END\nb\n"
    );
  });

  test("an unterminated block removes up to the end of the file", () => {
    const result = run("a\n// BEGIN\nsecret\nmore", [{ type: "removeBlock", begin: "BEGIN", end: "END" }]);
    assert.equal(result.text, "a");
    assert.equal(result.rules[0].warnings.length, 1);
  });

  test("keeps CRLF line endings", () => {
    assert.equal(
      output("a\r\n// BEGIN\r\nx\r\n// END\r\nb", [{ type: "removeBlock", begin: "BEGIN", end: "END", replace: "r" }]),
      "a\r\nr\r\nb"
    );
  });
});

describe("removeHeader", () => {
  test("removes a license block, keeps a non matching doc comment", () => {
    const text = "/*\n * Copyright (c) ACME\n */\n\n/// @file main.cpp\n\n#include <x>\n";
    assert.equal(output(text, [{ type: "removeHeader" }]), "/// @file main.cpp\n\n#include <x>\n");
  });

  test("consecutive line comments form one group", () => {
    const text = "// Copyright ACME\n// Licensed under...\nint a;\n";
    assert.equal(output(text, [{ type: "removeHeader" }]), "int a;\n");
  });

  test("replacement", () => {
    const text = "# License: proprietary\n\nimport os\n";
    assert.equal(output(text, [{ type: "removeHeader", replace: "# MIT" }], "python"), "# MIT\n\nimport os\n");
  });

  test("nothing removed without a match", () => {
    const text = "// hello\nint a;\n";
    assert.equal(output(text, [{ type: "removeHeader" }]), text);
  });
});

describe("removeComments", () => {
  test("drops full comment lines, trims trailing ones, keeps strings", () => {
    const text = '// full line\nint a; // trailing\n/* multi\n line */\nf("// not a comment");\n';
    assert.equal(output(text, [{ type: "removeComments" }]), 'int a;\nf("// not a comment");\n');
  });

  test("keep", () => {
    const text = "// TODO: keep\n// drop\nx\n";
    assert.equal(output(text, [{ type: "removeComments", keep: "TODO" }]), "// TODO: keep\nx\n");
  });
});

describe("removeFunctionBody", () => {
  const rule = { type: "removeFunctionBody", name: "compute\\w*", replace: "// removed" };

  test("empties definitions, keeps declarations and calls", () => {
    const text = [
      "int computeKey(int a);",
      "int computeKey(int a) {",
      "    if (a) { return a * 42; }",
      '    return 7; // "}"',
      "}",
      "void f() {",
      "    if (computeKey(3)) { g(); }",
      "    x = obj.computeKey(1);",
      "}"
    ].join("\n");
    assert.equal(
      output(text, [rule]),
      [
        "int computeKey(int a);",
        "int computeKey(int a) {",
        "    // removed",
        "}",
        "void f() {",
        "    if (computeKey(3)) { g(); }",
        "    x = obj.computeKey(1);",
        "}"
      ].join("\n")
    );
  });

  test("qualified names, qualifiers and initializer lists", () => {
    const text = [
      "  auto Crypto::computeHash(const T& a) const noexcept -> int",
      "  {",
      "      return a;",
      "  }",
      "Crypto::Crypto() : m_a(1), m_b{2} { secret(); }"
    ].join("\n");
    const result = output(text, [{ type: "removeFunctionBody", name: "Crypto::\\w+", replace: "// removed" }]);
    assert.equal(
      result,
      [
        "  auto Crypto::computeHash(const T& a) const noexcept -> int",
        "  {",
        "      // removed",
        "  }",
        "Crypto::Crypto() : m_a(1), m_b{2} {",
        "    // removed",
        "}"
      ].join("\n")
    );
  });

  test("python", () => {
    const text = [
      "class A:",
      "    def compute(self, x) -> int:",
      '        """doc"""',
      "",
      "        return x * 2",
      "",
      "    def other(self): return 1",
      "def compute_fast(): return 3"
    ].join("\n");
    assert.equal(
      output(text, [{ type: "removeFunctionBody", name: "compute\\w*" }], "python"),
      [
        "class A:",
        "    def compute(self, x) -> int:",
        "        pass  # body removed",
        "",
        "    def other(self): return 1",
        "def compute_fast(): pass  # body removed"
      ].join("\n")
    );
  });
});

describe("pseudonymize", () => {
  test("same name, same alias", () => {
    const result = run("AcmeA AcmeB AcmeA", [{ type: "pseudonymize", match: "Acme\\w+", template: "P{n}" }]);
    assert.equal(result.text, "P1 P2 P1");
    assert.deepEqual(
      result.pseudonyms.map((a_entry) => [a_entry.original, a_entry.alias]),
      [["AcmeA", "P1"], ["AcmeB", "P2"]]
    );
  });
});

describe("anonymize", () => {
  test("rules run in order, filters apply", () => {
    const result = run("abc", [
      { type: "replace", find: "a", replace: "x" },
      { type: "replace", find: "x", replace: "y" },
      { type: "replace", find: "b", replace: "z", languages: "python" },
      { type: "replace", find: "c", replace: "z", files: "*.h" },
      { type: "replace", find: "c", replace: "w", enabled: false }
    ]);
    assert.equal(result.text, "ybc");
    assert.deepEqual(result.rules.map((a_rule) => a_rule.applied), [true, true, false, false, false]);
  });

  test("reports forbidden terms left", () => {
    const result = run("int a;\n  ACME b;", [], "cpp", ["acme"]);
    assert.deepEqual(
      result.leaks.map((a_leak) => [a_leak.text, a_leak.line, a_leak.column]),
      [["ACME", 1, 2]]
    );
  });
});

describe("parseConfig", () => {
  test("the template is valid", () => {
    const config = parseConfig(RULES_TEMPLATE);
    assert.deepEqual(config.errors, []);
    assert.equal(config.rules.length, 8);
  });

  test("invalid rules are reported and skipped, valid ones kept", () => {
    const config = parseConfig(
      JSON.stringify({
        rules: [
          { type: "replace", find: "(" , regex: true },
          { type: "replace", find: "a", repalce: "b" },
          { type: "nope" },
          { type: "replace", find: "x*", regex: true },
          { type: "pseudonymize", match: "a", template: "x" },
          { type: "replace", find: "ok" }
        ],
        forbidden: ["["]
      })
    );
    assert.equal(config.rules.length, 1);
    assert.equal(config.errors.length, 6);
    assert.match(config.errors[1].message, /rule #2 replace: unknown property 'repalce'/);
  });

  test("JSON syntax errors", () => {
    const config = parseConfig('{ "rules": [ }');
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0].message, /invalid JSON/);
  });
});
