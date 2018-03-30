import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import * as path from 'path';

import {ReferenceIndexer} from './index/referenceindexer';

export class FileItem {
    constructor(
        public sourcePath: string,
        public targetPath: string,
        public isDir: boolean,
    ) {
    }

    exists(): boolean {
        return fs.existsSync(this.targetPath);
    }

    static moveMultiple(items: FileItem[], index: ReferenceIndexer): Promise<FileItem[]> {
        return items[0].ensureDir().then(() => {

            const sourceDir = path.dirname(items[0].sourcePath);
            const targetDir = path.dirname(items[0].targetPath);
            const fileNames = items.map(i => path.basename(i.sourcePath));
            return index.updateDirImports(sourceDir, targetDir, fileNames)
                .then(() => {
                    const promises = items.map(i => fs.renameAsync(i.sourcePath, i.targetPath));
                    return Promise.all(promises);
                })
                .then(() => {
                    return index.updateMovedDir(sourceDir, targetDir, fileNames);
                })
                .then(() => {
                    return items;
                });
        });
    }

    public move(index: ReferenceIndexer): Promise<FileItem> {
        return this.ensureDir()
            .then(() => {
                if (this.isDir) {
                    return index.updateDirImports(this.sourcePath, this.targetPath)
                        .then(() => {
                            return fs.renameAsync(this.sourcePath, this.targetPath);
                        })
                        .then(() => {
                            return index.updateMovedDir(this.sourcePath, this.targetPath);
                        })
                        .then(() => {
                            return this;
                        });
                } else {
                    return index.updateImports(this.sourcePath, this.targetPath)
                        .then(() => {
                            return fs.renameAsync(this.sourcePath, this.targetPath);
                        })
                        .then(() => {
                            return index.updateMovedFile(this.sourcePath, this.targetPath);
                        })
                        .then(() => {
                            return this;
                        });
                }
            })
            .then(
                ():
                    any => {
                        return this;
                    }
            )
            .catch(e => {
                console.log('error in move', e);
            });
    }

    private ensureDir(): Promise<any> {
        return fs.ensureDirAsync(path.dirname(this.targetPath));
    }
}