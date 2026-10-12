import { ParsedConfig } from "./config";
import { getSyntax } from "./lexer";
import { RuleContext, RuleOutcome, RuleTarget } from "./rules";
import { detectEol, errorMessage, positionAt } from "./text";

export interface RuleReport {
  readonly label: string;
  /// false when disabled or filtered out by "languages" / "files"
  readonly applied: boolean;
  readonly count: number;
  readonly warnings: readonly string[];
}

/// A forbidden term still present in the anonymized text.
export interface Leak {
  readonly term: string;
  readonly text: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface Pseudonym {
  readonly original: string;
  readonly alias: string;
  readonly rule: string;
}

export interface AnonymizeResult {
  readonly text: string;
  readonly rules: readonly RuleReport[];
  readonly leaks: readonly Leak[];
  readonly pseudonyms: readonly Pseudonym[];
  readonly errors: readonly string[];
  readonly changes: number;
}

/// Apply the rules in order, each one on the output of the previous one, then
/// look for the forbidden terms in the result.
export function anonymize(a_text: string, a_config: ParsedConfig, a_target: RuleTarget): AnonymizeResult {
  const context: RuleContext = {
    ...a_target,
    syntax: getSyntax(a_target.languageId),
    eol: detectEol(a_text)
  };
  let text = a_text;
  const reports: RuleReport[] = [];
  const pseudonyms: Pseudonym[] = [];
  for (const rule of a_config.rules) {
    if (!rule.enabled || !rule.appliesTo(a_target)) {
      reports.push({ label: rule.label, applied: false, count: 0, warnings: [] });
      continue;
    }
    const outcome: RuleOutcome = { count: 0, warnings: [], pseudonyms: [] };
    try {
      text = rule.apply(text, context, outcome);
    } catch (a_error) {
      outcome.warnings.push(`failed, rule skipped: ${errorMessage(a_error)}`);
    }
    reports.push({ label: rule.label, applied: true, count: outcome.count, warnings: outcome.warnings });
    for (const [original, alias] of outcome.pseudonyms) {
      pseudonyms.push({ original: original, alias: alias, rule: rule.label });
    }
  }
  return {
    text: text,
    rules: reports,
    leaks: findLeaks(text, a_config),
    pseudonyms: pseudonyms,
    errors: a_config.errors.map((a_error) => a_error.message),
    changes: reports.reduce((a_sum, a_report) => a_sum + a_report.count, 0)
  };
}

function findLeaks(a_text: string, a_config: ParsedConfig): Leak[] {
  const leaks: Leak[] = [];
  for (const term of a_config.forbidden) {
    for (const match of a_text.matchAll(term.pattern)) {
      const offset = match.index ?? 0;
      const position = positionAt(a_text, offset);
      leaks.push({ term: term.source, text: match[0], offset: offset, line: position.line, column: position.column });
    }
  }
  return leaks.sort((a_left, a_right) => a_left.offset - a_right.offset);
}

/// Plain text report, for the output channel and the status bar tooltip.
export function formatReport(a_result: AnonymizeResult, a_sourceName: string, a_rulesLocation: string): string {
  const lines: string[] = [];
  lines.push(`Anonymization of ${a_sourceName}`);
  lines.push(`Rules: ${a_rulesLocation}`);
  lines.push("");
  if (a_result.errors.length > 0) {
    lines.push(`Configuration errors (${a_result.errors.length}):`);
    lines.push(...a_result.errors.map((a_error) => `  ✗ ${a_error}`));
    lines.push("");
  }
  lines.push(`Rules (${a_result.changes} changes):`);
  if (a_result.rules.length === 0) {
    lines.push("  (none)");
  }
  for (const rule of a_result.rules) {
    lines.push(rule.applied ? `  ${String(rule.count).padStart(4)}  ${rule.label}` : `     -  ${rule.label} [skipped]`);
    lines.push(...rule.warnings.map((a_warning) => `        ⚠ ${a_warning}`));
  }
  lines.push("");
  if (a_result.pseudonyms.length > 0) {
    lines.push(`Pseudonyms (${a_result.pseudonyms.length}):`);
    lines.push(...a_result.pseudonyms.map((a_entry) => `  ${a_entry.alias}  ←  ${a_entry.original}`));
    lines.push("");
  }
  if (a_result.leaks.length === 0) {
    lines.push("Forbidden terms: none left ✓");
  } else {
    lines.push(`Forbidden terms still present (${a_result.leaks.length}):`);
    lines.push(
      ...a_result.leaks.map(
        (a_leak) => `  ✗ line ${a_leak.line + 1}, column ${a_leak.column + 1}: "${a_leak.text}" (matches ${a_leak.term})`
      )
    );
  }
  return lines.join("\n");
}
