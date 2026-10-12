/// Lexical view of a source file: which ranges are code, comments or string
/// literals. Rules use it to find comments, to stay out of strings, and to
/// match braces without being fooled by a "{" inside a comment.
/// It is a tokenizer, not a parser: good enough for the usual languages, and
/// predictable when it is wrong.

export type SegmentKind = "code" | "comment" | "string";

export interface Segment {
  readonly kind: SegmentKind;
  readonly start: number;
  readonly end: number;
}

export type FunctionBodies = "braces" | "indentation" | "none";

export interface LanguageSyntax {
  readonly lineComments: readonly string[];
  readonly blockComments: readonly (readonly [string, string])[];
  /// Strings ending at the end of the line when not closed
  readonly quotes: readonly string[];
  /// Strings that may span lines (JS template literals)
  readonly multilineQuotes: readonly string[];
  /// C-family character literal: a few chars at most, and a quote right after
  /// a word character is a digit separator (1'000'000), not a literal
  readonly charQuote: string | undefined;
  /// Python """ and ''' strings
  readonly tripleQuotes: boolean;
  /// C++ R"delim(...)delim" strings
  readonly rawStrings: boolean;
  readonly functionBodies: FunctionBodies;
}

const C_FAMILY: LanguageSyntax = {
  lineComments: ["//"],
  blockComments: [["/*", "*/"]],
  quotes: ['"'],
  multilineQuotes: [],
  charQuote: "'",
  tripleQuotes: false,
  rawStrings: false,
  functionBodies: "braces"
};

const CPP: LanguageSyntax = { ...C_FAMILY, rawStrings: true };
// Rust lifetimes ('a) look like unterminated char literals
const RUST: LanguageSyntax = { ...C_FAMILY, charQuote: undefined };
const JS: LanguageSyntax = { ...C_FAMILY, quotes: ['"', "'"], multilineQuotes: ["`"], charQuote: undefined };

const HASH: LanguageSyntax = {
  lineComments: ["#"],
  blockComments: [],
  quotes: ['"', "'"],
  multilineQuotes: [],
  charQuote: undefined,
  tripleQuotes: false,
  rawStrings: false,
  functionBodies: "braces"
};

const PYTHON: LanguageSyntax = { ...HASH, tripleQuotes: true, functionBodies: "indentation" };
const POWERSHELL: LanguageSyntax = { ...HASH, blockComments: [["<#", "#>"]] };
const CMAKE: LanguageSyntax = { ...HASH, blockComments: [["#[[", "]]"]], quotes: ['"'], functionBodies: "none" };
const LUA: LanguageSyntax = { ...HASH, lineComments: ["--"], blockComments: [["--[[", "]]"]], functionBodies: "none" };
const SQL: LanguageSyntax = { ...HASH, lineComments: ["--"], blockComments: [["/*", "*/"]], functionBodies: "none" };

const SYNTAX_BY_LANGUAGE: Readonly<Record<string, LanguageSyntax>> = {
  "c": CPP,
  "cpp": CPP,
  "cuda-cpp": CPP,
  "objective-c": CPP,
  "objective-cpp": CPP,
  "csharp": C_FAMILY,
  "java": C_FAMILY,
  "go": C_FAMILY,
  "swift": C_FAMILY,
  "kotlin": C_FAMILY,
  "scala": C_FAMILY,
  "dart": C_FAMILY,
  "groovy": C_FAMILY,
  "glsl": C_FAMILY,
  "hlsl": C_FAMILY,
  "shaderlab": C_FAMILY,
  "rust": RUST,
  "javascript": JS,
  "javascriptreact": JS,
  "typescript": JS,
  "typescriptreact": JS,
  "php": JS,
  "python": PYTHON,
  "shellscript": HASH,
  "perl": HASH,
  "ruby": HASH,
  "r": HASH,
  "makefile": HASH,
  "dockerfile": HASH,
  "yaml": HASH,
  "toml": HASH,
  "powershell": POWERSHELL,
  "cmake": CMAKE,
  "lua": LUA,
  "sql": SQL
};

/// Unknown languages get the C++ syntax: most code sent for analysis is C-like.
export function getSyntax(a_languageId: string): LanguageSyntax {
  return SYNTAX_BY_LANGUAGE[a_languageId] ?? CPP;
}

const CHAR_LITERAL_MAX_LENGTH = 12;
const RAW_STRING_PREFIX = /(?:^|[^\w])(?:u8|u|U|L)?R$/;

