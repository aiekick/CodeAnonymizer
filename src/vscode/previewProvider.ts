import * as vscode from "vscode";
import { AnonymizeResult, anonymize } from "../core/anonymizer";
import { positionAt } from "../core/text";
import { LoadedRules, RulesStore } from "./rulesStore";

export const PREVIEW_SCHEME = "anonymized";

const REFRESH_DELAY_MS = 150;

export interface PreviewResult {
  readonly sourceUri: vscode.Uri;
  readonly sourceName: string;
  readonly rules: LoadedRules;
  readonly result: AnonymizeResult;
}

/// "main.cpp" is previewed as "anonymized:/.../main.anonymized.cpp": the
/// extension is kept for the syntax highlighting, the source is in the query.
export function previewUriFor(a_sourceUri: vscode.Uri): vscode.Uri {
  const path = a_sourceUri.path;
  const nameStart = path.lastIndexOf("/") + 1;
  const dot = path.lastIndexOf(".");
  const previewPath =
    dot > nameStart ? `${path.slice(0, dot)}.anonymized${path.slice(dot)}` : `${path}.anonymized`;
  return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: previewPath, query: a_sourceUri.toString() });
}

export function sourceUriOf(a_uri: vscode.Uri): vscode.Uri {
  return a_uri.scheme === PREVIEW_SCHEME ? vscode.Uri.parse(a_uri.query) : a_uri;
}

/// Read-only virtual documents holding the anonymized text, recomputed when
/// the source or the rules change.
export class PreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly m_onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.m_onDidChange.event;
  private readonly m_onDidUpdateResult = new vscode.EventEmitter<vscode.Uri>();
  /// Fired with the source uri after each computation
  readonly onDidUpdateResult = this.m_onDidUpdateResult.event;
  private readonly m_results = new Map<string, PreviewResult>();
  private readonly m_timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly m_disposables: vscode.Disposable[] = [];

  constructor(
    private readonly m_rules: RulesStore,
    private readonly m_diagnostics: vscode.DiagnosticCollection
  ) {
    this.m_disposables.push(
      this.m_onDidChange,
      this.m_onDidUpdateResult,
      vscode.workspace.onDidChangeTextDocument((a_event) => this.onSourceChanged(a_event.document.uri)),
      vscode.workspace.onDidCloseTextDocument((a_document) => {
        if (a_document.uri.scheme === PREVIEW_SCHEME) {
          this.m_diagnostics.delete(a_document.uri);
        }
      }),
      m_rules.onDidChange(() => this.openPreviews().forEach((a_uri) => this.scheduleRefresh(a_uri)))
    );
  }

  dispose(): void {
    this.m_timers.forEach((a_timer) => clearTimeout(a_timer));
    this.m_disposables.forEach((a_disposable) => a_disposable.dispose());
  }

  async provideTextDocumentContent(a_uri: vscode.Uri): Promise<string> {
    const computed = await this.compute(sourceUriOf(a_uri));
    this.publishDiagnostics(a_uri, computed);
    return computed.result.text;
  }

  /// Last result computed for a source, if any.
  getResult(a_sourceUri: vscode.Uri): PreviewResult | undefined {
    return this.m_results.get(a_sourceUri.toString());
  }

  async compute(a_sourceUri: vscode.Uri): Promise<PreviewResult> {
    const document = await vscode.workspace.openTextDocument(a_sourceUri);
    const rules = await this.m_rules.load(a_sourceUri);
    const result = anonymize(document.getText(), rules.config, {
      languageId: document.languageId,
      relativePath: vscode.workspace.asRelativePath(a_sourceUri, false)
    });
    const computed: PreviewResult = {
      sourceUri: a_sourceUri,
      sourceName: a_sourceUri.path.slice(a_sourceUri.path.lastIndexOf("/") + 1),
      rules: rules,
      result: result
    };
    this.m_results.set(a_sourceUri.toString(), computed);
    this.publishRulesDiagnostics(rules);
    this.m_onDidUpdateResult.fire(a_sourceUri);
    return computed;
  }

  isPreviewOpen(a_sourceUri: vscode.Uri): boolean {
    const previewKey = previewUriFor(a_sourceUri).toString();
    return this.openPreviews().some((a_uri) => a_uri.toString() === previewKey);
  }

  private openPreviews(): vscode.Uri[] {
    return vscode.workspace.textDocuments
      .filter((a_document) => a_document.uri.scheme === PREVIEW_SCHEME && !a_document.isClosed)
      .map((a_document) => a_document.uri);
  }

  private onSourceChanged(a_uri: vscode.Uri): void {
    if (a_uri.scheme === PREVIEW_SCHEME) {
      return;
    }
    const sourceKey = a_uri.toString();
    for (const previewUri of this.openPreviews()) {
      if (sourceUriOf(previewUri).toString() === sourceKey) {
        this.scheduleRefresh(previewUri);
      }
    }
  }

  private scheduleRefresh(a_previewUri: vscode.Uri): void {
    const key = a_previewUri.toString();
    clearTimeout(this.m_timers.get(key));
    this.m_timers.set(
      key,
      setTimeout(() => {
        this.m_timers.delete(key);
        this.m_onDidChange.fire(a_previewUri);
      }, REFRESH_DELAY_MS)
    );
  }

  /// Forbidden terms left in the output, shown as warnings in the preview.
  private publishDiagnostics(a_previewUri: vscode.Uri, a_computed: PreviewResult): void {
    this.m_diagnostics.set(
      a_previewUri,
      a_computed.result.leaks.map((a_leak) => {
        const start = new vscode.Position(a_leak.line, a_leak.column);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, start.translate(0, a_leak.text.length)),
          `Forbidden term still present: "${a_leak.text}" (matches ${a_leak.term})`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = "AI Code Anonymizer";
        return diagnostic;
      })
    );
  }

  /// Configuration errors, shown in the rules file while it is edited.
  private publishRulesDiagnostics(a_rules: LoadedRules): void {
    if (a_rules.uri === undefined) {
      return;
    }
    const rulesDocument = vscode.workspace.textDocuments.find(
      (a_document) => a_document.uri.toString() === a_rules.uri!.toString()
    );
    this.m_diagnostics.set(
      a_rules.uri,
      a_rules.config.errors.map((a_error) => {
        let range = new vscode.Range(0, 0, 0, 1);
        if (a_error.offset !== undefined && rulesDocument !== undefined) {
          const position = positionAt(rulesDocument.getText(), a_error.offset);
          range = new vscode.Range(position.line, position.column, position.line, position.column + 1);
        }
        const diagnostic = new vscode.Diagnostic(range, a_error.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = "AI Code Anonymizer";
        return diagnostic;
      })
    );
  }
}
