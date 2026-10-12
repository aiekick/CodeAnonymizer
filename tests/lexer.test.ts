import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getSyntax, maskNonCode, scan } from "../src/core/lexer";
import { stripJsonc } from "../src/core/jsonc";
import { matchesGlob } from "../src/core/glob";

function kinds(a_text: string, a_languageId = "cpp"): [string, string][] {
  return scan(a_text, getSyntax(a_languageId)).map((a_segment) => [
    a_segment.kind,
    a_text.slice(a_segment.start, a_segment.end)
  ]);
}

describe("scan", () => {
  test("splits code, comments and strings", () => {
    assert.deepEqual(kinds('int a; // x\nf("//not", \'/\'); /* b */'), [
      ["code", "int a; "],
      ["comment", "// x"],
      ["code", "\nf("],
      ["string", '"//not"'],
      ["code", ", "],
      ["string", "'/'"],
      ["code", "); "],
      ["comment", "/* b */"]
    ]);
  });

  test("line comments stop before \\r\\n", () => {
    assert.deepEqual(kinds("a // x\r\nb"), [["code", "a "], ["comment", "// x"], ["code", "\r\nb"]]);
  });

  test("escaped quotes do not end a string", () => {
    assert.deepEqual(kinds('"a\\"b" c'), [["string", '"a\\"b"'], ["code", " c"]]);
  });

  test("digit separators are not char literals", () => {
    assert.deepEqual(kinds("int n = 1'000'000; // c"), [["code", "int n = 1'000'000; "], ["comment", "// c"]]);
  });

  test("C++ raw strings", () => {
    assert.deepEqual(kinds('auto s = R"x(a "/*" b)x"; c'), [
      ["code", "auto s = R"],
      ["string", '"x(a "/*" b)x"'],
      ["code", "; c"]
    ]);
  });

  test("Python comments and triple quoted strings", () => {
    assert.deepEqual(kinds('x = """a # b"""  # c', "python"), [
      ["code", "x = "],
      ["string", '"""a # b"""'],
      ["code", "  "],
      ["comment", "# c"]
    ]);
  });

  test("maskNonCode keeps offsets and newlines", () => {
    const text = 'f("{") /* }\n */ {';
    const masked = maskNonCode(text, scan(text, getSyntax("cpp")));
    assert.equal(masked.length, text.length);
    assert.equal(masked, "f(   )     \n    {");
  });
});

describe("stripJsonc", () => {
  test("removes comments and trailing commas, keeps strings", () => {
    const text = '{ "a": "//x", /* c */ "b": [1, 2,], // d\n }';
    assert.deepEqual(JSON.parse(stripJsonc(text)), { a: "//x", b: [1, 2] });
    assert.equal(stripJsonc(text).length, text.length);
  });
});

describe("matchesGlob", () => {
  test("file name and path globs", () => {
    assert.ok(matchesGlob("src/a/b.h", "*.h"));
    assert.ok(matchesGlob("src/a/b.h", "**/*.{h,hpp}"));
    assert.ok(matchesGlob("src/a/b.hpp", "src/**/*.{h,hpp}"));
    assert.ok(!matchesGlob("lib/a/b.h", "src/**"));
    assert.ok(matchesGlob("src\\a\\b.cpp", "src/*/b.cpp"));
  });
});
