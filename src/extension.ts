'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {FileItem} from './fileitem';
import {ReferenceIndexer, isInDir} from './index/referenceindexer';

function warnThenMove(importer:ReferenceIndexer, item:FileItem):Thenable<any> {
    let doIt = () => {
        return vscode.workspace.saveAll(false).then(() => {
            importer.startNewMove(item.sourcePath, item.targetPath);
            let move = item.move(importer)
            move.catch(e => {
                console.log('error in extension.ts', e);
            })
            if (!item.isDir) {
                move.then(item => {
                    return Promise.resolve(vscode.workspace.openTextDocument(item.targetPath))
                        .then((textDocument: vscode.TextDocument) => vscode.window.showTextDocument(textDocument));
                }).catch(e => {
                    console.log('error in extension.ts', e);
                });
            }
        });
    }
    if(importer.conf('skipWarning', false)) {
        return doIt()
    }
    return vscode.window.showWarningMessage('This will save all open editors and all changes will immediately be saved. Do you want to continue?', 'Yes, I understand').then((response:string|undefined) => {
        if (response == 'Yes, I understand') {
            return doIt();
        } else {
            return undefined;
        }
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

function getCurrentPath():string {
    let activeEditor = vscode.window.activeTextEditor;
    let document = activeEditor && activeEditor.document;

    return (document && document.fileName) || '';
}

export function activate(context: vscode.ExtensionContext) {

    let importer:ReferenceIndexer = new ReferenceIndexer();

    let moveDisposable = vscode.commands.registerCommand('move-ts.move', (uri?:vscode.Uri) => {
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
        if(!importer.isInitialized) {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title:'Move-ts indexing',
            }, async (progress) => {
                return importer.init(progress);
            }).then(() => {
                go();
            })
        } else {
            return go();
        }
    });
    context.subscriptions.push(moveDisposable);

    let reIndexDisposable = vscode.commands.registerCommand('move-ts.reindex', () => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Move-ts re-indexing',
        }, async (progress) => {
            return importer.init(progress);
        });
    });
    context.subscriptions.push(reIndexDisposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}