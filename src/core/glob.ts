import { escapeRegExp } from "./text";

/// Minimal glob: "**", "*", "?" and "{a,b}". A glob without "/" is matched
/// against the file name only, like in a .gitignore.
export function globToRegExp(a_glob: string): RegExp {
  return new RegExp("^" + convert(a_glob) + "$");
}

export function matchesGlob(a_path: string, a_glob: string): boolean {
  const normalized = a_path.replace(/\\/g, "/");
  const target = a_glob.includes("/") ? normalized : normalized.slice(normalized.lastIndexOf("/") + 1);
  return globToRegExp(a_glob).test(target);
}

function convert(a_glob: string): string {
  let source = "";
  let index = 0;
  while (index < a_glob.length) {
    const char = a_glob[index];
    if (char === "*" && a_glob[index + 1] === "*") {
      if (a_glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 3;
      } else {
        source += ".*";
        index += 2;
      }
    } else if (char === "*") {
      source += "[^/]*";
      index++;
    } else if (char === "?") {
      source += "[^/]";
      index++;
    } else if (char === "{" && a_glob.indexOf("}", index) > index) {
      const close = a_glob.indexOf("}", index);
      const alternatives = a_glob.slice(index + 1, close).split(",").map(convert);
      source += "(?:" + alternatives.join("|") + ")";
      index = close + 1;
    } else {
      source += escapeRegExp(char);
      index++;
    }
  }
  return source;
}
