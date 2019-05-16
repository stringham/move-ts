import * as fs from 'fs-extra-promise';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';

import {FileItem} from '../fileitem';

import {isPathToAnotherDir, ReferenceIndex} from './referenceindex';

const minimatch = require('minimatch');

const BATCH_SIZE = 50;

type Replacement = [string, string];

interface Edit {
    start: number;
    end: number;
    replacement: string;
}

interface Reference {
    specifier: string;
    location: {start: number, end: number};
}

export function isInDir(dir: string, p: string) {
    const relative = path.relative(dir, p);
    return !isPathToAnotherDir(relative);
}

export function asUnix(fsPath: string) {
    return fsPath.replace(/\\/g, '/');
}

export class ReferenceIndexer {
    changeDocumentEvent: vscode.Disposable;
    private tsconfigs: {[key: string]: any};
    public index: ReferenceIndex = new ReferenceIndex();

    private output: vscode.OutputChannel = vscode.window.createOutputChannel('move-ts');

    private packageNames: {[key: string]: string} = {};

    private extensions: string[] = ['.ts', '.tsx'];

    private paths: string[] = [];
    private filesToExclude: string[] = [];
    private fileWatcher: vscode.FileSystemWatcher;

    public isInitialized: boolean = false;

    public init(progress?: vscode.Progress<{message: string}>): Thenable<any> {
        this.index = new ReferenceIndex();

        return this.readPackageNames().then(() => {
            return this.scanAll(progress)
                .then(() => {
                    return this.attachFileWatcher();
                })
                .then(() => {
                    console.log('move-ts initialized');
                    this.isInitialized = true;
                });
        });
    }

    public conf<T>(property: string, defaultValue: T): T {
        return vscode.workspace.getConfiguration('movets').get<T>(property, defaultValue);
    }

