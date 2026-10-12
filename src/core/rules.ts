import { LanguageSyntax, SegmentKind, maskNonCode, scan } from "./lexer";
import { matchesGlob } from "./glob";
import {
  TextEdit,
  applyEdits,
  errorMessage,
  escapeRegExp,
  findMatching,
  indentationOf,
  lineIndentAt,
  skipWhitespace,
  stripCr
} from "./text";

/// The file being anonymized, as seen by the "languages" and "files" filters.
export interface RuleTarget {
  readonly languageId: string;
  readonly relativePath: string;
}

export interface RuleContext extends RuleTarget {
  readonly syntax: LanguageSyntax;
  readonly eol: string;
}

/// Filled by a rule while it runs, for the report.
export interface RuleOutcome {
  count: number;
  readonly warnings: string[];
  readonly pseudonyms: [string, string][];
}

export interface CompiledRule {
  readonly label: string;
  readonly enabled: boolean;
  appliesTo(a_target: RuleTarget): boolean;
  apply(a_text: string, a_context: RuleContext, a_outcome: RuleOutcome): string;
}

export class RuleError extends Error {}

type RawRule = Readonly<Record<string, unknown>>;
type ApplyFunction = (a_text: string, a_context: RuleContext, a_outcome: RuleOutcome) => string;

interface RuleFactory {
  /// Properties specific to the rule type, on top of COMMON_KEYS
  readonly keys: readonly string[];
  create(a_raw: RawRule): ApplyFunction;
}

const COMMON_KEYS = ["type", "description", "enabled", "languages", "files"];
const ALL_SCOPES: readonly SegmentKind[] = ["code", "comment", "string"];
const DEFAULT_HEADER_MATCH = "copyright|licen[cs]e|\\(c\\)|all rights reserved|spdx";

