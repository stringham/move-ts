import {ReferenceIndex} from './referenceindex';
import * as fs from 'fs-extra-promise';
import * as vscode from 'vscode';
import * as path from 'path';

const BATCH_SIZE = 50;

type Replacement = [string,string];

interface Edit {
    start:number;
    end:number;
    replacement:string;
}

export function isInDir(dir:string, p:string) {
    return !path.relative(dir, p).startsWith('../');
}


export class ReferenceIndexer {
    public index:ReferenceIndex = new ReferenceIndex();

    private output:vscode.OutputChannel = vscode.window.createOutputChannel('move-ts');

    private packageNames: {[key:string]:string} = {};

    private paths: string[] = [];
    private filesToScan: string[] = ['**/*.ts'];
    private filesToExclude: string[] = [];
    private fileWatcher: vscode.FileSystemWatcher;

    public isInitialized:boolean = false;

    public init():Thenable<any> {
        this.index = new ReferenceIndex();

        return this.readPackageNames().then(() => {
            return this.scanAll(true).then(() => {
                return this.attachFileWatcher();
            }).then(() => {
                console.log('move-ts initialized');
                this.isInitialized = true;
            });
        })
    }

    private readPackageNames():Thenable<any> {
        this.packageNames = {};
        let seenPackageNames:{[key:string]:boolean} = {};
        return vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1000).then(files => {
            let promises = files.map(file => {
                return fs.readFileAsync(file.fsPath, 'utf-8').then(content => {
                    try {
                        let json = JSON.parse(content);
                        if(json.name) {
                            if(seenPackageNames[json.name]) {
                                delete this.packageNames[json.name];
                                return;
                            }
                            seenPackageNames[json.name] = true;
                            this.packageNames[json.name] = path.dirname(file.fsPath);
                        }
                    } catch(e) {}
                })
            });
            return Promise.all(promises);
        });
    }

    public clearOutput() {
        this.output.clear();
        this.output.appendLine('Files changed:');
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

    private getEdits(text:string, replacements:Replacement[]):Edit[] {
        function escapeRegExp(str:string) {
            return String(str)
                .replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, '\\$1')
                .replace(/\x08/g, '\\x08');
        }
        let edits: Edit[] = [];
        replacements.forEach(replacement => {
            let before = replacement[0];
            let after = replacement[1];
            if (before == after) {
                return;
            }

            let regExp = new RegExp(`(import\\s+({[^}]*})?(\\S+)?(\\S+\\s+as\\s+\\S+)?\\s+from ['"])(${escapeRegExp(before)}(\\.ts)?)(['"];?)`, 'g');

            let match: RegExpExecArray | null;
            while (match = regExp.exec(text)) {
                let importLine = text.substring(match.index, regExp.lastIndex);
                let start = importLine.indexOf(before);
                if (importLine.indexOf(before, start + before.length) > 0) { //some weird double import maybe?
                    continue;
                }
                let edit = {
                    start:match.index + start,
                    end:match.index + start + before.length,
                    replacement:after,
                }
                edits.push(edit);
            }
        })

        return edits;
    }

    private applyEdits(text:string, edits:Edit[]):string {
        let replaceBetween = (str:string, start:number, end:number, replacement:string):string => {
            return str.substr(0,start) + replacement + str.substr(end);
        }

        edits.sort((a,b) => {
            return a.start - b.start;
        });

        let editOffset = 0;
        for(let i=0; i<edits.length; i++) {
            let edit = edits[i];
            text = replaceBetween(text, edit.start + editOffset, edit.end + editOffset, edit.replacement);
            editOffset += edit.replacement.length - (edit.end-edit.start)
        }
        return text
    }


    private replaceReferences(path:string, getReplacements:(text:string) => Replacement[]):Thenable<any> {
        return fs.readFileAsync(path, 'utf8').then(text => {
            let replacements = getReplacements(text);
            let edits = this.getEdits(text, replacements);
            if(edits.length == 0) {
                return Promise.resolve();
            }

            let newText = this.applyEdits(text, edits);

            this.output.show();
            this.output.appendLine(path);

            return fs.writeFileAsync(path, newText, 'utf-8');
        });

        // return vscode.workspace.openTextDocument(path).then((doc:vscode.TextDocument):Thenable<any> => {
        //     let text = doc.getText();
        //     let replacements = getReplacements(text);

        //     let edits = this.getEdits(text, replacements).map((edit:Edit) => {
        //         return vscode.TextEdit.replace(new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.replacement);
        //     });
        //     if (edits.length > 0) {
        //         let edit = new vscode.WorkspaceEdit();
        //         edit.set(doc.uri, edits);
        //         return vscode.workspace.applyEdit(edit);
        //     } else {
        //         return Promise.resolve();
        //     }
        // })
    }

    public updateMovedFile(from:string, to:string):Thenable<any> {
        return this.replaceReferences(to, (text:string):Replacement[] => {
            let references = this.getRelativeReferences(text);

            let replacements = references.map((reference):[string, string] => {
                let absReference = this.resolveRelativeReference(from, reference);
                let newReference = this.getRelativePath(to, absReference);
                return [reference, newReference]
            });
            return replacements;
        })
    }

    public updateMovedDir(from:string, to:string):Thenable<any> {
        let relative = vscode.workspace.asRelativePath(to);
        return vscode.workspace.findFiles(relative+'/**/*.ts',undefined,100000).then(files => {
            let promises = files.map(file => {
                let originalPath = path.resolve(from, path.relative(to,file.fsPath));
                return this.replaceReferences(file.fsPath, (text:string):Replacement[] => {
                    let references = this.getRelativeReferences(text);
                    let change = references.filter(p => {
                        let abs = this.resolveRelativeReference(originalPath, p);
                        return path.relative(from, abs).startsWith('../');
                    }).map((p):Replacement => {
                        let abs = this.resolveRelativeReference(originalPath, p);
                        let relative = this.getRelativePath(file.fsPath, abs);
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
                    let abs = this.resolveRelativeReference(reference.path, p);
                    return !path.relative(from, abs).startsWith('../')
                }).map((p):[string,string] => {
                    let abs = this.resolveRelativeReference(reference.path, p);
                    let relative = path.relative(from, abs);
                    let newabs = path.resolve(to,relative);
                    let changeTo = this.getRelativePath(reference.path, newabs);
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
                let relative = this.getRelativePath(filePath.path, from);
                if(relative.endsWith('.ts')) {
                    relative = relative.substr(0,relative.length-3);
                }

                let newRelative = this.getRelativePath(filePath.path, to);
                if(newRelative.endsWith('.ts')) {
                    newRelative = newRelative.substr(0, newRelative.length - 3);
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
                }
            }
            next();

        })
    }

    private getRelativePath(from:string, to:string):string {
        for(let packageName in this.packageNames) {
            let packagePath = this.packageNames[packageName];
            if(isInDir(packagePath, to) && !isInDir(packagePath, from)) {
                return packageName + '/' + path.relative(packagePath, to);
            }
        }
        let relative = path.relative(path.dirname(from), to);
        if(!relative.startsWith('.')) {
            relative = './' + relative;
        }
        return relative;
    }

    private resolveRelativeReference(fsPath:string, reference:string):string {
        if(reference.startsWith('.')) {
            return path.resolve(path.dirname(fsPath), reference);
        } else {
            for(let packageName in this.packageNames) {
                if(reference.startsWith(packageName + '/')) {
                    return path.resolve(this.packageNames[packageName], reference.substr(packageName.length+1));
                }
            }
        }
        return '';
    }

    private getRelativeReferences(data:string):string[] {
        let references:string[] = [];
        let importRegEx = /import\s+({[^}]*})?(\S+)?(\S+\s+as\s+\S+)?\s+from ['"]([^'"]+)['"];?/gi;
        let imports: RegExpExecArray | null;
        while(imports = importRegEx.exec(data)){
            let importModule = imports[4];
            if(importModule.startsWith('.')) {
                if(references.indexOf(importModule) < 0) {
                    references.push(importModule);
                }
            } else {
                for(let packageName in this.packageNames) {
                    if(importModule.startsWith(packageName + '/')) {
                        references.push(importModule);
                    }
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
            let referenced = this.resolveRelativeReference(file.fsPath, reference);
            if(!referenced.endsWith('.ts') && fs.existsSync(referenced+'.ts')) {
                referenced += '.ts';
            }
            this.index.addReference(referenced, file.fsPath);
        });

    }
}