# Move TS README

Supports moving typescript files and updating relative imports within the workspace.

## Features
Moves TypeScript files and folders containing TypeScript and updates their relative import paths.

## How to use

![demo](images/usage.gif)

<!--## Extension Settings-->

<!--## Known Issues-->

## Release Notes

## 1.10.0

Added an option to make edits in vscode instead of changing the files on disk. This makes each file changed open in a new tab. To enable set `movets.openEditors` to `true` in User Settings. For large projects sometimes vscode struggles to open all of the files.

## 1.9.0

Added the ability to resolve relative paths based on the location of `tsconfig.json`. To enable set `movets.relativeToTsconfig` to `true` in User Settings.

## 1.8.2

Fix a bug when a moved file has two import statements using the same module specifier.

## 1.8.1

Improve indexing performance using the TypeScript parser.

## 1.8.0

Use the TypeScript parser instead of regular expressions to find and replace imports.

## 1.7.1

Fix bug with indexing in Windows.

## 1.7.0

Improve performance of indexing the workspace.

## 1.6.0

Report progress with vscode's withProgress extension api when indexing the workspace.

## 1.5.0

Added support for `tsconfig.json` CompilerOptions -> paths.

## 1.4.0

Added support for `*.tsx` files.

New configuration option that can limit which paths are scanned: `movets.filesToScan` should be an array of strings and defaults to `['**/*.ts', '**/*.tsx']`

### 1.3.1

Allow initiating moving the current file with a hotkey. To use edit keybindings.json and add:

```json
{
    "key": "ctrl+alt+m",
    "command": "move-ts.move",
    "when": "editorTextFocus"
}
```
### 1.3.0

Support updating relative paths in export statements
### 1.2.0

Support for Windows paths

### 1.1.0

Add `movets.skipWarning` configuration option

### 1.0.0

Initial release of Move TS