import { stripJsonc } from "./jsonc";
import { CompiledRule, RuleError, compileRule, makeRegExp } from "./rules";
import { errorMessage } from "./text";

export interface ConfigError {
  readonly message: string;
  /// Offset in the rules file, when known
  readonly offset?: number;
}

export interface ForbiddenTerm {
  readonly source: string;
  readonly pattern: RegExp;
}

export interface ParsedConfig {
  readonly rules: readonly CompiledRule[];
  readonly forbidden: readonly ForbiddenTerm[];
  readonly errors: readonly ConfigError[];
}

export const EMPTY_CONFIG: ParsedConfig = { rules: [], forbidden: [], errors: [] };

const TOP_LEVEL_KEYS = ["$schema", "rules", "forbidden"];

/// Parse a rules file. Never throws: invalid rules are reported in errors and
/// skipped, the valid ones are still applied, so the preview keeps working
/// while the file is being typed.
export function parseConfig(a_text: string): ParsedConfig {
  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(a_text));
  } catch (a_error) {
    const message = errorMessage(a_error);
    const position = /position (\d+)/.exec(message);
    return {
      ...EMPTY_CONFIG,
      errors: [{ message: `invalid JSON: ${message}`, offset: position === null ? undefined : Number(position[1]) }]
    };
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return { ...EMPTY_CONFIG, errors: [{ message: 'the rules file must contain an object: { "rules": [...] }' }] };
  }

  const object = root as Record<string, unknown>;
  const errors: ConfigError[] = [];
  for (const key of Object.keys(object)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push({ message: `unknown property '${key}' (expected ${TOP_LEVEL_KEYS.join(", ")})` });
    }
  }

  const rules: CompiledRule[] = [];
  if (object.rules !== undefined && !Array.isArray(object.rules)) {
    errors.push({ message: "'rules' must be an array" });
  } else {
    ((object.rules ?? []) as unknown[]).forEach((a_rawRule, a_index) => {
      try {
        rules.push(compileRule(a_rawRule, a_index));
      } catch (a_error) {
        errors.push({ message: a_error instanceof RuleError ? a_error.message : errorMessage(a_error) });
      }
    });
  }

  const forbidden: ForbiddenTerm[] = [];
  if (object.forbidden !== undefined && !Array.isArray(object.forbidden)) {
    errors.push({ message: "'forbidden' must be an array of regular expressions" });
  } else {
    for (const source of (object.forbidden ?? []) as unknown[]) {
      if (typeof source !== "string" || source === "") {
        errors.push({ message: "'forbidden': every entry must be a non-empty string" });
        continue;
      }
      try {
        const pattern = makeRegExp(source, "gi", "forbidden");
        if (pattern.test("")) {
          throw new RuleError(`'forbidden': '${source}' matches an empty string`);
        }
        forbidden.push({ source: source, pattern: pattern });
      } catch (a_error) {
        errors.push({ message: errorMessage(a_error) });
      }
    }
  }
  return { rules: rules, forbidden: forbidden, errors: errors };
}
