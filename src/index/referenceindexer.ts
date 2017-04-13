import {ReferenceIndex} from './referenceindex';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';

const BATCH_SIZE = 50;

type Replacement = [string,string];


export class ReferenceIndexer {
    public index:ReferenceIndex = new ReferenceIndex();

    private paths: string[] = [];
    private filesToScan: string[] = ['**/*.ts'];
    private filesToExclude: string[] = [];
    private fileWatcher: vscode.FileSystemWatcher;

    public isInitialized:boolean = false;

    public init():Thenable<any> {
        return this.scanAll(true).then(() => {
            return this.attachFileWatcher();
        }).then(() => {
            this.isInitialized = true;
        })
    }

    private scanAll(reportProgress:boolean) {
        this.index = new ReferenceIndex();
        return vscode.workspace.findFiles(this.filesToScan[0],'**/node_modules/**',100000)
            .then(files => {
                return this.processWorkspaceFiles(files, false, reportProgress);
            })
    }

    private attachFileWatcher():void {
        if(this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(this.filesToScan[0]);

        let watcher = this.fileWatcher;
        let batch:string[] = [];
        let batchTimeout:any = undefined;

        let batchHandler = () => {
            batchTimeout = undefined;

            vscode.workspace.findFiles(this.filesToScan[0], '**/node_modules/**', 10000)
                .then(files => {
                    let b = batch.splice(0, batch.length);
                    if(b.length) {
                        this.processWorkspaceFiles(files.filter(f => b.indexOf(f.fsPath)>=0), true)
                    }
                })
        }

        let addBatch = (file:vscode.Uri) => {
            batch.push(file.fsPath);
            if(batchTimeout) {
                clearTimeout(batchTimeout);
                batchTimeout = undefined;
            }
            batchTimeout = setTimeout(batchHandler, 250);
        }

        watcher.onDidChange(addBatch);
        watcher.onDidCreate(addBatch);
        watcher.onDidDelete((file:vscode.Uri) => {
            this.index.deleteByPath(file.fsPath);
        })
    }


    private replaceReferences(path:string, getReplacements:(text:string) => Replacement[]):Thenable<any> {
        function escapeRegExp(str:string) {
            return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
        }
        return vscode.workspace.openTextDocument(path).then((doc:vscode.TextDocument):Thenable<any> => {
            let replacements = getReplacements(doc.getText());
            let edits: vscode.TextEdit[] = [];
            replacements.forEach(replacement => {
                let before = replacement[0];
                let after = replacement[1];
                if(before == after) {
                    return;
                }

                let regExp = new RegExp(`(import\\s+({[^}]*})?(\\S+)?(\\S+\\s+as\\s+\\S+)?\\s+from ['"])(${escapeRegExp(before)}(\\.ts)?)(['"];?)`, 'g');

                let match: RegExpExecArray | null;
                let text = doc.getText();
                while (match = regExp.exec(text)) {
                    let importLine = text.substring(match.index, regExp.lastIndex);
                    if (before != after) {
                        let start = importLine.indexOf(before);
                        if (importLine.indexOf(before, start + before.length) > 0) {
                            continue;
                        }
                        let edit = vscode.TextEdit.replace(new vscode.Range(doc.positionAt(match.index + start), doc.positionAt(match.index + start + before.length)), after);
                        edits.push(edit);
                    }
                }
            })
            if (edits.length > 0) {
                let edit = new vscode.WorkspaceEdit();
                edit.set(doc.uri, edits);
                return vscode.workspace.applyEdit(edit);
            } else {
                return Promise.resolve();
            }
        })
    }

    public updateMovedFile(from:string, to:string):Thenable<any> {
        return this.replaceReferences(to, (text:string):Replacement[] => {
            let references = this.getRelativeReferences(text);

            let replacements = references.map((reference):[string, string] => {
                let absReference = path.resolve(path.dirname(from), reference);
                let newReference = path.relative(path.dirname(to), absReference);
                if(!newReference.startsWith('.')) {
                    newReference = './' + newReference
                }
                return [reference, newReference]
            });
            return replacements;
        })
    }

    public updateMovedDir(from:string, to:string):Thenable<any> {
        let relative = path.relative(vscode.workspace.rootPath || '/', to);
        return vscode.workspace.findFiles(relative+'/**/*.ts',undefined,100000).then(files => {
            console.log(files);
            let promises = files.map(file => {
                let originalPath = path.resolve(from, path.relative(to,file.fsPath));
                return this.replaceReferences(file.fsPath, (text:string):Replacement[] => {
                    let references = this.getRelativeReferences(text);
                    let change = references.filter(p => {
                        let abs = path.resolve(path.dirname(originalPath), p);
                        return path.relative(from, abs).startsWith('../');
                    }).map((p):[string,string] => {
                        let abs = path.resolve(path.dirname(originalPath), p);
                        let relative = path.relative(path.dirname(file.fsPath), abs);
                        if(!relative.startsWith('.')) {
                            relative = './' + relative;
                        }
                        return [p, relative];
                    });
                    return change;
                })
            });
            return Promise.all(promises);
        })
    }

    public updateDirImports(from:string, to:string):Thenable<any> {

        let affectedFiles = this.index.getDirReferences(from);

        let promises = affectedFiles.map(reference => {
            return this.replaceReferences(reference.path, (text:string):Replacement[] => {
                let imports = this.getRelativeReferences(text);
                let change = imports.filter(p => {
                    let abs = path.resolve(path.dirname(reference.path), p);
                    return !path.relative(from, abs).startsWith('../')
                }).map((p):[string,string] => {
                    let abs = path.resolve(path.dirname(reference.path), p);
                    let relative = path.relative(from, abs);
                    let newabs = path.resolve(to,relative);
                    let changeTo = path.relative(path.dirname(reference.path), newabs);
                    if(!changeTo.startsWith('.')) {
                        changeTo = './' + changeTo;
                    }
                    return [p,changeTo];
                });
                return change;
            });
        });
        return Promise.all(promises);
    }

    public updateImports(from:string, to:string):Promise<any> {

        let affectedFiles = this.index.getReferences(from);
        let promises = affectedFiles.map(filePath => {
            return this.replaceReferences(filePath.path, (text:string):Replacement[] => {
                let relative = path.relative(path.dirname(filePath.path), from);
                if(relative.endsWith('.ts')) {
                    relative = relative.substr(0,relative.length-3);
                }
                if(!relative.startsWith('.')) {
                    relative = './' + relative;
                }

                let newRelative = path.relative(path.dirname(filePath.path), to);
                if(newRelative.endsWith('.ts')) {
                    newRelative = newRelative.substr(0, newRelative.length - 3);
                }
                if(!newRelative.startsWith('.')) {
                    newRelative = './' + newRelative;
                }

                return [[relative, newRelative]]
            })
        })
        return Promise.all(promises).catch(e => {
            console.log(e);
        });
    }

    private processWorkspaceFiles(files:vscode.Uri[], deleteByFile:boolean = false, reportProgress:boolean = false):Promise<any> {
        files = files.filter((f) => {
            return f.fsPath.indexOf('typings') === -1 &&
                f.fsPath.indexOf('node_modules') === -1 &&
                f.fsPath.indexOf('jspm_packages') === -1;
        });


        console.log("processWorkspaceFiles move-ts", files, deleteByFile);

        let statusBarDisposable:vscode.Disposable;

        return new Promise(resolve => {
            let index = 0;

            let next = () => {
                for(let i=0; i<BATCH_SIZE && index < files.length; i++) {
                    let file = files[index++];
                    try {
                        let data = fs.readFileSync(file.fsPath, 'utf8');
                        this.processFile(data, file, deleteByFile);
                    } catch(e) {
                        console.log('Failed to load file', e);
                    }
                }

                if(reportProgress) {
                    if(statusBarDisposable) {
                        statusBarDisposable.dispose();
                    }
                    statusBarDisposable = vscode.window.setStatusBarMessage('move-ts indexing... ' + index + '/' + files.length + ' indexed');
                }


                if(index < files.length) {
                    setTimeout(next, 0);
                } else {
                    if (statusBarDisposable) {
                        statusBarDisposable.dispose();
                    }
                    resolve();
                    console.log('done scanning files');
                }
            }
            next();

        })
    }

    private getRelativeReferences(data:string):string[] {
        let references:string[] = [];
        let importRegEx = /import\s+({[^}]*})?(\S+)?(\S+\s+as\s+\S+)?\s+from ['"]([^'"]+)['"];?/gi;
        let imports: RegExpExecArray | null;
        while(imports = importRegEx.exec(data)){
            let importModule = imports[4];
            if(importModule.indexOf('./') >= 0) {
                if(references.indexOf(importModule) < 0) {
                    references.push(importModule);
                }
            }
        }
        return references;
    }

    private processFile(data:string, file:vscode.Uri, deleteByFile:boolean = false) {
        if(deleteByFile) {
            this.index.deleteByPath(file.fsPath);
        }
        let fsPath = file.fsPath.replace(/[\/\\]/g, "/");

        if(fsPath.endsWith('.ts')) {
            fsPath = fsPath.substring(0,fsPath.length - 3);
        }

        let references = this.getRelativeReferences(data);

        references.forEach(reference => {
            let referenced = path.resolve(path.dirname(file.fsPath), reference);
            if(!fs.existsSync(referenced) && fs.existsSync(referenced+'.ts')) {
                referenced += '.ts';
            }
            this.index.addReference(referenced, file.fsPath);
        });

    }
}