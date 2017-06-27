# Move TS README

Supports moving typescript files and updating relative imports within the workspace.

## Features
Moves TypeScript files and folders containing TypeScript and updates their relative import paths.

## How to use

![demo](images/usage.gif)

<!--## Extension Settings-->

<!--## Known Issues-->

## Release Notes

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