const FACTORIES: Readonly<Record<string, RuleFactory>> = {
  replace: {
    keys: ["find", "replace", "regex", "wholeWord", "caseSensitive", "in"],
    create: (a_raw) => {
      const find = requiredString(a_raw, "find");
      const isRegex = optionalBoolean(a_raw, "regex", false);
      const replacement = optionalString(a_raw, "replace") ?? "";
      const caseSensitive = optionalBoolean(a_raw, "caseSensitive", true);
      const scopes = optionalScopes(a_raw);
      let source = isRegex ? find : escapeRegExp(find);
      if (optionalBoolean(a_raw, "wholeWord", false)) {
        source = wholeWord(source);
      }
      const pattern = replacementRegExp(source, caseSensitive, "find");
      // a literal replacement must not expand "$1" or "$&"
      const replaceWith = isRegex ? replacement : replacement.replace(/\$/g, "$$$$");
      return (a_text, a_context, a_outcome) =>
        replaceInScopes(a_text, pattern, replaceWith, scopes, a_context, a_outcome);
    }
  },

  replaceMap: {
    keys: ["map", "wholeWord", "wildcard", "caseSensitive", "in"],
    create: (a_raw) => {
      const map = a_raw.map;
      if (typeof map !== "object" || map === null || Array.isArray(map) || Object.keys(map).length === 0) {
        throw new RuleError("'map' must be a non-empty object of \"token\": \"replacement\" pairs");
      }
      const caseSensitive = optionalBoolean(a_raw, "caseSensitive", true);
      const defaultWholeWord = optionalBoolean(a_raw, "wholeWord", false);
      const defaultWildcard = optionalBoolean(a_raw, "wildcard", false);
      const entries: MapEntry[] = Object.entries(map).map(([a_token, a_value]) =>
        compileMapEntry(a_token, a_value, defaultWholeWord, defaultWildcard, caseSensitive)
      );
      // most specific first: "te_uint32_ptr" before its prefix "te_uint32",
      // "TOTO_*_type" before "TOTO_*"
      entries.sort((a_left, a_right) => a_right.literalLength - a_left.literalLength);
      // a named group per entry tells which one matched
      const source = entries.map((a_entry, a_index) => `(?<e${a_index}>${a_entry.source})`).join("|");
      const pattern = replacementRegExp(source, caseSensitive, "map");
      const scopes = optionalScopes(a_raw);
      const replacer = (a_match: string, ...a_rest: unknown[]): string => {
        const groups = a_rest[a_rest.length - 1] as Record<string, string | undefined>;
        const entry = entries.find((_entry, a_index) => groups[`e${a_index}`] !== undefined);
        return entry === undefined ? a_match : entry.replace(a_match);
      };
      return (a_text, a_context, a_outcome) =>
        replaceInScopes(a_text, pattern, replacer, scopes, a_context, a_outcome);
    }
  },

  removeLines: {
    keys: ["match", "caseSensitive"],
    create: (a_raw) => {
      const pattern = makeRegExp(requiredString(a_raw, "match"), caseFlag(a_raw), "match");
      return (a_text, _context, a_outcome) =>
        a_text
          .split("\n")
          .filter((a_line) => {
            const hit = pattern.test(stripCr(a_line));
            if (hit) {
              a_outcome.count++;
            }
            return !hit;
          })
          .join("\n");
    }
  },

  removeBlock: {
    keys: ["begin", "end", "replace", "keepMarkers", "caseSensitive"],
    create: (a_raw) => {
      const flags = caseFlag(a_raw);
      const begin = makeRegExp(requiredString(a_raw, "begin"), flags, "begin");
      const end = makeRegExp(requiredString(a_raw, "end"), flags, "end");
      const replacement = optionalString(a_raw, "replace");
      const keepMarkers = optionalBoolean(a_raw, "keepMarkers", false);
      return (a_text, _context, a_outcome) => {
        const lines = a_text.split("\n");
        const output: string[] = [];
        let index = 0;
        while (index < lines.length) {
          const line = lines[index];
          if (!begin.test(stripCr(line))) {
            output.push(line);
            index++;
            continue;
          }
          let close = index + 1;
          while (close < lines.length && !end.test(stripCr(lines[close]))) {
            close++;
          }
          const terminated = close < lines.length;
          if (!terminated) {
            // fail safe: what follows an unclosed marker is assumed sensitive
            a_outcome.warnings.push(`line ${index + 1}: no end marker, removed up to the end of the file`);
            close = lines.length - 1;
          }
          a_outcome.count++;
          if (keepMarkers) {
            output.push(line);
          }
          if (replacement !== undefined) {
            const cr = line.endsWith("\r") ? "\r" : "";
            const indent = indentationOf(line);
            output.push(...replacement.split("\n").map((a_part) => indent + a_part + cr));
          }
          if (keepMarkers && terminated) {
            output.push(lines[close]);
          }
          index = close + 1;
        }
        return output.join("\n");
      };
    }
  },

  removeHeader: {
    keys: ["match", "replace", "caseSensitive"],
    create: (a_raw) => {
      const pattern = makeRegExp(optionalString(a_raw, "match") ?? DEFAULT_HEADER_MATCH, caseFlag(a_raw, false), "match");
      const replacement = optionalString(a_raw, "replace");
      return (a_text, a_context, a_outcome) => removeHeader(a_text, pattern, replacement, a_context, a_outcome);
    }
  },

  removeComments: {
    keys: ["keep"],
    create: (a_raw) => {
      const keepSource = optionalString(a_raw, "keep");
      const keep = keepSource === undefined ? undefined : makeRegExp(keepSource, "", "keep");
      return (a_text, a_context, a_outcome) => removeComments(a_text, keep, a_context, a_outcome);
    }
  },

  removeFunctionBody: {
    keys: ["name", "replace"],
    create: (a_raw) => {
      const name = makeRegExp(`^(?:${requiredString(a_raw, "name")})$`, "", "name");
      const replacement = optionalString(a_raw, "replace");
      return (a_text, a_context, a_outcome) => {
        switch (a_context.syntax.functionBodies) {
          case "braces":
            return removeBraceBodies(a_text, name, replacement ?? "// body removed", a_context, a_outcome);
          case "indentation":
            return removeIndentedBodies(a_text, name, replacement ?? "pass  # body removed", a_context, a_outcome);
          case "none":
            a_outcome.warnings.push(`not supported for the '${a_context.languageId}' language`);
            return a_text;
        }
      };
    }
  },

  pseudonymize: {
    keys: ["match", "template", "caseSensitive", "in"],
    create: (a_raw) => {
      const caseSensitive = optionalBoolean(a_raw, "caseSensitive", true);
      const pattern = replacementRegExp(requiredString(a_raw, "match"), caseSensitive, "match");
      const template = optionalString(a_raw, "template") ?? "anon_{n}";
      if (!template.includes("{n}")) {
        throw new RuleError("'template' must contain {n}, the number of the pseudonym");
      }
      const scopes = optionalScopes(a_raw);
      return (a_text, a_context, a_outcome) => {
        const aliases = new Map<string, string>();
        const replacer = (a_match: string): string => {
          const key = caseSensitive ? a_match : a_match.toLowerCase();
          let alias = aliases.get(key);
          if (alias === undefined) {
            alias = template.replace(/\{n\}/g, String(aliases.size + 1));
            aliases.set(key, alias);
            a_outcome.pseudonyms.push([a_match, alias]);
          }
          return alias;
        };
        return replaceInScopes(a_text, pattern, replacer, scopes, a_context, a_outcome);
      };
    }
  }
};

