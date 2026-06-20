import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { PermissionManager } from './permissionManager';

export class CollabFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private connectionManager: ConnectionManager;
    private permissionManager: PermissionManager;

    constructor(connectionManager: ConnectionManager, permissionManager: PermissionManager) {
        this.connectionManager = connectionManager;
        this.permissionManager = permissionManager;

        // When permissions change, notify VS Code that all files might have changed
        // so that it refreshes read-only decorations and UI states.
        this.permissionManager.registerPermissionsChangedListener(() => {
            this._onDidChangeFile.fire([{
                type: vscode.FileChangeType.Changed,
                uri: vscode.Uri.parse('collabfs:/')
            }]);
        });
    }

    // --- Helper to trigger refreshes
    public fireChange(uri: vscode.Uri, type: vscode.FileChangeType) {
        this._onDidChangeFile.fire([{ uri, type }]);
    }

    // --- FileSystemProvider Implementation

    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        // Return a dummy disposable. We will push file updates manually over the websocket.
        return new vscode.Disposable(() => {});
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        try {
            const relPath = uri.path;
            const res = await this.connectionManager.sendRequest<any>('fs-stat', { path: relPath });
            
            const isWritable = this.permissionManager.isEditable(relPath);
            const permissions = isWritable ? undefined : vscode.FilePermission.Readonly;

            return {
                type: res.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: res.ctime,
                mtime: res.mtime,
                size: res.size,
                permissions: permissions
            };
        } catch (err) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        try {
            const relPath = uri.path;
            const res = await this.connectionManager.sendRequest<[string, number][]>('fs-readDir', { path: relPath });
            return res.map(([name, type]) => [name, type as vscode.FileType]);
        } catch (err) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    createDirectory(uri: vscode.Uri): Promise<void> {
        const relPath = uri.path;
        if (!this.permissionManager.isEditable(relPath)) {
            throw vscode.FileSystemError.NoPermissions('Write permission denied');
        }
        return this.connectionManager.sendRequest<void>('fs-createDir', { path: relPath });
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        try {
            const relPath = uri.path;
            const res = await this.connectionManager.sendRequest<{ content: string }>('fs-readFile', { path: relPath });
            return Uint8Array.from(Buffer.from(res.content, 'base64'));
        } catch (err) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
        const relPath = uri.path;
        if (!this.permissionManager.isEditable(relPath)) {
            throw vscode.FileSystemError.NoPermissions('Write permission denied');
        }

        const base64Content = Buffer.from(content).toString('base64');
        await this.connectionManager.sendRequest<void>('fs-writeFile', {
            path: relPath,
            content: base64Content,
            create: options.create,
            overwrite: options.overwrite
        });
        
        this.fireChange(uri, vscode.FileChangeType.Changed);
    }

    async delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): Promise<void> {
        const relPath = uri.path;
        if (!this.permissionManager.isEditable(relPath)) {
            throw vscode.FileSystemError.NoPermissions('Delete permission denied');
        }
        await this.connectionManager.sendRequest<void>('fs-delete', {
            path: relPath,
            recursive: options.recursive
        });

        this.fireChange(uri, vscode.FileChangeType.Deleted);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): Promise<void> {
        const oldRel = oldUri.path;
        const newRel = newUri.path;
        
        if (!this.permissionManager.isEditable(oldRel) || !this.permissionManager.isEditable(newRel)) {
            throw vscode.FileSystemError.NoPermissions('Rename permission denied');
        }

        await this.connectionManager.sendRequest<void>('fs-rename', {
            oldPath: oldRel,
            newPath: newRel,
            overwrite: options.overwrite
        });

        this.fireChange(oldUri, vscode.FileChangeType.Deleted);
        this.fireChange(newUri, vscode.FileChangeType.Created);
    }
}

/**
 * HOST SIDE: Registers handlers that run local file system operations on the host's actual folder
 */
export function registerHostFileSystemHandlers(connectionManager: ConnectionManager) {
    const getLocalPath = (relPath: string): string => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No local workspace folder is open on the host');
        }
        const root = workspaceFolders[0].uri.fsPath;
        // Clean leading slashes
        const cleanedRel = relPath.startsWith('/') ? relPath.substring(1) : relPath;
        return path.join(root, cleanedRel);
    };

    connectionManager.registerRpcHandler('fs-stat', (payload: { path: string }) => {
        const local = getLocalPath(payload.path);
        const stats = fs.statSync(local);
        return {
            size: stats.size,
            ctime: stats.birthtimeMs,
            mtime: stats.mtimeMs,
            isDirectory: stats.isDirectory()
        };
    });

    connectionManager.registerRpcHandler('fs-readDir', (payload: { path: string }) => {
        const local = getLocalPath(payload.path);
        const entries = fs.readdirSync(local, { withFileTypes: true });
        
        return entries.map(entry => {
            let type = vscode.FileType.Unknown;
            if (entry.isFile()) {
                type = vscode.FileType.File;
            } else if (entry.isDirectory()) {
                type = vscode.FileType.Directory;
            } else if (entry.isSymbolicLink()) {
                type = vscode.FileType.SymbolicLink;
            }
            return [entry.name, type];
        });
    });

    connectionManager.registerRpcHandler('fs-readFile', (payload: { path: string }) => {
        const local = getLocalPath(payload.path);
        const data = fs.readFileSync(local);
        return {
            content: data.toString('base64')
        };
    });

    connectionManager.registerRpcHandler('fs-writeFile', (payload: { path: string, content: string }) => {
        const local = getLocalPath(payload.path);
        const data = Buffer.from(payload.content, 'base64');
        
        // Ensure folder directory structure exists
        const parent = path.dirname(local);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, { recursive: true });
        }
        
        fs.writeFileSync(local, data);
        return { success: true };
    });

    connectionManager.registerRpcHandler('fs-createDir', (payload: { path: string }) => {
        const local = getLocalPath(payload.path);
        fs.mkdirSync(local, { recursive: true });
        return { success: true };
    });

    connectionManager.registerRpcHandler('fs-delete', (payload: { path: string, recursive: boolean }) => {
        const local = getLocalPath(payload.path);
        if (fs.existsSync(local)) {
            fs.rmSync(local, { recursive: payload.recursive, force: true });
        }
        return { success: true };
    });

    connectionManager.registerRpcHandler('fs-rename', (payload: { oldPath: string, newPath: string, overwrite: boolean }) => {
        const localOld = getLocalPath(payload.oldPath);
        const localNew = getLocalPath(payload.newPath);

        const parent = path.dirname(localNew);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, { recursive: true });
        }

        if (fs.existsSync(localNew) && !payload.overwrite) {
            throw new Error(`File already exists at destination: ${payload.newPath}`);
        }

        fs.renameSync(localOld, localNew);
        return { success: true };
    });
}
