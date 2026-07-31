import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {MoveTransaction, settleAll} from '../src/movetransaction';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'move-ts-transaction-'));
}

function removeTempDir(dir: string): void {
    // Node versions supported by this extension predate fs.rmSync.
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
        fs.rmdirSync(dir);
    }
}

describe('MoveTransaction', () => {
    let dir: string;

    beforeEach(() => {
        dir = createTempDir();
    });

    afterEach(() => {
        removeTempDir(dir);
    });

    it('restores changed importers and reverses completed moves', async () => {
        const source = path.join(dir, 'source.ts');
        const target = path.join(dir, 'target.ts');
        const importer = path.join(dir, 'importer.ts');
        fs.writeFileSync(source, 'export const source = true;\n');
        fs.writeFileSync(importer, 'import "./source";\n');

        const transaction = new MoveTransaction();
        transaction.recordOriginal(importer, fs.readFileSync(importer, 'utf8'));

        await transaction.rename(source, target);
        transaction.recordOriginal(target, fs.readFileSync(target, 'utf8'));
        fs.writeFileSync(target, 'broken\n');
        fs.writeFileSync(importer, 'import "./target";\n');

        await transaction.rollback();

        assert.strictEqual(fs.existsSync(source), true);
        assert.strictEqual(fs.existsSync(target), false);
        assert.strictEqual(fs.readFileSync(source, 'utf8'), 'export const source = true;\n');
        assert.strictEqual(fs.readFileSync(importer, 'utf8'), 'import "./source";\n');
    });

    it('continues rollback after an individual restore fails', async () => {
        const source = path.join(dir, 'source.ts');
        const target = path.join(dir, 'target.ts');
        const restored = path.join(dir, 'restored.txt');
        fs.writeFileSync(source, 'original\n');

        const transaction = new MoveTransaction();
        transaction.recordRestore('first', () => Promise.reject(new Error('restore failed')));
        transaction.recordRestore('second', () => {
            fs.writeFileSync(restored, 'restored\n');
            return Promise.resolve();
        });

        await transaction.rename(source, target);

        let error: Error|undefined;
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            error = rollbackError;
        }

        assert.ok(error);
        assert.ok(error!.message.indexOf('restore failed') >= 0);
        assert.strictEqual(fs.readFileSync(restored, 'utf8'), 'restored\n');
        assert.strictEqual(fs.existsSync(source), true);
        assert.strictEqual(fs.existsSync(target), false);
    });

    it('reports whether anything has been mutated', async () => {
        const source = path.join(dir, 'source.ts');
        fs.writeFileSync(source, 'original\n');

        const transaction = new MoveTransaction();
        assert.strictEqual(transaction.hasChanges(), false);

        transaction.recordOriginal(source, 'original\n');
        assert.strictEqual(transaction.hasChanges(), true);

        const renameOnly = new MoveTransaction();
        await renameOnly.rename(source, path.join(dir, 'target.ts'));
        assert.strictEqual(renameOnly.hasChanges(), true);
    });
});

describe('settleAll', () => {
    it('waits for pending tasks before rethrowing an earlier failure', async () => {
        let latePending = true;
        const late = new Promise(resolve => {
            setTimeout(() => {
                latePending = false;
                resolve(undefined);
            }, 20);
        });

        let error: Error|undefined;
        try {
            await settleAll([Promise.reject(new Error('first')), late]);
        } catch (caught) {
            error = caught;
        }

        assert.ok(error);
        assert.strictEqual(error!.message, 'first');
        assert.strictEqual(latePending, false, 'settleAll must not reject while a task is still running');
    });

    it('rethrows the first failure and resolves when every task succeeds', async () => {
        await settleAll([Promise.resolve(1), Promise.resolve(2)]);

        let error: Error|undefined;
        try {
            await settleAll([
                Promise.reject(new Error('first')),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('second')), 10)),
            ]);
        } catch (caught) {
            error = caught;
        }

        assert.ok(error);
        assert.strictEqual(error!.message, 'first');
    });
});
