import * as ts from 'typescript';

export function walk(node: ts.Node, fn: (node: ts.Node) => any): boolean {
    if (fn(node)) {
        return true;
    }
    const children = node.getChildren();
    for (let i = 0; i < children.length; i++) {
        if (walk(children[i], fn)) {
            return true;
        }
    }
    return false;
};