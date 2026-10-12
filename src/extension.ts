import * as vscode from "vscode";
import { registerCommands } from "./vscode/commands";
import { PREVIEW_SCHEME, PreviewProvider } from "./vscode/previewProvider";
import { RulesStore } from "./vscode/rulesStore";
import { StatusBar } from "./vscode/statusBar";

export function activate(a_context: vscode.ExtensionContext): void {
  const rules = new RulesStore();
  const diagnostics = vscode.languages.createDiagnosticCollection("AI Code Anonymizer");
  const preview = new PreviewProvider(rules, diagnostics);
  const output = vscode.window.createOutputChannel("AI Code Anonymizer");
  a_context.subscriptions.push(
    rules,
    diagnostics,
    preview,
    output,
    new StatusBar(preview),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),
    ...registerCommands(preview, rules, output)
  );
}

export function deactivate(): void {
  // Every disposable is owned by the extension context
}