    private readPackageNames(): Thenable<any> {
        this.packageNames = {};
        this.tsconfigs = {};
        let seenPackageNames: {[key: string]: boolean} = {};
        const packagePromise = vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1000).then(files => {
            const promises = files.map(file => {
                return fs.readFileAsync(file.fsPath, 'utf-8').then(content => {
                    try {
                        let json = JSON.parse(content);
                        if (json.name) {
                            if (seenPackageNames[json.name]) {
                                delete this.packageNames[json.name];
                                return;
                            }
                            seenPackageNames[json.name] = true;
                            this.packageNames[json.name] = path.dirname(file.fsPath);
                        }
                    } catch (e) {
                    }
                });
            });
            return Promise.all(promises);
        });
        const tsConfigPromise =
            vscode.workspace.findFiles('**/tsconfig?(.build).json', '**/node_modules/**', 1000).then(files => {
                const promises = files.map(file => {
                    return fs.readFileAsync(file.fsPath, 'utf-8').then(content => {
                        try {
                            const config = ts.parseConfigFileTextToJson(file.fsPath, content);
                            if (config.config) {
                                this.tsconfigs[file.fsPath] = config.config;
                            }
                        } catch (e) {
                        }
                    });
                });
                return Promise.all(promises);
            });
        return Promise.all([packagePromise, tsConfigPromise]);
    }

    public startNewMoves(moves: FileItem[]) {
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine(`Moving:`);
        for (let i = 0; i < moves.length; i++) {
            this.output.appendLine(`           ${moves[i].sourcePath} -> ${moves[i].targetPath}`);
        }
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine('Files changed:');
    }

    public startNewMove(from: string, to: string) {
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine(`Moving ${from} -> ${to}`);
        this.output.appendLine('--------------------------------------------------');
        this.output.appendLine('Files changed:');
    }

    private get filesToScanGlob(): string {
        const filesToScan = this.conf('filesToScan', ['**/*.ts', '**/*.tsx']);
        if (filesToScan.length == 0) {
            return '';
        }
        return filesToScan.length == 1 ? filesToScan[0] : `{${filesToScan.join(',')}}`;
    }

    private scanAll(progress?: vscode.Progress<{message: string}>) {
        this.index = new ReferenceIndex();
        const start = Date.now();
        return vscode.workspace.findFiles(this.filesToScanGlob, '**/node_modules/**', 100000)
            .then(files => {
                return this.processWorkspaceFiles(files, false, progress);
            })
            .then(() => {
                console.log('scan finished in ' + (Date.now() - start) + 'ms');
            });
    }

    private attachFileWatcher(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        if (this.changeDocumentEvent) {
            this.changeDocumentEvent.dispose();
        }
        this.changeDocumentEvent = vscode.workspace.onDidChangeTextDocument(changeEvent => {
            addBatch(changeEvent.document.uri, changeEvent.document);
        });
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(this.filesToScanGlob);

        const watcher = this.fileWatcher;
        const batch: string[] = [];
        const documents: vscode.TextDocument[] = [];
        let batchTimeout: any = undefined;

        const batchHandler = () => {
            batchTimeout = undefined;

            vscode.workspace.findFiles(this.filesToScanGlob, '**/node_modules/**', 10000).then(files => {
                const b = new Set(batch.splice(0, batch.length));
                if (b.size) {
                    this.processWorkspaceFiles(files.filter(f => b.has(f.fsPath)), true);
                }
                const docs = documents.splice(0, documents.length);
                if (docs.length) {
                    this.processDocuments(docs);
                }
            });
        };

        const addBatch = (file: vscode.Uri, doc?: vscode.TextDocument) => {
            if (doc) {
                documents.push(doc);
            } else {
                batch.push(file.fsPath);
            }
            if (batchTimeout) {
                clearTimeout(batchTimeout);
                batchTimeout = undefined;
            }
            batchTimeout = setTimeout(batchHandler, 250);
        };

        watcher.onDidChange(addBatch);
        watcher.onDidCreate(addBatch);
        watcher.onDidDelete((file: vscode.Uri) => {
            this.index.deleteByPath(file.fsPath);
        });
    }

    private getEdits(path: string, text: string, replacements: Replacement[], fromPath?: string): Edit[] {
        const edits: Edit[] = [];
        const relativeReferences = this.getRelativeReferences(text, fromPath || path);
        replacements.forEach(replacement => {
            const before = replacement[0];
            const after = replacement[1];
            if (before == after) {
                return;
            }
            const beforeReference = this.resolveRelativeReference(fromPath || path, before);
            const seen: any = {};
            const beforeReplacements = relativeReferences.filter(ref => {
                return this.resolveRelativeReference(fromPath || path, ref.specifier) == beforeReference;
            });
            beforeReplacements.forEach(beforeReplacement => {
                const edit = {
                    start: beforeReplacement.location.start + 1,
                    end: beforeReplacement.location.end - 1,
                    replacement: after,
                };
                edits.push(edit);
            });
        });

        return edits;
    }

    private applyEdits(text: string, edits: Edit[]): string {
        const replaceBetween = (str: string, start: number, end: number, replacement: string): string => {
            return str.substr(0, start) + replacement + str.substr(end);
        };

        edits.sort((a, b) => {
            return a.start - b.start;
        });

        let editOffset = 0;
        for (let i = 0; i < edits.length; i++) {
            const edit = edits[i];
            text = replaceBetween(text, edit.start + editOffset, edit.end + editOffset, edit.replacement);
            editOffset += edit.replacement.length - (edit.end - edit.start);
        }
        return text;
    }

    private replaceReferences(filePath: string, getReplacements: (text: string) => Replacement[], fromPath?: string):
        Thenable<any> {
        if (!this.conf('openEditors', false)) {
            return fs.readFileAsync(filePath, 'utf8').then(text => {
                const replacements = getReplacements(text);
                const edits = this.getEdits(filePath, text, replacements, fromPath);
                if (edits.length == 0) {
                    return Promise.resolve();
                }

                const newText = this.applyEdits(text, edits);

                this.output.show();
                this.output.appendLine(filePath);

                return fs.writeFileAsync(filePath, newText, 'utf-8').then(() => {
                    this.processFile(newText, filePath, true);
                });
            });
        } else {
            function attemptEdit(edit: vscode.WorkspaceEdit, attempts: number = 0): Thenable<any> {
                return vscode.workspace.applyEdit(edit).then(success => {
                    if (!success && attempts < 5) {
                        console.log(attempts);
                        return attemptEdit(edit, attempts + 1);
                    }
                });
            }

            return vscode.workspace.openTextDocument(filePath).then((doc: vscode.TextDocument): Thenable<any> => {
                const text = doc.getText();
                const replacements = getReplacements(text);

                const rawEdits = this.getEdits(filePath, text, replacements);
                const edits = rawEdits.map((edit: Edit) => {
                    return vscode.TextEdit.replace(
                        new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.replacement
                    );
                });
                if (edits.length > 0) {
                    this.output.show();
                    this.output.appendLine(filePath);
                    const edit = new vscode.WorkspaceEdit();
                    edit.set(doc.uri, edits);
                    return attemptEdit(edit).then(() => {
                        const newText = this.applyEdits(text, rawEdits);
                        this.processFile(newText, filePath, true);
                    });
                } else {
                    return Promise.resolve();
                }
            });
        }
    }

    public updateMovedFile(from: string, to: string): Thenable<any> {
        return this
            .replaceReferences(
                to,
                (text: string):
                    Replacement[] => {
                        const references = Array.from(new Set(this.getRelativeImportSpecifiers(text, from)));

                        const replacements = references.map((reference): [string, string] => {
                            const absReference = this.resolveRelativeReference(from, reference);
                            const newReference = this.getRelativePath(to, absReference);
                            return [reference, newReference];
                        });
                        return replacements;
                    },
                from
            )
            .then(() => {
                this.index.deleteByPath(from);
            });
    }

    public updateMovedDir(from: string, to: string, fileNames: string[] = []): Thenable<any> {
        const relative = vscode.workspace.asRelativePath(to);
        const glob = this.filesToScanGlob;
        const whiteList = new Set<string>(fileNames);
        return vscode.workspace.findFiles(relative + '/**', undefined, 100000).then(files => {
            const promises = files
                                 .filter(file => {
                                     if (whiteList.size > 0) {
                                         return minimatch(file.fsPath, glob) &&
                                             whiteList.has(path.relative(to, file.fsPath).split(path.sep)[0]);
                                     }
                                     return minimatch(file.fsPath, glob);
                                 })
                                 .map(file => {
                                     const originalPath = path.resolve(from, path.relative(to, file.fsPath));
                                     return this.replaceReferences(file.fsPath, (text: string): Replacement[] => {
                                         const references = this.getRelativeImportSpecifiers(text, file.fsPath);
                                         const change =
                                             references
                                                 .filter(p => {
                                                     const abs = this.resolveRelativeReference(originalPath, p);
                                                     if (whiteList.size > 0) {
                                                         const name = path.relative(from, abs).split(path.sep)[0];
                                                         if (whiteList.has(name)) {
                                                             return false;
                                                         }
                                                         for (let i = 0; i < this.extensions.length; i++) {
                                                             if (whiteList.has(name + this.extensions[i])) {
                                                                 return false;
                                                             }
                                                         }
                                                         return true;
                                                     }
                                                     return isPathToAnotherDir(path.relative(from, abs));
                                                 })
                                                 .map((p): Replacement => {
                                                     const abs = this.resolveRelativeReference(originalPath, p);
                                                     const relative = this.getRelativePath(file.fsPath, abs);
                                                     return [p, relative];
                                                 });
                                         return change;
                                     }, originalPath);
                                 });
            return Promise.all(promises);
        });
    }

    public updateDirImports(from: string, to: string, fileNames: string[] = []): Thenable<any> {
        const whiteList = new Set(fileNames);
        const affectedFiles = this.index.getDirReferences(from, fileNames);
        const promises = affectedFiles.map(reference => {
            return this.replaceReferences(reference.path, (text: string): Replacement[] => {
                const imports = this.getRelativeImportSpecifiers(text, reference.path);
                const change = imports
                                   .filter(p => {
                                       const abs = this.resolveRelativeReference(reference.path, p);
                                       if (fileNames.length > 0) {
                                           const name = path.relative(from, abs).split(path.sep)[0];
                                           if (whiteList.has(name)) {
                                               return true;
                                           }
                                           for (let i = 0; i < this.extensions.length; i++) {
                                               if (whiteList.has(name + this.extensions[i])) {
                                                   return true;
                                               }
                                           }
                                           return false;
                                       }
                                       return !isPathToAnotherDir(path.relative(from, abs));
                                   })
                                   .map((p): [string, string] => {
                                       const abs = this.resolveRelativeReference(reference.path, p);
                                       const relative = path.relative(from, abs);
                                       const newabs = path.resolve(to, relative);
                                       const changeTo = this.getRelativePath(reference.path, newabs);
                                       return [p, changeTo];
                                   });
                return change;
            });
        });
        return Promise.all(promises);
    }

    public removeExtension(filePath: string): string {
        let ext = path.extname(filePath);
        if (ext == '.ts' && filePath.endsWith('.d.ts')) {
            ext = '.d.ts';
        }
        if (this.extensions.indexOf(ext) >= 0) {
            return filePath.slice(0, -ext.length);
        }
        return filePath;
    }

    public updateImports(from: string, to: string): Promise<any> {
        const affectedFiles = this.index.getReferences(from);
        const promises = affectedFiles.map(filePath => {
            return this.replaceReferences(filePath.path, (text: string): Replacement[] => {
                let relative = this.getRelativePath(filePath.path, from);
                relative = this.removeExtension(relative);

                let newRelative = this.getRelativePath(filePath.path, to);
                newRelative = this.removeExtension(newRelative);

                return [[relative, newRelative]];
            });
        });
        return Promise.all(promises).catch(e => {
            console.log(e);
        });
    }

    private processWorkspaceFiles(files: vscode.Uri[], deleteByFile: boolean = false, progress?: vscode.Progress<{
        message: string
    }>): Promise<any> {
        files = files.filter((f) => {
            return f.fsPath.indexOf('typings') === -1 && f.fsPath.indexOf('node_modules') === -1 &&
                f.fsPath.indexOf('jspm_packages') === -1;
        });

        return new Promise(resolve => {
            let index = 0;

            const next = () => {
                for (let i = 0; i < BATCH_SIZE && index < files.length; i++) {
                    const file = files[index++];
                    try {
                        const data = fs.readFileSync(file.fsPath, 'utf8');
                        this.processFile(data, file.fsPath, deleteByFile);
                    } catch (e) {
                        console.log('Failed to load file', e);
                    }
                }

                if (progress) {
                    progress.report({message: 'move-ts indexing... ' + index + '/' + files.length + ' indexed'});
                }

                if (index < files.length) {
                    setTimeout(next, 0);
                } else {
                    resolve();
                }
            };
            next();

        });
    }

    private processDocuments(documents: vscode.TextDocument[]): Promise<any> {
        documents = documents.filter((doc) => {
            return doc.uri.fsPath.indexOf('typings') === -1 && doc.uri.fsPath.indexOf('node_modules') === -1 &&
                doc.uri.fsPath.indexOf('jspm_packages') === -1;
        });

        return new Promise(resolve => {
            let index = 0;

            const next = () => {
                for (let i = 0; i < BATCH_SIZE && index < documents.length; i++) {
                    const doc = documents[index++];
                    try {
                        const data = doc.getText();
                        this.processFile(data, doc.uri.fsPath, false);
                    } catch (e) {
                        console.log('Failed to load file', e);
                    }
                }
                if (index < documents.length) {
                    setTimeout(next, 0);
                } else {
                    resolve();
                }
            };
            next();

        });
    }

    private doesFileExist(filePath: string) {
        if (fs.existsSync(filePath)) {
            return true;
        }
        for (let i = 0; i < this.extensions.length; i++) {
            if (fs.existsSync(filePath + this.extensions[i])) {
                return true;
            }
        }
        return false;
    }

    private getRelativePath(from: string, to: string): string {
        const configInfo = this.getTsConfig(from);
        if (configInfo) {
            const config = configInfo.config;
            const configPath = configInfo.configPath;
            if (config.compilerOptions && config.compilerOptions.paths && config.compilerOptions.baseUrl) {
                const baseUrl = path.resolve(path.dirname(configPath), config.compilerOptions.baseUrl);
                for (let p in config.compilerOptions.paths) {
                    const paths = config.compilerOptions.paths[p];
                    for (let i = 0; i < paths.length; i++) {
                        const mapped = paths[i].slice(0, -1);
                        const mappedDir = path.resolve(baseUrl, mapped);
                        if (isInDir(mappedDir, to)) {
                            return asUnix(p.slice(0, -1) + path.relative(mappedDir, to));
                        }
                    }
                }
            }
        }
        for (let packageName in this.packageNames) {
            const packagePath = this.packageNames[packageName];
            if (isInDir(packagePath, to) && !isInDir(packagePath, from)) {
                return asUnix(path.join(packageName, path.relative(packagePath, to)));
            }
        }
        const relativeToTsConfig = this.conf('relativeToTsconfig', false);
        if (relativeToTsConfig && configInfo) {
            const configDir = path.dirname(configInfo.configPath);
            if (isInDir(configDir, from) && isInDir(configDir, to)) {
                return asUnix(path.relative(configDir, to));
            }
        }
        let relative = path.relative(path.dirname(from), to);
        if (!relative.startsWith('.')) {
            relative = './' + relative;
        }
        return asUnix(relative);
    }

    private resolveRelativeReference(fsPath: string, reference: string): string {
        if (reference.startsWith('.')) {
            return path.resolve(path.dirname(fsPath), reference);
        } else {
            const configInfo = this.getTsConfig(fsPath);
            if (configInfo) {
                const config = configInfo.config;
                const configPath = configInfo.configPath;
                const relativeToTsConfig = this.conf('relativeToTsconfig', false);
                if (relativeToTsConfig && configPath) {
                    const check = path.resolve(path.dirname(configPath), reference);
                    if (this.doesFileExist(check)) {
                        return check;
                    }
                }
                if (config.compilerOptions && config.compilerOptions.paths && config.compilerOptions.baseUrl) {
                    const baseUrl = path.resolve(path.dirname(configPath), config.compilerOptions.baseUrl);
                    for (let p in config.compilerOptions.paths) {
                        if (p.endsWith('*') && reference.startsWith(p.slice(0, -1))) {
                            const paths = config.compilerOptions.paths[p];
                            for (let i = 0; i < paths.length; i++) {
                                const mapped = paths[i].slice(0, -1);
                                const mappedDir = path.resolve(baseUrl, mapped);
                                const potential = path.join(mappedDir, reference.substr(p.slice(0, -1).length));
                                if (this.doesFileExist(potential)) {
                                    return potential;
                                }
                            }
                            if (config.compilerOptions.paths[p].length == 1) {
                                const mapped = config.compilerOptions.paths[p][0].slice(0, -1);
                                const mappedDir = path.resolve(path.dirname(configPath), mapped);
                                return path.join(mappedDir, reference.substr(p.slice(0, -1).length));
                            }
                        }
                    }
                }
            }
            for (let packageName in this.packageNames) {
                if (reference.startsWith(packageName + '/')) {
                    return path.resolve(this.packageNames[packageName], reference.substr(packageName.length + 1));
                }
            }
        }
        return '';
    }

    private getTsConfig(filePath: string): any {
        let prevDir = filePath;
        let dir = path.dirname(filePath);
        while (dir != prevDir) {
            const tsConfigPaths = [path.join(dir, 'tsconfig.json'), path.join(dir, 'tsconfig.build.json')];
            const tsConfigPath = tsConfigPaths.find(p => this.tsconfigs.hasOwnProperty(p));

            if (tsConfigPath) {
                return {config: this.tsconfigs[tsConfigPath], configPath: tsConfigPath};
            }
            prevDir = dir;
            dir = path.dirname(dir);
        }
        return null;
    }

    private getRelativeImportSpecifiers(data: string, filePath: string): string[] {
        return this.getRelativeReferences(data, filePath).map(ref => ref.specifier);
    }

    private getReferences(fileName: string, data: string): Reference[] {
        const result: Reference[] = [];
        const file = ts.createSourceFile(fileName, data, ts.ScriptTarget.Latest);

        file.statements.forEach((node: ts.Node) => {
            if (ts.isImportDeclaration(node)) {
                if (ts.isStringLiteral(node.moduleSpecifier)) {
                    result.push({
                        specifier: node.moduleSpecifier.text,
                        location: {
                            start: node.moduleSpecifier.getStart(file),
                            end: node.moduleSpecifier.getEnd(),
                        },
                    });
                }
            }
        });

        return result;
    }

    private getRelativeReferences(data: string, filePath: string): Reference[] {
        const references: Set<string> = new Set();
        let cachedConfig: any = undefined;
        const getConfig = () => {
            if (cachedConfig === undefined) {
                cachedConfig = this.getTsConfig(filePath);
            }
            return cachedConfig;
        };
        const imports = this.getReferences(filePath, data);
        for (let i = 0; i < imports.length; i++) {
            const importModule = imports[i].specifier;
            if (importModule.startsWith('.')) {
                references.add(importModule);
            } else {
                const resolved = this.resolveRelativeReference(filePath, importModule);
                if (resolved.length > 0) {
                    references.add(importModule);
                }
            }
        }
        return imports.filter(i => references.has(i.specifier));
    }

    private processFile(data: string, filePath: string, deleteByFile: boolean = false) {
        if (deleteByFile) {
            this.index.deleteByPath(filePath);
        }

        const fsPath = this.removeExtension(filePath);

        const references = this.getRelativeImportSpecifiers(data, fsPath);

        for (let i = 0; i < references.length; i++) {
            let referenced = this.resolveRelativeReference(filePath, references[i]);
            for (let j = 0; j < this.extensions.length; j++) {
                const ext = this.extensions[j];
                if (!referenced.endsWith(ext) && fs.existsSync(referenced + ext)) {
                    referenced += ext;
                }
            }
            this.index.addReference(referenced, filePath);
        }
    }
}