export const RULE_TYPES: readonly string[] = Object.keys(FACTORIES);

/// Validate a rule of the configuration. Throws a RuleError whose message
/// starts with the rule label, ready to be shown to the user.
export function compileRule(a_raw: unknown, a_index: number): CompiledRule {
  const number = `rule #${a_index + 1}`;
  if (typeof a_raw !== "object" || a_raw === null || Array.isArray(a_raw)) {
    throw new RuleError(`${number}: must be an object`);
  }
  const raw = a_raw as RawRule;
  const type = raw.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(FACTORIES, type)) {
    throw new RuleError(`${number}: 'type' must be one of ${RULE_TYPES.join(", ")}`);
  }
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const label = `${number} ${type}` + (description !== undefined ? ` (${description})` : "");
  const factory = FACTORIES[type];
  try {
    for (const key of Object.keys(raw)) {
      if (!COMMON_KEYS.includes(key) && !factory.keys.includes(key)) {
        throw new RuleError(`unknown property '${key}' (expected ${factory.keys.join(", ")})`);
      }
    }
    optionalString(raw, "description");
    const languages = optionalStringList(raw, "languages");
    const files = optionalStringList(raw, "files");
    const enabled = optionalBoolean(raw, "enabled", true);
    const apply = factory.create(raw);
    return {
      label: label,
      enabled: enabled,
      appliesTo: (a_target) =>
        (languages === undefined || languages.includes(a_target.languageId)) &&
        (files === undefined || files.some((a_glob) => matchesGlob(a_target.relativePath, a_glob))),
      apply: apply
    };
  } catch (a_error) {
    throw new RuleError(`${label}: ${errorMessage(a_error)}`);
  }
}

// ---- property readers -------------------------------------------------------

function requiredString(a_raw: RawRule, a_key: string): string {
  const value = a_raw[a_key];
  if (typeof value !== "string" || value === "") {
    throw new RuleError(`'${a_key}' must be a non-empty string`);
  }
  return value;
}

function optionalString(a_raw: RawRule, a_key: string): string | undefined {
  const value = a_raw[a_key];
  if (value !== undefined && typeof value !== "string") {
    throw new RuleError(`'${a_key}' must be a string`);
  }
  return value;
}

