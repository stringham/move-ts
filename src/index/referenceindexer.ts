import { ReferenceIndex, isPathToAnotherDir } from './referenceindex';
import * as fs from 'fs-extra-promise';
import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from 'typescript';
const minimatch = require('minimatch');

const BATCH_SIZE = 50;

type Replacement = [string,string];

interface Edit {
    start:number;
    end:number;
    replacement:string;
}

export function isInDir(dir:string, p:string) {
    let relative = path.relative(dir, p);
    return !isPathToAnotherDir(relative);
}


export class ReferenceIndexer {
    private tsconfigs: {[key:string]:any};
    public index: ReferenceIndex = new ReferenceIndex();

    private output:vscode.OutputChannel = vscode.window.createOutputChannel('move-ts');

    private packageNames: {[key:string]:string} = {};

    private extensions: string[] = ['.ts', '.tsx'];

    private paths: string[] = [];
    private filesToExclude: string[] = [];
    private fileWatcher: vscode.FileSystemWatcher;

    public isInitialized:boolean = false;

    public init(progress?: vscode.Progress<{message:string}>):Thenable<any> {
        this.index = new ReferenceIndex();

        return this.readPackageNames().then(() => {
            return this.scanAll(progress).then(() => {
                return this.attachFileWatcher();
            }).then(() => {
                console.log('move-ts initialized');
                this.isInitialized = true;
            });
        })
    }

    public conf<T>(property: string, defaultValue: T): T {
        return vscode.workspace.getConfiguration('movets').get<T>(property, defaultValue);
    }

