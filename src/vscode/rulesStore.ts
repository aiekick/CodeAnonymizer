import * as vscode from "vscode";
import { EMPTY_CONFIG, ParsedConfig, parseConfig } from "../core/config";

export const DEFAULT_RULES_FILE = ".vscode/anonymizer.json";

export interface LoadedRules {
  /// undefined when no location can be resolved (no workspace, relative path)
  readonly uri: vscode.Uri | undefined;
  readonly exists: boolean;
  readonly config: ParsedConfig;
}

/// Loads and caches the rules file of each source. The text of an open rules
/// document is used as is, unsaved: editing the rules refreshes the preview
/// at every keystroke.
export class RulesStore implements vscode.Disposable {
  private readonly m_onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this.m_onDidChange.event;
  private readonly m_cache = new Map<string, Promise<LoadedRules>>();
  private readonly m_disposables: vscode.Disposable[] = [];
  private m_watchers: vscode.Disposable[] = [];

  constructor() {
    this.m_disposables.push(
      this.m_onDidChange,
      vscode.workspace.onDidChangeTextDocument((a_event) => this.invalidate(a_event.document.uri)),
      // closing an unsaved rules document reverts to the file on disk
      vscode.workspace.onDidCloseTextDocument((a_document) => this.invalidate(a_document.uri)),
      vscode.workspace.onDidChangeConfiguration((a_event) => {
        if (a_event.affectsConfiguration("codeAnonymizer.rulesFile")) {
          this.reset();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reset())
    );
    this.watch();
  }

  dispose(): void {
    this.m_watchers.forEach((a_watcher) => a_watcher.dispose());
    this.m_disposables.forEach((a_disposable) => a_disposable.dispose());
  }

  /// Location of the rules applying to a source: the "codeAnonymizer.rulesFile"
  /// setting, absolute or relative to the workspace folder of the source.
  resolveUri(a_sourceUri: vscode.Uri | undefined): vscode.Uri | undefined {
    const setting = vscode.workspace
      .getConfiguration("codeAnonymizer", a_sourceUri)
      .get<string>("rulesFile", DEFAULT_RULES_FILE)
      .trim() || DEFAULT_RULES_FILE;
    if (isAbsolutePath(setting)) {
      return vscode.Uri.file(setting);
    }
    const folder =
      (a_sourceUri !== undefined ? vscode.workspace.getWorkspaceFolder(a_sourceUri) : undefined) ??
      vscode.workspace.workspaceFolders?.[0];
    return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, setting);
  }

  load(a_sourceUri: vscode.Uri): Promise<LoadedRules> {
    const uri = this.resolveUri(a_sourceUri);
    if (uri === undefined) {
      return Promise.resolve({ uri: undefined, exists: false, config: EMPTY_CONFIG });
    }
    const key = uri.toString();
    let loaded = this.m_cache.get(key);
    if (loaded === undefined) {
      loaded = read(uri);
      this.m_cache.set(key, loaded);
    }
    return loaded;
  }

  private invalidate(a_uri: vscode.Uri): void {
    if (this.m_cache.delete(a_uri.toString())) {
      this.m_onDidChange.fire();
    }
  }

  private reset(): void {
    this.m_cache.clear();
    this.watch();
    this.m_onDidChange.fire();
  }

  /// File system watchers catch changes made outside of the editor
  /// (git checkout, another tool), and the creation of a missing file.
  private watch(): void {
    this.m_watchers.forEach((a_watcher) => a_watcher.dispose());
    this.m_watchers = [];
    const patterns: vscode.RelativePattern[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = this.resolveUri(folder.uri);
      if (uri !== undefined) {
        const parent = vscode.Uri.joinPath(uri, "..");
        patterns.push(new vscode.RelativePattern(parent, uri.path.slice(uri.path.lastIndexOf("/") + 1)));
      }
    }
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onFileEvent = (a_uri: vscode.Uri): void => this.invalidate(a_uri);
      watcher.onDidCreate(onFileEvent);
      watcher.onDidChange(onFileEvent);
      watcher.onDidDelete(onFileEvent);
      this.m_watchers.push(watcher);
    }
  }
}

async function read(a_uri: vscode.Uri): Promise<LoadedRules> {
  const openDocument = vscode.workspace.textDocuments.find((a_document) => a_document.uri.toString() === a_uri.toString());
  if (openDocument !== undefined) {
    return { uri: a_uri, exists: true, config: parseConfig(openDocument.getText()) };
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(a_uri);
    return { uri: a_uri, exists: true, config: parseConfig(new TextDecoder().decode(bytes)) };
  } catch {
    return { uri: a_uri, exists: false, config: EMPTY_CONFIG };
  }
}

function isAbsolutePath(a_path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(a_path);
}