function optionalBoolean(a_raw: RawRule, a_key: string, a_default: boolean): boolean {
  const value = a_raw[a_key];
  if (value === undefined) {
    return a_default;
  }
  if (typeof value !== "boolean") {
    throw new RuleError(`'${a_key}' must be true or false`);
  }
  return value;
}

/// A string or an array of strings.
function optionalStringList(a_raw: RawRule, a_key: string): string[] | undefined {
  const value = a_raw[a_key];
  if (value === undefined) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every((a_item) => typeof a_item === "string" && a_item !== "")) {
    throw new RuleError(`'${a_key}' must be a non-empty string or array of strings`);
  }
  return list as string[];
}

function optionalScopes(a_raw: RawRule): SegmentKind[] | undefined {
  const scopes = optionalStringList(a_raw, "in");
  if (scopes === undefined) {
    return undefined;
  }
  for (const scope of scopes) {
    if (!(ALL_SCOPES as readonly string[]).includes(scope)) {
      throw new RuleError(`'in': '${scope}' must be one of ${ALL_SCOPES.join(", ")}`);
    }
  }
  return scopes as SegmentKind[];
}

function caseFlag(a_raw: RawRule, a_default = true): string {
  return optionalBoolean(a_raw, "caseSensitive", a_default) ? "" : "i";
}

export function makeRegExp(a_source: string, a_flags: string, a_key: string): RegExp {
  try {
    return new RegExp(a_source, a_flags);
  } catch (a_error) {
    throw new RuleError(`'${a_key}' is not a valid regular expression: ${errorMessage(a_error)}`);
  }
}

/// Global, multiline regex used to replace text. One matching the empty
/// string would insert its replacement between every character.
function replacementRegExp(a_source: string, a_caseSensitive: boolean, a_key: string): RegExp {
  const pattern = makeRegExp(a_source, a_caseSensitive ? "gm" : "gim", a_key);
  if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test("")) {
    throw new RuleError(`'${a_key}' must not match an empty string`);
  }
  return pattern;
}

function wholeWord(a_source: string): string {
  return `(?<!\\w)(?:${a_source})(?!\\w)`;
}

interface MapEntry {
  /// Regex source of the token, without capturing groups
  readonly source: string;
  /// Length without the wildcards, to try the most specific tokens first
  readonly literalLength: number;
  /// Replacement of a text matched by this entry
  readonly replace: (a_match: string) => string;
}

/// "token": "replacement", or "token": { "replace", "wholeWord", "wildcard" }
/// to override the settings of the rule for this token.
function compileMapEntry(
  a_token: string,
  a_value: unknown,
  a_defaultWholeWord: boolean,
  a_defaultWildcard: boolean,
  a_caseSensitive: boolean
): MapEntry {
  const entry: unknown = typeof a_value === "string" ? { replace: a_value } : a_value;
  if (a_token === "" || typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new RuleError(`'map': "${a_token}" must map a non-empty token to a string or to { "replace", "wholeWord", "wildcard" }`);
  }
  const fields = entry as RawRule;
  try {
    for (const key of Object.keys(fields)) {
      if (key !== "replace" && key !== "wholeWord" && key !== "wildcard") {
        throw new RuleError(`unknown property '${key}' (expected replace, wholeWord, wildcard)`);
      }
    }
    const replacement = optionalString(fields, "replace") ?? "";
    const isWholeWord = optionalBoolean(fields, "wholeWord", a_defaultWholeWord);
    if (!optionalBoolean(fields, "wildcard", a_defaultWildcard)) {
      const source = escapeRegExp(a_token);
      return {
        source: isWholeWord ? wholeWord(source) : source,
        literalLength: a_token.length,
        replace: () => replacement
      };
    }
    const wildcard = wildcardToRegExp(a_token);
    const capturing = makeRegExp(`^${wildcard.capturing}$`, a_caseSensitive ? "" : "i", "map");
    return {
      source: isWholeWord ? wholeWord(wildcard.plain) : wildcard.plain,
      literalLength: wildcard.literalLength,
      // "$1", "$2"... are the texts matched by the wildcards
      replace: (a_match) => a_match.replace(capturing, replacement)
    };
  } catch (a_error) {
    throw new RuleError(`'map': "${a_token}": ${errorMessage(a_error)}`);
  }
}

