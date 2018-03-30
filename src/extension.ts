'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {FileItem} from './fileitem';
import {ReferenceIndexer, isInDir} from './index/referenceindexer';

function warn(importer: ReferenceIndexer): Thenable<boolean> {
    if(importer.conf('skipWarning', false) || importer.conf('openEditors', false)) {
        return Promise.resolve(true);
    }
    return vscode.window.showWarningMessage('This will save all open editors and all changes will immediately be saved. Do you want to continue?', 'Yes, I understand').then((response:string|undefined):any => {
        if (response == 'Yes, I understand') {
            return true;
        } else {
            return false;
        }
    })
}

function warnThenMove(importer:ReferenceIndexer, item:FileItem):Thenable<any> {
    return warn(importer).then((success: boolean): any => {
        if(success) {
            return vscode.workspace.saveAll(false).then((): any => {
                importer.startNewMove(item.sourcePath, item.targetPath);
                let move = item.move(importer)
                move.catch(e => {
                    console.log('error in extension.ts', e);
                });
                if (!item.isDir) {
                    return move.then(item => {
                        return Promise.resolve(vscode.workspace.openTextDocument(item.targetPath))
                            .then((textDocument: vscode.TextDocument) => vscode.window.showTextDocument(textDocument));
                    }).catch(e => {
                        console.log('error in extension.ts', e);
                    });
                }
                return move;
            });
        }
        return undefined;
    })

}

function move(importer:ReferenceIndexer, fsPath:string) {
    const isDir = fs.statSync(fsPath).isDirectory();
    return vscode.window.showInputBox({
        prompt: 'Where would you like to move?',
        value: fsPath
    }).then(value => {
        if (!value || value == fsPath) {
            return;
        }
        let item: FileItem = new FileItem(fsPath, value, isDir);
        if (item.exists()) {
            vscode.window.showErrorMessage(value + ' already exists.');
            return;
        }
        if(item.isDir && isInDir(fsPath, value)) {
            vscode.window.showErrorMessage('Cannot move a folder within itself');
            return;
        }
        return warnThenMove(importer, item);
    })
}

function moveMultiple(importer: ReferenceIndexer, paths: string[]): Thenable<any> {
    const dir = path.dirname(paths[0]);
    if(!paths.every(p => path.dirname(p) == dir)) {
        return Promise.resolve();
    }

    return vscode.window.showInputBox({
        prompt: 'Which directory would you like to move these to?',
        value: dir
    }).then((value):any => {
        if(!value || path.extname(value) != '') {
            vscode.window.showErrorMessage('Must be moving to a directory');
            return;
        }
        const newLocations = paths.map(p => {
            const newLocation = path.resolve(value, path.basename(p));
            return new FileItem(p, newLocation, fs.statSync(p).isDirectory());
        });

        if(newLocations.some(l => l.exists())) {
            vscode.window.showErrorMessage('Not allowed to overwrite existing files');
            return;
        }

        if(newLocations.some(l => l.isDir && isInDir(l.sourcePath, l.targetPath))) {
            vscode.window.showErrorMessage('Cannot move a folder within itself');
            return;
        }

        return warn(importer).then((success: boolean): any => {
            if(success) {
                return vscode.workspace.saveAll(false).then(() => {
                    importer.startNewMoves(newLocations);
                    let move = FileItem.moveMultiple(newLocations, importer);
                    move.catch(e => {
                        console.log('error in extension.ts', e);
                    });
                    return move;
                });
            }
        })
    });
}

function getCurrentPath():string {
    let activeEditor = vscode.window.activeTextEditor;
    let document = activeEditor && activeEditor.document;

    return (document && document.fileName) || '';
}

export function activate(context: vscode.ExtensionContext) {

    let importer:ReferenceIndexer = new ReferenceIndexer();

    function initWithProgress() {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title:'Move-ts indexing',
        }, async (progress) => {
            return importer.init(progress)
        });
    }

    let initialize = () => {
        if(importer.isInitialized) {
            return Promise.resolve();
        }
        return initWithProgress();
    }

    let moveDisposable = vscode.commands.registerCommand('move-ts.move', (uri?:vscode.Uri, uris?:vscode.Uri[]) => {
        if(uris && uris.length > 1) {
            const dir = path.dirname(uris[0].fsPath);
            if(uris.every(u => path.dirname(u.fsPath) == dir)) {
                return initialize().then(() => {
                    return moveMultiple(importer, uris.map(u => u.fsPath));
                })
            }
        }
        let filePath = uri ? uri.fsPath : getCurrentPath();
        if(!filePath){
            filePath = getCurrentPath();
        }
        if(!filePath || filePath.length == 0) {
            vscode.window.showErrorMessage('Could not find target to move. Right click in explorer or open a file to move.');
            return;
        }
        let go = () => {
            return move(importer, filePath);
        }
        return initialize().then(() => go());
    });
    context.subscriptions.push(moveDisposable);

    let reIndexDisposable = vscode.commands.registerCommand('move-ts.reindex', () => {
        return initWithProgress();
    });
    context.subscriptions.push(reIndexDisposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}