/// Small string helpers shared by the rules. No vscode import: the whole core
/// runs in plain Node for the unit tests.

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function escapeRegExp(a_text: string): string {
  return a_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectEol(a_text: string): string {
  return a_text.includes("\r\n") ? "\r\n" : "\n";
}

export function stripCr(a_line: string): string {
  return a_line.endsWith("\r") ? a_line.slice(0, -1) : a_line;
}

export function indentationOf(a_line: string): string {
  return /^[ \t]*/.exec(a_line)![0];
}

/// Indentation of the line holding a_offset.
export function lineIndentAt(a_text: string, a_offset: number): string {
  const lineStart = a_text.lastIndexOf("\n", a_offset - 1) + 1;
  return indentationOf(a_text.slice(lineStart, a_offset));
}

/// Apply non overlapping edits expressed in offsets of a_text.
export function applyEdits(a_text: string, a_edits: readonly TextEdit[]): string {
  if (a_edits.length === 0) {
    return a_text;
  }
  const sorted = [...a_edits].sort((a_left, a_right) => a_left.start - a_right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    parts.push(a_text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(a_text.slice(cursor));
  return parts.join("");
}

/// Index of the delimiter closing the one at a_openIndex, or -1. Meant to run
/// on a masked text (see maskNonCode) so delimiters in strings are ignored.
export function findMatching(a_text: string, a_openIndex: number, a_open: string, a_close: string): number {
  let depth = 0;
  for (let index = a_openIndex; index < a_text.length; index++) {
    const char = a_text[index];
    if (char === a_open) {
      depth++;
    } else if (char === a_close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function skipWhitespace(a_text: string, a_from: number): number {
  let index = a_from;
  while (index < a_text.length && /\s/.test(a_text[index])) {
    index++;
  }
  return index;
}

/// Zero based line and column of an offset.
export function positionAt(a_text: string, a_offset: number): { line: number; column: number } {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < a_offset && index < a_text.length; index++) {
    if (a_text[index] === "\n") {
      line++;
      lineStart = index + 1;
    }
  }
  return { line: line, column: a_offset - lineStart };
}

export function errorMessage(a_error: unknown): string {
  return a_error instanceof Error ? a_error.message : String(a_error);
}