/// Wildcards of identifiers: "*" is any run of letters, digits and "_", "?"
/// is one of them; "\\*" and "\\?" are a literal star and question mark.
export function wildcardToRegExp(a_pattern: string): { plain: string; capturing: string; literalLength: number } {
  let plain = "";
  let capturing = "";
  let literalLength = 0;
  for (let index = 0; index < a_pattern.length; index++) {
    const char = a_pattern[index];
    if (char === "\\" && (a_pattern[index + 1] === "*" || a_pattern[index + 1] === "?")) {
      plain += "\\" + a_pattern[index + 1];
      capturing += "\\" + a_pattern[index + 1];
      literalLength++;
      index++;
    } else if (char === "*") {
      plain += "\\w*";
      capturing += "(\\w*)";
    } else if (char === "?") {
      plain += "\\w";
      capturing += "(\\w)";
    } else {
      plain += escapeRegExp(char);
      capturing += escapeRegExp(char);
      literalLength++;
    }
  }
  return { plain: plain, capturing: capturing, literalLength: literalLength };
}

// ---- rule implementations ---------------------------------------------------

function replaceInScopes(
  a_text: string,
  a_pattern: RegExp,
  a_replacement: string | ((a_match: string, ...a_rest: unknown[]) => string),
  a_scopes: readonly SegmentKind[] | undefined,
  a_context: RuleContext,
  a_outcome: RuleOutcome
): string {
  const replacePart = (a_part: string): string => {
    a_outcome.count += a_part.match(a_pattern)?.length ?? 0;
    return typeof a_replacement === "string"
      ? a_part.replace(a_pattern, a_replacement)
      : a_part.replace(a_pattern, a_replacement);
  };
  if (a_scopes === undefined || ALL_SCOPES.every((a_scope) => a_scopes.includes(a_scope))) {
    return replacePart(a_text);
  }
  return scan(a_text, a_context.syntax)
    .map((a_segment) => {
      const part = a_text.slice(a_segment.start, a_segment.end);
      return a_scopes.includes(a_segment.kind) ? replacePart(part) : part;
    })
    .join("");
}

/// Leading comments are grouped (a blank line separates two groups); each
/// group matching the pattern is removed, the other ones are kept.
function removeHeader(
  a_text: string,
  a_pattern: RegExp,
  a_replacement: string | undefined,
  a_context: RuleContext,
  a_outcome: RuleOutcome
): string {
  const groups: { start: number; end: number }[] = [];
  let current: { start: number; end: number } | undefined;
  for (const segment of scan(a_text, a_context.syntax)) {
    const part = a_text.slice(segment.start, segment.end);
    if (segment.kind === "comment") {
      if (current === undefined) {
        current = { start: segment.start, end: segment.end };
      } else {
        current.end = segment.end;
      }
    } else if (segment.kind === "code" && /^[\s﻿]*$/.test(part)) {
      if (current !== undefined && (part.match(/\n/g)?.length ?? 0) >= 2) {
        groups.push(current);
        current = undefined;
      }
    } else {
      break;
    }
  }
  if (current !== undefined) {
    groups.push(current);
  }

  const kept: string[] = [];
  for (const group of groups) {
    const groupText = a_text.slice(group.start, group.end);
    if (a_pattern.test(groupText)) {
      a_outcome.count++;
    } else {
      kept.push(groupText);
    }
  }
  if (a_outcome.count === 0) {
    return a_text;
  }

  // the code starts at the beginning of the line of its first character
  const firstContent = skipWhitespace(a_text, groups[groups.length - 1].end);
  const rest = a_text.slice(a_text.lastIndexOf("\n", firstContent - 1) + 1);
  const head = a_replacement === undefined ? kept : [a_replacement, ...kept];
  if (head.length === 0) {
    return rest;
  }
  const separator = a_context.eol + a_context.eol;
  return head.join(separator) + (rest === "" ? a_context.eol : separator) + rest;
}

