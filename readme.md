# Code Anonymizer

Anonymize source code before sending it to an AI for analysis: remove license headers, confidential blocks and critical algorithms, replace company types and names. The result is previewed live next to the source, and refreshed as you edit the rules.

![VS Code](https://img.shields.io/badge/VS%20Code-^1.80.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## How it works

1. Open a source file and click the **shield** button in its title bar (or `Ctrl+K A`, or right-click the file in the explorer: **Code Anonymizer**).
   A read-only preview opens beside the source. Nothing is ever written to the source file.
2. The first time, accept **Create Rules File**: `.vscode/anonymizer.json` is created with one example of each rule, and opens in a third column.
3. Edit the rules: the preview is updated **as you type**, saved or not. Autocompletion and validation come with the file.
4. Check the status bar (`Anonymizer: 22 changes`, or `2 leaks` in yellow), then click the copy button in the preview title bar: **Copy Anonymized Code**.

The source, the preview and the rules side by side: change a rule, see the result instantly.

## Commands

| Command | Where | What it does |
| --- | --- | --- |
| Switch to Anonymized Preview | file title bar (shield), `Ctrl+K A`, context menus | Opens the anonymized version of the file beside it, or switches to it when already open |
| Switch to Original File | preview title bar | Goes back to the source file of the preview |
| Compare Original with Anonymized | preview title bar, editor menu | Opens a diff editor: every change made by the rules, highlighted |
| Edit Anonymization Rules | preview title bar, editor menu | Opens the rules file, created from a template when missing |
| Copy Anonymized Code | preview title bar, editor menu | Copies the anonymized code to the clipboard |
| Show Anonymization Report | status bar, editor menu | What each rule changed, the pseudonym table, the forbidden terms left |

The **Code Anonymizer** submenu gathers these commands when you right-click a file in the explorer, an editor tab, or inside an editor.

## Rules

The rules file is a JSON file with comments. The rules run **from top to bottom, each one on the output of the previous one**: put the rules that need the original names (remove an include, a block marker) before the ones renaming them.

```jsonc
{
  "rules": [
    { "type": "removeHeader" },
    { "type": "removeBlock", "begin": "ANONYMIZE-BEGIN", "end": "ANONYMIZE-END", "replace": "// [removed]" },
    { "type": "removeFunctionBody", "name": "computeSecret|Crypto::\\w+", "replace": "// [algorithm removed]" },
    { "type": "replaceMap", "wholeWord": true, "map": { "TOTO::te_uint32_type": "uint32_t" } },
    { "type": "pseudonymize", "match": "\\bAcme\\w*", "template": "Product{n}", "caseSensitive": false }
  ],
  "forbidden": ["acme", "@acme\\.com"]
}
```

| Type | Properties | What it does |
| --- | --- | --- |
| `replace` | `find`, `replace`, `regex`, `wholeWord`, `caseSensitive`, `in` | Replaces a text, or a regular expression (`$1`... insert its groups) |
| `replaceMap` | `map`, `wholeWord`, `wildcard`, `caseSensitive`, `in` | Replaces several tokens at once, the most specific first: ideal for a table of types. Supports wildcards |
| `removeLines` | `match`, `caseSensitive` | Removes every line matching a regular expression |
| `removeBlock` | `begin`, `end`, `replace`, `keepMarkers`, `caseSensitive` | Removes the lines from a line matching `begin` to the next line matching `end`, both included |
| `removeHeader` | `match`, `replace`, `caseSensitive` | Removes the comments at the top of the file that look like a license (or match `match`) |
| `removeComments` | `keep` | Removes all comments; a line left empty is removed too |
| `removeFunctionBody` | `name`, `replace` | Keeps the signature of the matching functions, replaces their body |
| `pseudonymize` | `match`, `template`, `caseSensitive`, `in` | Replaces each distinct match by a numbered alias (`Product1`, `Product2`...), the same one everywhere in the file |

Every rule also accepts:

- `description`: shown in the report
- `enabled`: `false` keeps the rule in the file without applying it
- `languages`: language ids the rule applies to, like `["cpp", "c"]`
- `files`: globs relative to the workspace folder, like `"**/*.h"`; a glob without `/` matches the file name

Regular expressions are JavaScript ones, written in JSON strings: `\b` is written `"\\b"`. They are multiline: `^` and `$` match at line boundaries.

### Details

- **`in`** restricts a replacement to `"code"`, `"comment"` or `"string"` literals, or a list of them. Comments and strings are found by a tokenizer that knows the usual languages (C, C++, C#, Java, JS/TS, Rust, Go, Python, shell, CMake, Lua, SQL...); unknown languages are treated as C++.
- **`removeBlock`** without end marker removes everything up to the end of the file, and says so in the report: what follows an unclosed marker is assumed to be confidential.
- **`removeHeader`** groups the leading comments: comments separated by a blank line are separate groups. Each group matching (by default `copyright|licen[cs]e|\(c\)|all rights reserved|spdx`, case insensitive) is removed, the others (a `@file` description) are kept.
- **`removeFunctionBody`** tests `name` on the whole function name, qualified (`Crypto::hash`) and short (`hash`). Declarations and calls are left alone, only definitions are changed. It handles qualifiers (`const`, `noexcept`, `-> type`) and constructor initializer lists. In Python it uses the indentation, and the default body is `pass  # body removed`.
- **`replaceMap`** finds a token inside a word too: `{ "TOTO_": "" }` turns `TOTO_value` into `value`. With `"wholeWord": true`, a token is only found when no letter, digit or `_` touches it, so a prefix like `TOTO_` never matches: give that entry its own setting, `"TOTO_": { "replace": "", "wholeWord": false }`.
- **`replaceMap` wildcards**, often simpler to think about than a regex: with `"wildcard": true`, `*` matches the rest of an identifier (letters, digits, `_`, possibly nothing), `?` exactly one of these characters, and `$1`, `$2`... reuse what they matched, in order. `"TOTO::te_*_type": "$1_t"` turns `TOTO::te_uint32_type` into `uint32_t`. `\\*` and `\\?` (in JSON) are a literal star and question mark. The keys are tried from the most specific (the most literal characters) to the least, so `"TOTO::te_bool_type": "bool"` wins over `"TOTO::te_*_type"`. Like `wholeWord`, `wildcard` can be set on the rule or on one entry: `"TOTO_*": { "replace": "$1", "wildcard": true }`.
- **`pseudonymize`** lists the mapping in the report (`Product2 ← AcmeFrameEncoder`), so you can translate the AI's answer back.

## Advanced examples

Each example shows the rule, then the code before and after. They are taken from the test suite of the rules, so the results are real.

### A whole table of types, with wildcards

One line per family of types instead of one per type; the exact keys stay for the exceptions.

```jsonc
{
  "type": "replaceMap",
  "wildcard": true,
  "wholeWord": true,
  "map": {
    "TOTO::te_*_type": "$1_t",       // TOTO::te_uint32_type -> uint32_t
    "TOTO::te_*_ptr": "$1_t*",       // TOTO::te_int8_ptr    -> int8_t*
    "TOTO::te_bool_type": "bool"     // more specific than te_*_type: tried first
  }
}
```

```cpp
TOTO::te_uint32_type a;          →   uint32_t a;
TOTO::te_bool_type ok;           →   bool ok;
TOTO::te_int8_ptr p;             →   int8_t* p;
```

### Company prefixes on every identifier

`?` takes one character: `TT?_*` covers `TT1_`, `TT2_`... and `$2` is the part after the prefix.

```jsonc
{ "type": "replaceMap", "wildcard": true, "wholeWord": true, "map": { "TOTO_*": "$1", "TT?_*": "$2" } }
```

```cpp
TOTO_Engine engine;                    →   Engine engine;
TT1_Buffer buf = TOTO_make();          →   Buffer buf = make();
```

### Internal include paths

A regex with a group: keep the file name, drop the path that names the product.

```jsonc
{ "type": "replace", "regex": true, "find": "#include\\s+\"toto/(?:\\w+/)*(\\w+\\.h)\"", "replace": "#include \"$1\"" }
```

```cpp
#include "toto/core/net/socket.h"   →   #include "socket.h"
```

### Logs and traces

Logging macros often carry product names, customer ids or internal messages. Remove the whole lines:

```jsonc
{ "type": "removeLines", "match": "^\\s*TOTO_(LOG|TRACE|ASSERT)\\w*\\s*\\(" }
```

```cpp
int f() {                              int f() {
    TOTO_LOG_INFO("start %d", 1);  →       return 1;
    return 1;                          }
    TOTO_TRACE("end");
}
```

`removeLines` works line by line: a call spread over several lines leaves its continuation lines.

### A whole class, without markers in the code

`removeBlock` does not need special comments: any pair of regexes works. Here, from the class declaration to the `};` at column 0 that closes it:

```jsonc
{ "type": "removeBlock", "begin": "^class\\s+SecretEngine\\b", "end": "^\\};", "replace": "class SecretEngine; // [removed]" }
```

```cpp
class Public {};                       class Public {};
class SecretEngine : public Base { →   class SecretEngine; // [removed]
    int m_key;                         int main();
};
int main();
```

### Every algorithm of a folder

`files` limits a rule to some files, and the name `.*` matches every function. Here, all the functions of `src/crypto/` keep their signature and lose their body:

```jsonc
{ "type": "removeFunctionBody", "files": "src/crypto/**", "name": ".*", "replace": "// [removed]" }
```

```cpp
static int mix(int a) {                static int mix(int a) {
    return a * 31;                 →       // [removed]
}                                      }
int Aes::encrypt(int b) const {        int Aes::encrypt(int b) const {
    return mix(b) ^ 7;                     // [removed]
}                                      }
```

### Emails and tickets in comments only

`"in": "comment"` leaves the code and its strings alone:

```jsonc
{ "type": "replace", "regex": true, "in": "comment", "find": "[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+", "replace": "<email>" },
{ "type": "replace", "regex": true, "in": "comment", "caseSensitive": false, "find": "\\b(JIRA|TOTO)-\\d+\\b", "replace": "<ticket>" }
```

```cpp
// fixed by john.doe@toto.com, see TOTO-1234   →   // fixed by <email>, see <ticket>
send("ops@toto.com"); // TOTO-99               →   send("ops@toto.com"); // <ticket>
```

The address in the string is still there: that is what `forbidden` is for (below).

### Customer names in strings

`pseudonymize` with `"in": "string"`: the same customer gets the same alias everywhere, the code keeps working the same way, and the report gives the mapping to read the AI's answer.

```jsonc
{ "type": "pseudonymize", "in": "string", "match": "\\b(Meta|Microsoft|Google)\\b", "template": "Customer{n}" }
```

```cpp
const char* c = "Meta";                          →   const char* c = "Customer1";
if (name == "Google" || name == "Meta") {}       →   if (name == "Customer2" || name == "Customer1") {}
```

### Python only

`languages` restricts a rule to a language. Here, the private functions and the `compute_` ones of the Python files:

```jsonc
{ "type": "removeFunctionBody", "languages": "python", "name": "_.*|compute_\\w+" }
```

```python
def _secret(x):                        def _secret(x):
    return x * 42                  →       pass  # body removed
```

### A safety net for what the rules missed

```jsonc
"forbidden": [
  "toto",                                       // the company name, anywhere, in any case
  "[\\w.+-]+@[\\w-]+\\.\\w+",                   // any email address
  "\\b10\\.\\d+\\.\\d+\\.\\d+\\b",              // private IP addresses
  "https?://[\\w.-]+\\.(local|corp|intra)\\b"   // internal URLs
]
```

Each match left in the result is underlined in the preview, and copying asks for a confirmation.

## Forbidden terms

`forbidden` lists regular expressions, case insensitive, that must not survive: your company name, an email domain, a project code name. They are the safety net for what the rules missed:

- each occurrence left is underlined in the preview, and listed in the Problems panel
- the status bar turns yellow: `Anonymizer: 2 leaks`
- **Copy Anonymized Code** asks for a confirmation, as it does when a rule is invalid or when no rules file exists

## Where the rules are

By default, `.vscode/anonymizer.json` in the workspace folder of the file. The `codeAnonymizer.rulesFile` setting changes it: a path relative to the workspace folder, or an absolute path, to share one company-wide rules file between all your projects.

The rules file is validated while you type: errors are shown in the file and in the Problems panel, the status bar turns red, and the invalid rules are skipped while the valid ones still apply.

## Limitations

- The tokenizer is not a compiler: macros generating functions, or unusual syntaxes, may escape `removeFunctionBody`. Check the diff, and use `forbidden` as a safety net.
- One file at a time.