export function scan(a_text: string, a_syntax: LanguageSyntax): Segment[] {
  const segments: Segment[] = [];
  let codeStart = 0;
  let index = 0;
  while (index < a_text.length) {
    const token = matchToken(a_text, index, a_syntax);
    if (token === undefined) {
      index++;
      continue;
    }
    if (codeStart < index) {
      segments.push({ kind: "code", start: codeStart, end: index });
    }
    segments.push({ kind: token.kind, start: index, end: token.end });
    index = token.end;
    codeStart = index;
  }
  if (codeStart < a_text.length) {
    segments.push({ kind: "code", start: codeStart, end: a_text.length });
  }
  return segments;
}

/// Same text where comments and strings are blanked (newlines kept), so
/// offsets are unchanged and a regex or a brace matcher only sees code.
export function maskNonCode(a_text: string, a_segments: readonly Segment[]): string {
  return a_segments
    .map((a_segment) => {
      const part = a_text.slice(a_segment.start, a_segment.end);
      return a_segment.kind === "code" ? part : part.replace(/[^\r\n]/g, " ");
    })
    .join("");
}

function matchToken(
  a_text: string,
  a_index: number,
  a_syntax: LanguageSyntax
): { kind: SegmentKind; end: number } | undefined {
  // block before line: Lua "--[[" starts with the line token "--"
  for (const [open, close] of a_syntax.blockComments) {
    if (a_text.startsWith(open, a_index)) {
      const closeIndex = a_text.indexOf(close, a_index + open.length);
      return { kind: "comment", end: closeIndex < 0 ? a_text.length : closeIndex + close.length };
    }
  }
  for (const token of a_syntax.lineComments) {
    if (a_text.startsWith(token, a_index)) {
      return { kind: "comment", end: lineEnd(a_text, a_index) };
    }
  }
  const char = a_text[a_index];
  if (a_syntax.tripleQuotes && (a_text.startsWith('"""', a_index) || a_text.startsWith("'''", a_index))) {
    const closeIndex = a_text.indexOf(a_text.slice(a_index, a_index + 3), a_index + 3);
    return { kind: "string", end: closeIndex < 0 ? a_text.length : closeIndex + 3 };
  }
  if (a_syntax.rawStrings && char === '"') {
    const end = matchRawString(a_text, a_index);
    if (end !== undefined) {
      return { kind: "string", end: end };
    }
  }
  if (a_syntax.quotes.includes(char)) {
    return { kind: "string", end: scanQuoted(a_text, a_index, false) };
  }
  if (a_syntax.multilineQuotes.includes(char)) {
    return { kind: "string", end: scanQuoted(a_text, a_index, true) };
  }
  if (char === a_syntax.charQuote) {
    if (a_index > 0 && /\w/.test(a_text[a_index - 1])) {
      return undefined;
    }
    const end = scanQuoted(a_text, a_index, false);
    if (end - a_index >= 2 && end - a_index <= CHAR_LITERAL_MAX_LENGTH && a_text[end - 1] === char) {
      return { kind: "string", end: end };
    }
  }
  return undefined;
}

/// End of the line, before its "\r\n" or "\n".
function lineEnd(a_text: string, a_index: number): number {
  const newline = a_text.indexOf("\n", a_index);
  if (newline < 0) {
    return a_text.length;
  }
  return a_text[newline - 1] === "\r" ? newline - 1 : newline;
}

function scanQuoted(a_text: string, a_index: number, a_multiline: boolean): number {
  const quote = a_text[a_index];
  let cursor = a_index + 1;
  while (cursor < a_text.length) {
    const char = a_text[cursor];
    if (char === "\\") {
      cursor += 2;
    } else if (char === quote) {
      return cursor + 1;
    } else if (char === "\n" && !a_multiline) {
      return cursor; // unterminated: stops at the end of line
    } else {
      cursor++;
    }
  }
  return a_text.length;
}

function matchRawString(a_text: string, a_index: number): number | undefined {
  if (!RAW_STRING_PREFIX.test(a_text.slice(Math.max(0, a_index - 4), a_index))) {
    return undefined;
  }
  const open = a_text.indexOf("(", a_index);
  if (open < 0) {
    return undefined;
  }
  const delimiter = a_text.slice(a_index + 1, open);
  if (delimiter.length > 16 || /[\s()\\"]/.test(delimiter)) {
    return undefined;
  }
  const terminator = ")" + delimiter + '"';
  const close = a_text.indexOf(terminator, open);
  return close < 0 ? a_text.length : close + terminator.length;
}
