import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import * as path from 'path';

import {ReferenceIndexer} from './index/referenceindexer';
import {MoveTransaction} from './movetransaction';

export interface MoveError extends Error {
    /** Set when the move was undone, so the workspace is back to its original state. */
    rolledBack?: boolean;
    /** Set when undoing the move itself failed, so the workspace is in a mixed state. */
    rollbackError?: any;
}

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
        return FileItem.transact(items, index, transaction => {
            const sourceDir = path.dirname(items[0].sourcePath);
            const targetDir = path.dirname(items[0].targetPath);
            const fileNames = items.map(i => path.basename(i.sourcePath));
            // Every item lands in targetDir, so a single ensureDir covers them all.
            return items[0]
                .ensureDir()
                .then(() => index.updateDirImports(sourceDir, targetDir, transaction, fileNames))
                .then(() => transaction.renameAll(items))
                .then(() => index.updateMovedDir(sourceDir, targetDir, transaction, fileNames))
                .then(() => items);
        });
    }

    public move(index: ReferenceIndexer): Promise<FileItem> {
        return FileItem.transact([this], index, transaction => {
            return this.ensureDir()
                .then(() => {
                    if (this.isDir) {
                        return index.updateDirImports(this.sourcePath, this.targetPath, transaction)
                            .then(() => transaction.rename(this.sourcePath, this.targetPath))
                            .then(() => index.updateMovedDir(this.sourcePath, this.targetPath, transaction));
                    }
                    return index.updateImports(this.sourcePath, this.targetPath, transaction)
                        .then(() => transaction.rename(this.sourcePath, this.targetPath))
                        .then(() => index.updateMovedFile(this.sourcePath, this.targetPath, transaction));
                })
                .then(() => this);
        });
    }

    /**
     * Validates the move, then runs `body` and undoes every mutation it recorded if it fails.
     * The index is rescanned afterwards, because indexing may have observed the intermediate
     * edits and rename events before the original state came back.  A move that fails before
     * touching anything - a failed validation, most often - needs neither, so it is reported as
     * is rather than paying for a full rescan.
     */
    private static transact<T>(
        items: FileItem[], index: ReferenceIndexer, body: (transaction: MoveTransaction) => Promise<T>
    ): Promise<T> {
        return FileItem.preflight(items).then(() => {
            const transaction = new MoveTransaction();
            return body(transaction).catch((error: any): Promise<T> => {
                if (!transaction.hasChanges()) {
                    return Promise.reject(error);
                }
                const failure: MoveError = error instanceof Error ? error : new Error(String(error));
                failure.rolledBack = true;
                return Promise
                    .resolve(transaction.rollback().catch((rollbackError: any) => {
                        failure.rolledBack = false;
                        failure.rollbackError = rollbackError;
                    }))
                    .then(() => index.scanAll())
                    .then((): Promise<T> => Promise.reject(failure));
            });
        });
    }

    private static preflight(items: FileItem[]): Promise<void> {
        if (!items.length) {
            return Promise.reject(new Error('No files were selected to move.'));
        }
        const targets = new Set<string>();
        for (const item of items) {
            const target = path.resolve(item.targetPath);
            if (targets.has(target)) {
                return Promise.reject(new Error('Multiple files have the same destination: ' + item.targetPath));
            }
            targets.add(target);
        }
        for (const item of items) {
            if (!fs.existsSync(item.sourcePath)) {
                return Promise.reject(new Error(item.sourcePath + ' no longer exists.'));
            }
            if (item.exists()) {
                return Promise.reject(new Error(item.targetPath + ' already exists.'));
            }
        }
        return Promise.resolve();
    }

    private ensureDir(): Promise<any> {
        return fs.ensureDirAsync(path.dirname(this.targetPath));
    }
}