    private readPackageNames():Thenable<any> {
        this.packageNames = {};
        this.tsconfigs = {}
        let seenPackageNames:{[key:string]:boolean} = {};
        let packagePromise = vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1000).then(files => {
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
                });
            });
            return Promise.all(promises);
        });
        let tsConfigPromise = vscode.workspace.findFiles('**/tsconfig.json', '**/node_modules/**', 1000).then(files => {
            let promises = files.map(file => {
                return fs.readFileAsync(file.fsPath, 'utf-8').then(content => {
                    try {
                        let config = ts.parseConfigFileTextToJson(file.fsPath, content, true);
                        if(config.config) {
                            this.tsconfigs[file.fsPath] = config.config;
                        }
                    } catch(e) {}
                });
            });
            return Promise.all(promises);
        });
        return Promise.all([packagePromise, tsConfigPromise]);
    }

    public startNewMove(from:string, to:string) {
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine(`Moving ${from} -> ${to}`)
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine('Files changed:');
    }

    private get filesToScanGlob():string {
        let filesToScan = this.conf('filesToScan', ['**/*.ts', '**/*.tsx']);
        if(filesToScan.length == 0) {
            return '';
        }
        return filesToScan.length == 1 ? filesToScan[0] : `{${filesToScan.join(',')}}`;
    }

    private scanAll(progress?: vscode.Progress<{message:string}>) {
        this.index = new ReferenceIndex();

        return vscode.workspace.findFiles(this.filesToScanGlob,'**/node_modules/**',100000)
            .then(files => {
                return this.processWorkspaceFiles(files, false, progress);
            })
    }

    private attachFileWatcher():void {
        if(this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(this.filesToScanGlob);

        let watcher = this.fileWatcher;
        let batch:string[] = [];
        let batchTimeout:any = undefined;

        let batchHandler = () => {
            batchTimeout = undefined;

            vscode.workspace.findFiles(this.filesToScanGlob, '**/node_modules/**', 10000)
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

    private getEdits(path:string, text:string, replacements:Replacement[], fromPath?:string):Edit[] {
        function escapeRegExp(str:string) {
            return String(str)
                .replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, '\\$1')
                .replace(/\x08/g, '\\x08');
        }
        let edits: Edit[] = [];
        let relativeReferences = this.getRelativeReferences(text, fromPath || path);
        replacements.forEach(replacement => {
            let before = replacement[0];
            let after = replacement[1];
            if (before == after) {
                return;
            }
            let beforeReference = this.resolveRelativeReference(fromPath || path, before);
            let seen:any = {};
            let beforeReplacements = relativeReferences.filter(ref => {
                return this.resolveRelativeReference(fromPath || path, ref) == beforeReference;
            });
            beforeReplacements.forEach(beforeReplacement => {

                let regExp = new RegExp(`((?:import|export)\\s+({[^}]*})?(\\S+)?(\\S+\\s+as\\s+\\S+)?\\s+from ['"])(${escapeRegExp(beforeReplacement)}(\\.tsx?)?)(['"];?)`, 'g');

                let match: RegExpExecArray | null;
                while (match = regExp.exec(text)) {
                    let importLine = text.substring(match.index, regExp.lastIndex);
                    let start = importLine.indexOf(beforeReplacement);
                    if (importLine.indexOf(beforeReplacement, start + beforeReplacement.length) > 0) { //some weird double import maybe?
                        continue;
                    }
                    let edit = {
                        start:match.index + start,
                        end:match.index + start + beforeReplacement.length,
                        replacement:after,
                    }
                    edits.push(edit);
                }
            })
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


    private replaceReferences(path:string, getReplacements:(text:string) => Replacement[], fromPath?:string):Thenable<any> {
        return fs.readFileAsync(path, 'utf8').then(text => {
            let replacements = getReplacements(text);
            let edits = this.getEdits(path, text, replacements, fromPath);
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

        //     let edits = this.getEdits(path, text, replacements).map((edit:Edit) => {
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
            let references = this.getRelativeReferences(text, from);

            let replacements = references.map((reference):[string, string] => {
                let absReference = this.resolveRelativeReference(from, reference);
                let newReference = this.getRelativePath(to, absReference);
                return [reference, newReference]
            });
            return replacements;
        }, from)
    }

    public updateMovedDir(from:string, to:string):Thenable<any> {
        let relative = vscode.workspace.asRelativePath(to);
        let glob = this.filesToScanGlob;
        return vscode.workspace.findFiles(relative + '/**',undefined,100000).then(files => {
            let promises = files.filter(file => {
                return minimatch(file.fsPath, glob);
            }).map(file => {
                let originalPath = path.resolve(from, path.relative(to,file.fsPath));
                return this.replaceReferences(file.fsPath, (text:string):Replacement[] => {
                    let references = this.getRelativeReferences(text, file.fsPath);
                    let change = references.filter(p => {
                        let abs = this.resolveRelativeReference(originalPath, p);
                        return isPathToAnotherDir(path.relative(from, abs));
                    }).map((p):Replacement => {
                        let abs = this.resolveRelativeReference(originalPath, p);
                        let relative = this.getRelativePath(file.fsPath, abs);
                        return [p, relative];
                    });
                    return change;
                }, originalPath)
            });
            return Promise.all(promises);
        })
    }

    public updateDirImports(from:string, to:string):Thenable<any> {

        let affectedFiles = this.index.getDirReferences(from);
        let promises = affectedFiles.map(reference => {
            return this.replaceReferences(reference.path, (text:string):Replacement[] => {
                let imports = this.getRelativeReferences(text, reference.path);
                let change = imports.filter(p => {
                    let abs = this.resolveRelativeReference(reference.path, p);
                    return !isPathToAnotherDir(path.relative(from, abs));
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

    public removeExtension(filePath:string): string {
        let ext = path.extname(filePath);
        if(ext == '.ts' && filePath.endsWith('.d.ts')) {
            ext = '.d.ts';
        }
        if(this.extensions.indexOf(ext) >= 0) {
            return filePath.slice(0, -ext.length);
        }
        return filePath;
    }

    public updateImports(from:string, to:string):Promise<any> {
        let affectedFiles = this.index.getReferences(from);
        let promises = affectedFiles.map(filePath => {
            return this.replaceReferences(filePath.path, (text:string):Replacement[] => {
                let relative = this.getRelativePath(filePath.path, from);
                relative = this.removeExtension(relative);

                let newRelative = this.getRelativePath(filePath.path, to);
                newRelative = this.removeExtension(newRelative);

                return [[relative, newRelative]]
            })
        })
        return Promise.all(promises).catch(e => {
            console.log(e);
        });
    }

    private processWorkspaceFiles(files:vscode.Uri[], deleteByFile:boolean = false, progress?: vscode.Progress<{message:string}>):Promise<any> {
        files = files.filter((f) => {
            return f.fsPath.indexOf('typings') === -1 &&
                f.fsPath.indexOf('node_modules') === -1 &&
                f.fsPath.indexOf('jspm_packages') === -1;
        });


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

                if(progress) {
                    progress.report({message:'move-ts indexing... ' + index + '/' + files.length + ' indexed'});
                }


                if(index < files.length) {
                    setTimeout(next, 0);
                } else {
                    resolve();
                }
            }
            next();

        })
    }

    private getRelativePath(from:string, to:string):string {
        for(let configPath in this.tsconfigs) {
            if(isInDir(path.dirname(configPath), from)) {
                let config = this.tsconfigs[configPath];
                if(config.compilerOptions && config.compilerOptions.paths) {
                    for(let p in config.compilerOptions.paths) {
                        if(config.compilerOptions.paths[p].length == 1) {
                            let mapped = config.compilerOptions.paths[p][0].replace('*','');
                            let mappedDir = path.resolve(path.dirname(configPath), mapped);
                            if(isInDir(mappedDir, to)) {
                                return p.replace('*','') + path.relative(mappedDir, to);
                            }
                        }
                    }
                }
            }
        }
        for(let packageName in this.packageNames) {
            let packagePath = this.packageNames[packageName];
            if(isInDir(packagePath, to) && !isInDir(packagePath, from)) {
                return packageName + '/' + path.relative(packagePath, to);
            }
        }
        let relative = path.relative(path.dirname(from), to);
        relative = relative.replace(/\\/g, "/");
        if(!relative.startsWith('.')) {
            relative = './' + relative;
        }
        return relative;
    }

    private resolveRelativeReference(fsPath:string, reference:string):string {
        if(reference.startsWith('.')) {
            return path.resolve(path.dirname(fsPath), reference);
        } else {
            for(let configPath in this.tsconfigs) {
                if(isInDir(path.dirname(configPath), fsPath)) {
                    let config = this.tsconfigs[configPath];
                    if(config.compilerOptions && config.compilerOptions.paths) {
                        for(let p in config.compilerOptions.paths) {
                            if(p.endsWith('*') && reference.startsWith(p.replace('*',''))) {
                                if(config.compilerOptions.paths[p].length == 1) {
                                    let mapped = config.compilerOptions.paths[p][0].replace('*','');
                                    let mappedDir = path.resolve(path.dirname(configPath), mapped);
                                    return mappedDir + '/' + reference.substr(p.replace('*','').length);
                                }
                            }
                        }
                    }
                }
            }
            for(let packageName in this.packageNames) {
                if(reference.startsWith(packageName + '/')) {
                    return path.resolve(this.packageNames[packageName], reference.substr(packageName.length+1));
                }
            }
        }
        return '';
    }

    private getRelativeReferences(data:string, filePath:string):string[] {
        let references:string[] = [];
        let importRegEx = /(?:import|export)\s+({[^}]*})?(\S+)?(\S+\s+as\s+\S+)?\s+from ['"]([^'"]+)['"];?/gi;
        let imports: RegExpExecArray | null;
        while(imports = importRegEx.exec(data)){
            let importModule = imports[4];
            if(importModule.startsWith('.')) {
                if(references.indexOf(importModule) < 0) {
                    references.push(importModule);
                }
            } else {
                let found = false;
                for(let configPath in this.tsconfigs) {
                    if(isInDir(path.dirname(configPath), filePath)) {
                        let config = this.tsconfigs[configPath];
                        if(config.compilerOptions && config.compilerOptions.paths) {
                            for(let p in config.compilerOptions.paths) {
                                if(p.endsWith('*') && importModule.startsWith(p.replace('*','')) && config.compilerOptions.paths[p].length == 1) {
                                    if(references.indexOf(importModule) < 0) {
                                        references.push(importModule);
                                    }
                                    found = true;
                                }
                            }
                        }
                    }
                }
                if(!found) {
                    for(let packageName in this.packageNames) {
                        if(importModule.startsWith(packageName + '/')) {
                            if(references.indexOf(importModule) < 0) {
                                references.push(importModule);
                            }
                        }
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

        fsPath = this.removeExtension(fsPath);

        let references = this.getRelativeReferences(data, fsPath);

        references.forEach(reference => {
            let referenced = this.resolveRelativeReference(file.fsPath, reference);
            this.extensions.forEach(ext => {
                if(!referenced.endsWith(ext) && fs.existsSync(referenced+ext)) {
                    referenced += ext;
                }
            });
            this.index.addReference(referenced, file.fsPath);
        });

    }
}