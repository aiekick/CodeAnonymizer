import * as vscode from "vscode";
import { PreviewProvider, sourceUriOf } from "./previewProvider";

/// Summary of the anonymization of the active file: changes, leaks, errors.
/// Visible only while the file has a preview open.
export class StatusBar implements vscode.Disposable {
  private readonly m_item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly m_disposables: vscode.Disposable[] = [];

  constructor(private readonly m_preview: PreviewProvider) {
    this.m_item.command = "codeAnonymizer.showReport";
    this.m_disposables.push(
      this.m_item,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      m_preview.onDidUpdateResult(() => this.update()),
      vscode.workspace.onDidCloseTextDocument(() => this.update())
    );
  }

  dispose(): void {
    this.m_disposables.forEach((a_disposable) => a_disposable.dispose());
  }

  private update(): void {
    const editor = vscode.window.activeTextEditor;
    const sourceUri = editor === undefined ? undefined : sourceUriOf(editor.document.uri);
    const computed = sourceUri === undefined ? undefined : this.m_preview.getResult(sourceUri);
    if (sourceUri === undefined || computed === undefined || !this.m_preview.isPreviewOpen(sourceUri)) {
      this.m_item.hide();
      return;
    }
    const result = computed.result;
    if (result.errors.length > 0) {
      this.m_item.text = `$(error) Anonymizer: ${plural(result.errors.length, "rules error")}`;
      this.m_item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (result.leaks.length > 0) {
      this.m_item.text = `$(warning) Anonymizer: ${plural(result.leaks.length, "leak")}`;
      this.m_item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (!computed.rules.exists) {
      this.m_item.text = "$(shield) Anonymizer: no rules";
      this.m_item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.m_item.text = `$(shield) Anonymizer: ${plural(result.changes, "change")}`;
      this.m_item.backgroundColor = undefined;
    }
    this.m_item.tooltip = "Show the anonymization report";
    this.m_item.show();
  }
}

function plural(a_count: number, a_word: string): string {
  return `${a_count} ${a_word}${a_count === 1 ? "" : "s"}`;
}