/// Removes the comments; a line left empty by the removal is removed too.
function removeComments(
  a_text: string,
  a_keep: RegExp | undefined,
  a_context: RuleContext,
  a_outcome: RuleOutcome
): string {
  const removed = new Uint8Array(a_text.length);
  for (const segment of scan(a_text, a_context.syntax)) {
    if (segment.kind !== "comment" || a_keep?.test(a_text.slice(segment.start, segment.end))) {
      continue;
    }
    removed.fill(1, segment.start, segment.end);
    a_outcome.count++;
  }
  if (a_outcome.count === 0) {
    return a_text;
  }

  const output: string[] = [];
  let lineStart = 0;
  while (lineStart <= a_text.length) {
    let lineEnd = a_text.indexOf("\n", lineStart);
    if (lineEnd < 0) {
      lineEnd = a_text.length;
    }
    let kept = "";
    let touched = false;
    for (let index = lineStart; index < lineEnd; index++) {
      if (removed[index] === 1 && a_text[index] !== "\r") {
        touched = true;
      } else {
        kept += a_text[index];
      }
    }
    if (!touched) {
      output.push(kept);
    } else if (kept.trim() !== "") {
      const cr = kept.endsWith("\r") ? "\r" : "";
      output.push(stripCr(kept).replace(/[ \t]+$/, "") + cr);
    }
    lineStart = lineEnd + 1;
  }
  return output.join("\n");
}

const NOT_FUNCTIONS = new Set([
  "if", "while", "for", "switch", "return", "sizeof", "catch", "decltype", "alignof",
  "typeof", "new", "delete", "throw", "case", "else", "do", "defined", "foreach"
]);

