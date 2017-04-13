'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {FileItem} from './fileitem';
import {ReferenceIndexer} from './index/referenceindexer';

function move(importer:ReferenceIndexer, uri:vscode.Uri) {
    const isDir = fs.statSync(uri.fsPath).isDirectory();
    vscode.window.showInputBox({
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
        let move = item.move(importer)
        move.catch(e => {
            console.log('error in extension.ts', e);
        })
        if (!isDir) {
            move.then(item => {
                return Promise.resolve(vscode.workspace.openTextDocument(item.targetPath))
                    .then((textDocument: vscode.TextDocument) => vscode.window.showTextDocument(textDocument));
            }).catch(e => {
                console.log('error in extension.ts', e);
            });
        } else {
            move.catch(e => {
                console.log(e);
            })
        }
    })
}

export function activate(context: vscode.ExtensionContext) {

    let importer:ReferenceIndexer = new ReferenceIndexer();

    let disposable = vscode.commands.registerCommand('move-ts.move', (uri:vscode.Uri) => {
        if(!importer.isInitialized) {
            importer.init().then(() => {
                move(importer, uri);
            });
        } else {
            move(importer, uri);
        }
    });

    context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
}