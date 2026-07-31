import * as fs from 'fs-extra-promise';

export interface Move {
    sourcePath: string;
    targetPath: string;
}

function serial(tasks: Array<() => PromiseLike<any>>, onError?: (error: any) => void): Promise<void> {
    return tasks
        .reduce((chain: Promise<any>, task) => {
            return chain.then(() => {
                const running = Promise.resolve(task());
                return onError ? running.then(undefined, onError) : running;
            });
        }, Promise.resolve())
        .then(() => undefined);
}

/**
 * Like `Promise.all`, but every task is allowed to settle before the first failure is rethrown.
 * `Promise.all` rejects as soon as one task fails, which would let a rollback start while sibling
 * writes are still pending; those writes would then land on top of the files just restored.
 */
export function settleAll(tasks: Array<PromiseLike<any>>): Promise<void> {
    const failures: any[] = [];
    const settled = tasks.map(task => {
        return Promise.resolve(task).then(() => undefined, (error: any) => {
            failures.push(error);
        });
    });
    return Promise.all(settled).then(() => {
        if (failures.length) {
            throw failures[0];
        }
    });
}

/**
 * Records the mutations made by a move so they can be put back if a later
 * rename or import update fails.  Import contents are restored before files
 * are renamed back, which also handles edits to files inside a moved folder.
 */
export class MoveTransaction {
    private restores: Map<string, () => PromiseLike<any>> = new Map();
    private completedMoves: Move[] = [];

    /** True once anything has been mutated, and so once there is something to roll back. */
    public hasChanges(): boolean {
        return this.restores.size > 0 || this.completedMoves.length > 0;
    }

    public recordOriginal(filePath: string, contents: string): void {
        this.recordRestore(filePath, () => fs.writeFileAsync(filePath, contents, 'utf8'));
    }

    public recordRestore(filePath: string, restore: () => PromiseLike<any>): void {
        if (!this.restores.has(filePath)) {
            this.restores.set(filePath, restore);
        }
    }

    /** Renames a file, recording it only once it has actually happened. */
    public rename(sourcePath: string, targetPath: string): Promise<void> {
        return fs.renameAsync(sourcePath, targetPath).then(() => {
            this.completedMoves.push({sourcePath, targetPath});
        });
    }

    /** Renames serially, so a failure part way through leaves every earlier rename recorded. */
    public renameAll(moves: Move[]): Promise<void> {
        return serial(moves.map(move => () => this.rename(move.sourcePath, move.targetPath)));
    }

    public rollback(): Promise<void> {
        const failures: any[] = [];
        const collect = (error: any) => {
            failures.push(error);
        };
        const reverseRenames = this.completedMoves.slice().reverse().map(move => {
            return () => fs.renameAsync(move.targetPath, move.sourcePath);
        });

        return serial(Array.from(this.restores.values()), collect)
            .then(() => serial(reverseRenames, collect))
            .then(() => {
                if (failures.length) {
                    throw new Error(
                        'Move rollback was incomplete: ' + failures.map(error => error.message || error).join('; ')
                    );
                }
            });
    }
}