/// C-like: name(...) [qualifiers] [: init list] { body }
function removeBraceBodies(
  a_text: string,
  a_name: RegExp,
  a_replacement: string,
  a_context: RuleContext,
  a_outcome: RuleOutcome
): string {
  const masked = maskNonCode(a_text, scan(a_text, a_context.syntax));
  const finder = /~?[A-Za-z_]\w*(?:\s*::\s*~?[A-Za-z_]\w*)*\s*\(/g;
  const edits: TextEdit[] = [];
  let match: RegExpExecArray | null;
  while ((match = finder.exec(masked)) !== null) {
    const qualified = match[0].slice(0, -1).replace(/\s+/g, "");
    const shortName = qualified.slice(qualified.lastIndexOf("::") + (qualified.includes("::") ? 2 : 0));
    if (NOT_FUNCTIONS.has(shortName) || !(a_name.test(qualified) || a_name.test(shortName))) {
      continue;
    }
    if (isMemberAccess(masked, match.index)) {
      continue;
    }
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = findMatching(masked, parenOpen, "(", ")");
    const bodyOpen = parenClose < 0 ? -1 : findBodyOpen(masked, parenClose + 1);
    const bodyClose = bodyOpen < 0 ? -1 : findMatching(masked, bodyOpen, "{", "}");
    if (bodyClose < 0) {
      continue; // a call or a declaration, not a definition
    }
    const indent = lineIndentAt(a_text, match.index);
    const eol = a_context.eol;
    edits.push({ start: bodyOpen, end: bodyClose + 1, text: `{${eol}${indent}    ${a_replacement}${eol}${indent}}` });
    a_outcome.count++;
    finder.lastIndex = bodyClose + 1;
  }
  return applyEdits(a_text, edits);
}

function isMemberAccess(a_masked: string, a_index: number): boolean {
  let cursor = a_index - 1;
  while (cursor >= 0 && /\s/.test(a_masked[cursor])) {
    cursor--;
  }
  return a_masked[cursor] === "." || (a_masked[cursor] === ">" && a_masked[cursor - 1] === "-");
}

/// From the closing parenthesis of the parameters, find the "{" of the body.
/// Only qualifiers (const, noexcept(...), override, -> type) and a constructor
/// initializer list may stand in between: anything else means the name was
/// used in an expression, like "if (compute(x)) {".
function findBodyOpen(a_masked: string, a_from: number): number {
  let cursor = a_from;
  while (cursor < a_masked.length) {
    const char = a_masked[cursor];
    if (char === "{") {
      const close = findMatching(a_masked, cursor, "{", "}");
      if (close < 0) {
        return -1;
      }
      // brace initialized member, followed by the next one or by the body:
      // m_a{0}, m_b{1} { ... }
      const after = skipWhitespace(a_masked, close + 1);
      if (a_masked[after] === "," || a_masked[after] === "{") {
        cursor = after;
        continue;
      }
      return cursor;
    }
    if (char === "(" || char === "[") {
      const close = findMatching(a_masked, cursor, char, char === "(" ? ")" : "]");
      if (close < 0) {
        return -1;
      }
      cursor = close + 1;
    } else if (/[\s\w:&*<>,~-]/.test(char)) {
      cursor++;
    } else {
      return -1;
    }
  }
  return -1;
}

/// Python: def name(...) [-> type]: then the lines indented deeper.
function removeIndentedBodies(
  a_text: string,
  a_name: RegExp,
  a_replacement: string,
  a_context: RuleContext,
  a_outcome: RuleOutcome
): string {
  const masked = maskNonCode(a_text, scan(a_text, a_context.syntax));
  const finder = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm;
  const edits: TextEdit[] = [];
  let match: RegExpExecArray | null;
  while ((match = finder.exec(masked)) !== null) {
    if (!a_name.test(match[2])) {
      continue;
    }
    const parenClose = findMatching(masked, match.index + match[0].length - 1, "(", ")");
    const colon = parenClose < 0 ? -1 : findSignatureColon(masked, parenClose + 1);
    if (colon < 0) {
      continue;
    }
    let lineEnd = masked.indexOf("\n", colon);
    if (lineEnd < 0) {
      lineEnd = masked.length;
    }
    const contentEnd = masked[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (masked.slice(colon + 1, contentEnd).trim() !== "") {
      // one-liner: def f(): return 42
      edits.push({ start: colon + 1, end: contentEnd, text: " " + a_replacement });
      a_outcome.count++;
      continue;
    }
    const defIndent = match[1].length;
    let bodyIndent: string | undefined;
    let bodyEnd = -1;
    let cursor = lineEnd + 1;
    while (cursor < masked.length) {
      let next = masked.indexOf("\n", cursor);
      if (next < 0) {
        next = masked.length;
      }
      const line = stripCr(masked.slice(cursor, next));
      if (line.trim() !== "") {
        const indent = indentationOf(line);
        if (indent.length <= defIndent) {
          break;
        }
        bodyIndent ??= indent;
        bodyEnd = cursor + line.length;
      }
      cursor = next + 1;
    }
    if (bodyIndent === undefined) {
      continue;
    }
    edits.push({ start: lineEnd + 1, end: bodyEnd, text: bodyIndent + a_replacement });
    a_outcome.count++;
    finder.lastIndex = bodyEnd;
  }
  return applyEdits(a_text, edits);
}

function findSignatureColon(a_masked: string, a_from: number): number {
  let cursor = a_from;
  while (cursor < a_masked.length) {
    const char = a_masked[cursor];
    if (char === ":") {
      return cursor;
    }
    if (char === "(" || char === "[") {
      const close = findMatching(a_masked, cursor, char, char === "(" ? ")" : "]");
      if (close < 0) {
        return -1;
      }
      cursor = close + 1;
    } else if (/[\s\w.,>|-]/.test(char)) {
      cursor++;
    } else {
      return -1;
    }
  }
  return -1;
}
