# Change Log

All notable changes to the "Code Anonymizer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.2] - 2026-10-12

### Added

- `replaceMap` wildcards (`"wildcard": true`, on the rule or on an entry): `*` is the rest of an identifier, `?` one character, and `$1`, `$2`... reuse them in the replacement: `"TOTO::te_*_type": "$1_t"`. The most specific keys are tried first.
- Advanced examples in the readme: type tables, prefixes, includes, logs, whole classes, whole folders, emails and tickets in comments, customer names in strings, Python, forbidden terms.
- `replaceMap`: an entry can override the `wholeWord` and `wildcard` of its rule, `"TOTO_": { "replace": "", "wholeWord": false }`, to remove a prefix inside a word in a map of whole types. The template shows it.

## [0.0.1] - 2026-10-12

### Added

- Anonymized preview of the current file, beside it: shield button in the file title bar (`Ctrl+K A`), and a button in the preview to switch back to the original. The preview is refreshed live when the source or the rules change, saved or not.
- Code Anonymizer submenu on files in the explorer, on editor tabs and in the editor.
- Diff between the original and the anonymized file.
- Rules file (`.vscode/anonymizer.json`, JSON with comments) created from a template, with a JSON schema for autocompletion and validation.
- Rules: `replace`, `replaceMap`, `removeLines`, `removeBlock`, `removeHeader`, `removeComments`, `removeFunctionBody`, `pseudonymize`, filtered by language and by file glob.
- Forbidden terms: highlighted in the preview when still present, and confirmation before copying.
- Copy of the anonymized code, report of the changes and of the pseudonyms, status bar summary.
- VS Code for the Web support through a browser bundle.
