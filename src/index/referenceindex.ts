import * as path from 'path';

export interface Reference {
    path:string;
}

export class ReferenceIndex {
    private referencedBy:{[key:string]:Reference[]} = {}; //path -> all of the files that reference it

    private references:{[key:string]:Reference[]} = {}; //path -> all of the files that it references

    //path references the reference
    public addReference(reference:string, path:string) {
        if(!this.referencedBy.hasOwnProperty(reference)) {
            this.referencedBy[reference] = [];
        }
        if(!this.references.hasOwnProperty(path)) {
            this.references[path] = [];
        }

        if(!this.references[path].some(ref => {
            return ref.path == reference;
        })) {
            this.references[path].push({
                path:reference
            });
        }


        if (!this.referencedBy[reference].some(reference => {
            return reference.path == path;
        })) {
            this.referencedBy[reference].push({
                path,
            });
        }
    }

    public deleteByPath(path:string) {
        if(this.references.hasOwnProperty(path)) {
            this.references[path].forEach(p => {
                if(this.referencedBy.hasOwnProperty(p.path)) {
                    this.referencedBy[p.path] = this.referencedBy[p.path].filter(reference => {
                        return reference.path != path;
                    });
                }
            });
            delete this.references[path];
        }
    }

    // get a list of all of the files outside of this directory that reference files
    // inside of this directory.
    public getDirReferences(directory:string):Reference[] {
        let result:Reference[] = [];

        for(let p in this.referencedBy) {
            if(path.relative(directory, p).startsWith('../')) {
                this.referencedBy[p].forEach(reference => {
                    if(path.relative(directory, reference.path).startsWith('../')) {
                        result.push(reference);
                    }
                });
            }
        }
        return result;
    }

    // get a list of all of the files that reference path
    public getReferences(path:string):Reference[] {
        if(this.referencedBy.hasOwnProperty(path)) {
            return this.referencedBy[path];
        }
        return [];
    }
}