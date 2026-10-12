import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { anonymize } from "../src/core/anonymizer";
import { parseConfig } from "../src/core/config";

/// The "Advanced examples" of the readme: keep both in sync.

function output(a_rules: unknown[], a_lines: string[], a_languageId = "cpp", a_path = "src/main.cpp"): string[] {
  const config = parseConfig(JSON.stringify({ rules: a_rules }));
  assert.deepEqual(config.errors, []);
  return anonymize(a_lines.join("\n"), config, { languageId: a_languageId, relativePath: a_path }).text.split("\n");
}

describe("readme advanced examples", () => {
  test("a whole table of types, with wildcards", () => {
    const rule = {
      type: "replaceMap",
      wildcard: true,
      wholeWord: true,
      map: { "TOTO::te_*_type": "$1_t", "TOTO::te_*_ptr": "$1_t*", "TOTO::te_bool_type": "bool" }
    };
    assert.deepEqual(
      output([rule], ["TOTO::te_uint32_type a;", "TOTO::te_bool_type ok;", "TOTO::te_int8_ptr p;"]),
      ["uint32_t a;", "bool ok;", "int8_t* p;"]
    );
  });

  test("company prefixes on every identifier", () => {
    const rule = { type: "replaceMap", wildcard: true, wholeWord: true, map: { "TOTO_*": "$1", "TT?_*": "$2" } };
    assert.deepEqual(
      output([rule], ["TOTO_Engine engine;", "TT1_Buffer buf = TOTO_make();"]),
      ["Engine engine;", "Buffer buf = make();"]
    );
  });

  test("internal include paths", () => {
    const rule = { type: "replace", regex: true, find: '#include\\s+"toto/(?:\\w+/)*(\\w+\\.h)"', replace: '#include "$1"' };
    assert.deepEqual(output([rule], ['#include "toto/core/net/socket.h"']), ['#include "socket.h"']);
  });

  test("logs and traces", () => {
    const rule = { type: "removeLines", match: "^\\s*TOTO_(LOG|TRACE|ASSERT)\\w*\\s*\\(" };
    assert.deepEqual(
      output([rule], ["int f() {", '    TOTO_LOG_INFO("start %d", 1);', "    return 1;", '    TOTO_TRACE("end");', "}"]),
      ["int f() {", "    return 1;", "}"]
    );
  });

  test("a whole class, without markers in the code", () => {
    const rule = { type: "removeBlock", begin: "^class\\s+SecretEngine\\b", end: "^\\};", replace: "class SecretEngine; // [removed]" };
    assert.deepEqual(
      output([rule], ["class Public {};", "class SecretEngine : public Base {", "    int m_key;", "};", "int main();"]),
      ["class Public {};", "class SecretEngine; // [removed]", "int main();"]
    );
  });

  test("every algorithm of a folder", () => {
    const rule = { type: "removeFunctionBody", files: "src/crypto/**", name: ".*", replace: "// [removed]" };
    const lines = ["static int mix(int a) {", "    return a * 31;", "}", "int Aes::encrypt(int b) const {", "    return mix(b) ^ 7;", "}"];
    assert.deepEqual(output([rule], lines, "cpp", "src/crypto/aes.cpp"), [
      "static int mix(int a) {",
      "    // [removed]",
      "}",
      "int Aes::encrypt(int b) const {",
      "    // [removed]",
      "}"
    ]);
    assert.deepEqual(output([rule], lines, "cpp", "src/net/socket.cpp"), lines);
  });

  test("emails and tickets in comments only", () => {
    const rules = [
      { type: "replace", regex: true, in: "comment", find: "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+", replace: "<email>" },
      { type: "replace", regex: true, in: "comment", caseSensitive: false, find: "\\b(JIRA|TOTO)-\\d+\\b", replace: "<ticket>" }
    ];
    assert.deepEqual(
      output(rules, ["// fixed by john.doe@toto.com, see TOTO-1234", 'send("ops@toto.com"); // TOTO-99']),
      ["// fixed by <email>, see <ticket>", 'send("ops@toto.com"); // <ticket>']
    );
  });

  test("customer names in strings", () => {
    const rule = { type: "pseudonymize", in: "string", match: "\\b(Microsoft|Google|Meta)\\b", template: "Customer{n}" };
    assert.deepEqual(
      output([rule], ['const char* c = "Google";', 'if (name == "Meta" || name == "Google") {}']),
      ['const char* c = "Customer1";', 'if (name == "Customer2" || name == "Customer1") {}']
    );
  });

  test("python only", () => {
    const rule = { type: "removeFunctionBody", languages: "python", name: "_.*|compute_\\w+" };
    const lines = ["def _secret(x):", "    return x * 42", "", "def public(x):", "    return _secret(x)"];
    assert.deepEqual(output([rule], lines, "python", "tools/x.py"), [
      "def _secret(x):",
      "    pass  # body removed",
      "",
      "def public(x):",
      "    return _secret(x)"
    ]);
    assert.deepEqual(output([rule], lines, "cpp"), lines);
  });

  test("a safety net for what the rules missed", () => {
    const config = parseConfig(
      JSON.stringify({
        forbidden: ["toto", "[\\w.+-]+@[\\w-]+\\.\\w+", "\\b10\\.\\d+\\.\\d+\\.\\d+\\b", "https?://[\\w.-]+\\.(local|corp|intra)\\b"]
      })
    );
    const result = anonymize('ip = "10.0.12.4"; url = "http://build.intra/x"; // a@b.com', config, {
      languageId: "cpp",
      relativePath: "a.cpp"
    });
    assert.deepEqual(result.leaks.map((a_leak) => a_leak.text), ["10.0.12.4", "http://build.intra", "a@b.com"]);
  });
});
