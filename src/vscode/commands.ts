import * as vscode from "vscode";
import { formatReport } from "../core/anonymizer";
import { RULES_TEMPLATE } from "../core/template";
import { PREVIEW_SCHEME, PreviewProvider, previewUriFor, sourceUriOf } from "./previewProvider";
import { RulesStore } from "./rulesStore";

export function registerCommands(
  a_preview: PreviewProvider,
  a_rules: RulesStore,
  a_output: vscode.OutputChannel
): vscode.Disposable[] {
  const register = (a_id: string, a_run: (a_uri?: vscode.Uri) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(`codeAnonymizer.${a_id}`, a_run);

  return [
    register("openPreview", async (a_uri) => {
      const sourceUri = activeSource(a_uri);
      if (sourceUri === undefined) {
        return;
      }
      const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
      let previewDocument = await vscode.workspace.openTextDocument(previewUriFor(sourceUri));
      if (previewDocument.languageId !== sourceDocument.languageId) {
        previewDocument = await vscode.languages.setTextDocumentLanguage(previewDocument, sourceDocument.languageId);
      }
      // already visible: switch to it, else open it beside the source
      await vscode.window.showTextDocument(previewDocument, {
        viewColumn: visibleColumnOf(previewDocument.uri) ?? vscode.ViewColumn.Beside,
        preview: false
      });
      await offerRulesCreation(a_rules, sourceUri);
    }),

    register("openSource", async (a_uri) => {
      const sourceUri = activeSource(a_uri);
      if (sourceUri === undefined) {
        return;
      }
      await vscode.window.showTextDocument(sourceUri, {
        viewColumn: visibleColumnOf(sourceUri) ?? vscode.ViewColumn.Beside,
        preview: false
      });
    }),

    register("openDiff", async (a_uri) => {
      const sourceUri = activeSource(a_uri);
      if (sourceUri === undefined) {
        return;
      }
      const name = sourceUri.path.slice(sourceUri.path.lastIndexOf("/") + 1);
      await vscode.commands.executeCommand("vscode.diff", sourceUri, previewUriFor(sourceUri), `${name} ↔ anonymized`, {
        preview: false
      });
      await offerRulesCreation(a_rules, sourceUri);
    }),

    register("editRules", async (a_uri) => {
      await openRules(a_rules, activeSource(a_uri, false));
    }),

    register("copyAnonymized", async (a_uri) => {
      const sourceUri = activeSource(a_uri);
      if (sourceUri === undefined) {
        return;
      }
      const computed = await a_preview.compute(sourceUri);
      const result = computed.result;
      const problems: string[] = [];
      if (!computed.rules.exists) {
        problems.push("no rules file was found, the code is unchanged");
      }
      if (result.errors.length > 0) {
        problems.push(`${result.errors.length} rule(s) are invalid and were skipped`);
      }
      if (result.leaks.length > 0) {
        const terms = [...new Set(result.leaks.map((a_leak) => a_leak.text))].slice(0, 5).join(", ");
        problems.push(`${result.leaks.length} forbidden term(s) are still present: ${terms}`);
      }
      if (problems.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          "The anonymized code may not be safe to share.",
          { modal: true, detail: problems.map((a_problem) => `• ${a_problem}`).join("\n") },
          "Copy Anyway"
        );
        if (choice !== "Copy Anyway") {
          return;
        }
      }
      await vscode.env.clipboard.writeText(result.text);
      vscode.window.showInformationMessage(`Anonymized ${computed.sourceName} copied (${result.changes} changes).`);
    }),

    register("showReport", async (a_uri) => {
      const sourceUri = activeSource(a_uri);
      if (sourceUri === undefined) {
        return;
      }
      const computed = a_preview.getResult(sourceUri) ?? (await a_preview.compute(sourceUri));
      const rulesLocation =
        computed.rules.uri === undefined
          ? "none (no workspace folder)"
          : computed.rules.uri.fsPath + (computed.rules.exists ? "" : " (missing)");
      a_output.clear();
      a_output.appendLine(formatReport(computed.result, computed.sourceName, rulesLocation));
      a_output.show(true);
    })
  ];
}

/// The file to anonymize: the explicit argument (menus), else the active
/// editor. On a preview, its source.
function activeSource(a_uri: vscode.Uri | undefined, a_warn = true): vscode.Uri | undefined {
  const uri = a_uri ?? vscode.window.activeTextEditor?.document.uri;
  if (uri === undefined) {
    if (a_warn) {
      vscode.window.showWarningMessage("Open a file to anonymize first.");
    }
    return undefined;
  }
  return sourceUriOf(uri);
}

function visibleColumnOf(a_uri: vscode.Uri): vscode.ViewColumn | undefined {
  const key = a_uri.toString();
  return vscode.window.visibleTextEditors.find((a_editor) => a_editor.document.uri.toString() === key)?.viewColumn;
}

async function offerRulesCreation(a_rules: RulesStore, a_sourceUri: vscode.Uri): Promise<void> {
  const loaded = await a_rules.load(a_sourceUri);
  if (loaded.exists || loaded.uri === undefined) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `No anonymization rules yet: ${vscode.workspace.asRelativePath(loaded.uri)} does not exist.`,
    "Create Rules File"
  );
  if (choice !== undefined) {
    await openRules(a_rules, a_sourceUri);
  }
}

/// Open the rules file, created from the template when missing, in a column
/// of its own so the source, the preview and the rules are side by side.
async function openRules(a_rules: RulesStore, a_sourceUri: vscode.Uri | undefined): Promise<void> {
  const rulesUri = a_rules.resolveUri(a_sourceUri);
  if (rulesUri === undefined) {
    vscode.window.showErrorMessage(
      "Open a folder, or set 'codeAnonymizer.rulesFile' to an absolute path, to store the anonymization rules."
    );
    return;
  }
  try {
    await vscode.workspace.fs.stat(rulesUri);
  } catch {
    await vscode.workspace.fs.writeFile(rulesUri, new TextEncoder().encode(RULES_TEMPLATE));
  }
  const previewVisible = vscode.window.visibleTextEditors.some((a_editor) => a_editor.document.uri.scheme === PREVIEW_SCHEME);
  const lastColumn = Math.max(0, ...vscode.window.visibleTextEditors.map((a_editor) => a_editor.viewColumn ?? 0));
  await vscode.window.showTextDocument(rulesUri, {
    viewColumn: previewVisible ? lastColumn + 1 : vscode.ViewColumn.Beside,
    preview: false
  });
}
