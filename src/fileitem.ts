import * as path from 'path';
import * as fs from 'fs-extra-promise';
import * as Promise from 'bluebird';
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

    public move(index:ReferenceIndexer): Promise<FileItem> {
        return this.ensureDir()
            .then(() => {
                if(this.isDir) {
                    return index.updateDirImports(this.sourcePath, this.targetPath).then(() => {
                        return fs.renameAsync(this.sourcePath, this.targetPath);
                    }).then(() => {
                        index.updateMovedDir(this.sourcePath, this.targetPath);
                    }).then(() => {
                        return this;
                    })
                } else {
                    return index.updateImports(this.sourcePath, this.targetPath).then(() => {
                        return fs.renameAsync(this.sourcePath, this.targetPath);
                    }).then(() => {
                        return index.updateMovedFile(this.sourcePath, this.targetPath);
                    }).then(() => {
                        return this;
                    });
                }
            })
            .then(() => {
                return this;
            }).catch(e => {
                console.log('error in move', e);
            });
    }

    private ensureDir(): Promise<any> {
        return fs.ensureDirAsync(path.dirname(this.targetPath));
    }

}