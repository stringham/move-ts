'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {FileItem} from './fileitem';
import {ReferenceIndexer, isInDir} from './index/referenceindexer';

function warnThenMove(importer:ReferenceIndexer, item:FileItem):Thenable<any> {
    return vscode.window.showWarningMessage('This will save all open editors and all changes will immediately be saved. Do you want to contine?', 'Yes, I understand').then((response:string|undefined) => {
        if (response == 'Yes, I understand') {
            return vscode.workspace.saveAll(false).then(() => {
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
            })
        } else {
            return undefined;
        }
    })
}

function move(importer:ReferenceIndexer, uri:vscode.Uri) {
    const isDir = fs.statSync(uri.fsPath).isDirectory();
    importer.clearOutput();
    return vscode.window.showInputBox({
        prompt: 'Where would you like to move?',
        value: uri.fsPath
    }).then(value => {
        if (!value || value == uri.fsPath) {
            return;
        }
        let item: FileItem = new FileItem(uri.fsPath, value, isDir);
        if (item.exists()) {
            vscode.window.showErrorMessage(value + ' already exists.');
            return;
        }
        if(item.isDir && isInDir(uri.fsPath, value)) {
            vscode.window.showErrorMessage('Cannot move a folder within itself');
            return;
        }
        return warnThenMove(importer, item);
    })
}

export function activate(context: vscode.ExtensionContext) {

    let importer:ReferenceIndexer = new ReferenceIndexer();

    let disposable = vscode.commands.registerCommand('move-ts.move', (uri:vscode.Uri) => {
        let go = () => {
            return move(importer, uri);
        }
        if(!importer.isInitialized) {
            return importer.init().then(() => {
                return go();
            });
        } else {
            return go();
        }
    });

    context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}