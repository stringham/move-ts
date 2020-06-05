'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {FileItem} from './fileitem';
import {ReferenceIndexer, isInDir} from './index/referenceindexer';

function warn(importer: ReferenceIndexer): Thenable<boolean> {
    if (importer.conf('skipWarning', false) || importer.conf('openEditors', false)) {
        return Promise.resolve(true);
    }
    return vscode.window
        .showWarningMessage(
            'This will save all open editors and all changes will immediately be saved. Do you want to continue?',
            'Yes, I understand'
        )
        .then((response: string|undefined): any => {
            if (response == 'Yes, I understand') {
                return true;
            } else {
                return false;
            }
        });
}

function warnThenMove(importer: ReferenceIndexer, item: FileItem): Thenable<any> {
    return warn(importer).then((success: boolean): any => {
        if (success) {
            return vscode.workspace.saveAll(false).then((): any => {
                importer.startNewMove(item.sourcePath, item.targetPath);
                const move = item.move(importer);
                move.catch(e => {
                    console.log('error in extension.ts', e);
                });
                if (!item.isDir) {
                    return move
                        .then(item => {
                            return Promise.resolve(
                                              vscode.workspace.openTextDocument(item.targetPath)
                            ).then((textDocument: vscode.TextDocument) => vscode.window.showTextDocument(textDocument));
                        })
                        .catch(e => {
                            console.log('error in extension.ts', e);
                        });
                }
                return move;
            });
        }
        return undefined;
    });
}

function move(importer: ReferenceIndexer, fsPath: string) {
    const isDir = fs.statSync(fsPath).isDirectory();
    return vscode.window.showInputBox({prompt: 'Where would you like to move?', value: fsPath}).then(value => {
        if (!value || value == fsPath) {
            return;
        }
        const item: FileItem = new FileItem(fsPath, value, isDir);
        if (item.exists()) {
            vscode.window.showErrorMessage(value + ' already exists.');
            return;
        }
        if (item.isDir && isInDir(fsPath, value)) {
            vscode.window.showErrorMessage('Cannot move a folder within itself');
            return;
        }
        return warnThenMove(importer, item);
    });
}

function moveMultiple(importer: ReferenceIndexer, paths: string[], newLocationPaths: string[]): Thenable<any> {

    const newLocations = newLocationPaths.map((newLocationPath, i) => {
        const p = paths[i]
        const newLocation = path.resolve(newLocationPath, path.basename(p));
        return new FileItem(p, newLocation, fs.statSync(p).isDirectory());
    })

    if (newLocations.some(l => l.exists())) {
        vscode.window.showErrorMessage('Not allowed to overwrite existing files');
    }

    if (newLocations.some(l => l.isDir && isInDir(l.sourcePath, l.targetPath))) {
        vscode.window.showErrorMessage('Cannot move a folder within itself');
    }

    return warn(importer).then((success: boolean): any => {
        if (success) {
            return vscode.workspace.saveAll(false).then(() => {
                importer.startNewMoves(newLocations);

                const moveAll = async () => {
                    for(let i = 0; i < newLocations.length; i++) {
                        // Handle one at a time to prevent conflicts.
                        await newLocations[i].move(importer)
                        const parsed = path.parse(newLocations[i].targetPath)
                        const indexPath = `${parsed.dir}/index.ts`
                        if (!fs.existsSync(indexPath)) {
                            const code = `export * from './${parsed.name}';\n`
                            fs.writeFile(indexPath, code, (error) => {
                                if (error) {
                                    vscode.window.showErrorMessage(`Could not create ${indexPath}`);
                                } else {
                                    console.log(`${indexPath}`)
                                }
                            })
                        }
                    }
                }

                return moveAll()
            });
        }
    });
}

function getCurrentPath(): string {
    const activeEditor = vscode.window.activeTextEditor;
    const document = activeEditor && activeEditor.document;

    return (document && document.fileName) || '';
}

export function activate(context: vscode.ExtensionContext) {
    const importer: ReferenceIndexer = new ReferenceIndexer();

    function initWithProgress() {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Move-ts indexing',
            },
            async (progress) => {
                return importer.init(progress);
            }
        );
    }

    const initialize = () => {
        if (importer.isInitialized) {
            return Promise.resolve();
        }
        return initWithProgress();
    };

    const moveDisposable = vscode.commands.registerCommand('move-ts.move', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        if (uri?.path && vscode.workspace.rootPath) {
            const workspacePath = uri.path.replace(`${vscode.workspace.rootPath}/`, '')
            vscode.workspace.findFiles(`${workspacePath}/**/*.tsx`, '**/node_modules/**', 100000).then(files => {
                console.log(files)
                const toMoveUris: vscode.Uri[] = []
                const newLocationPaths: string[] = []
                files.filter((file) => {
                    const fileParts = file.path.split('/')
                    const parsed = path.parse(file.path)
                    const dirname = path.dirname(file.path)
                    const dirnameParts = dirname.split('/')
                    const parentFolder = dirnameParts[dirnameParts.length - 1]
                    const fileName = parsed.name
                    const isComponent = fileName[0].toUpperCase() === fileName[0]
                    
                    if (parentFolder !== fileName && isComponent) {
                        toMoveUris.push(file)
                        newLocationPaths.push(`${dirname}/${fileName}`)
                    }
                    console.log(fileName)
                   console.log(parentFolder)
                })

                if (toMoveUris && toMoveUris.length > 1) {
                    const dir = path.dirname(toMoveUris[0].fsPath);
                        return initialize().then(() => {
                            return moveMultiple(importer, toMoveUris.map(u => u.fsPath), newLocationPaths);
                        });
                }
            });
        }
    });
    context.subscriptions.push(moveDisposable);

    const reIndexDisposable = vscode.commands.registerCommand('move-ts.reindex', () => {
        return initWithProgress();
    });
    context.subscriptions.push(reIndexDisposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}
