/// JSON with comments and trailing commas, as VS Code writes its own settings.
/// Comments and dropped commas are replaced by spaces (newlines kept), so an
/// offset reported by JSON.parse still points at the right place.
export function stripJsonc(a_text: string): string {
  const chars = a_text.split("");
  const blank = (a_from: number, a_to: number): void => {
    for (let index = a_from; index < a_to; index++) {
      if (chars[index] !== "\n" && chars[index] !== "\r") {
        chars[index] = " ";
      }
    }
  };

  // Pass 1: comments
  let index = 0;
  while (index < a_text.length) {
    const char = a_text[index];
    if (char === '"') {
      index = skipString(a_text, index);
    } else if (char === "/" && a_text[index + 1] === "/") {
      const newline = a_text.indexOf("\n", index);
      const end = newline < 0 ? a_text.length : newline;
      blank(index, end);
      index = end;
    } else if (char === "/" && a_text[index + 1] === "*") {
      const close = a_text.indexOf("*/", index + 2);
      const end = close < 0 ? a_text.length : close + 2;
      blank(index, end);
      index = end;
    } else {
      index++;
    }
  }

  // Pass 2: trailing commas, on the comment free text
  const stripped = chars.join("");
  index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === '"') {
      index = skipString(stripped, index);
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < stripped.length && /\s/.test(stripped[next])) {
        next++;
      }
      if (stripped[next] === "}" || stripped[next] === "]") {
        chars[index] = " ";
      }
    }
    index++;
  }
  return chars.join("");
}

function skipString(a_text: string, a_index: number): number {
  let cursor = a_index + 1;
  while (cursor < a_text.length && a_text[cursor] !== '"') {
    cursor += a_text[cursor] === "\\" ? 2 : 1;
  }
  return cursor + 1;
}
