import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';

export class PermissionManager {
    // Set of absolute/relative paths approved for edit on the guest.
    // For Guest: relative paths within the virtual workspace (e.g., '/src/index.js').
    // For Host: absolute paths on host's disk.
    private approvedPaths = new Set<string>();
    private connectionManager: ConnectionManager;
    private onPermissionsChangedCallbacks: (() => void)[] = [];

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;
        this.setupRpcHandlers();
    }

    public registerPermissionsChangedListener(cb: () => void) {
        this.onPermissionsChangedCallbacks.push(cb);
    }

    private triggerPermissionsChanged() {
        for (const cb of this.onPermissionsChangedCallbacks) {
            cb();
        }
    }

    public clear() {
        this.approvedPaths.clear();
        this.triggerPermissionsChanged();
    }

    /**
     * Checks if a relative path (guest-side) or absolute path (host-side) is allowed to be edited.
     */
    public isEditable(filePath: string): boolean {
        // Normalize slashes
        const normalized = filePath.replace(/\\/g, '/');

        // Check if there is an approved path that is a prefix of the normalized path
        for (const approved of this.approvedPaths) {
            if (approved === '/' || approved === '') {
                return true; // All files allowed
            }
            const normalizedApproved = approved.replace(/\\/g, '/');
            
            // Check exact file match
            if (normalized === normalizedApproved) {
                return true;
            }
            
            // Check directory match: /src/ folder matches /src/index.ts
            // Ensure we match with trailing slash boundaries to avoid partial folder name matches
            const folderPrefix = normalizedApproved.endsWith('/') ? normalizedApproved : normalizedApproved + '/';
            if (normalized.startsWith(folderPrefix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Guest requests edit permission from host.
     * @param relativePath The relative path of the file/folder in the mounted workspace.
     */
    public async requestEditPermission(relativePath: string): Promise<boolean> {
        try {
            vscode.window.showInformationMessage(`Requesting edit permission for ${relativePath}...`);
            const response = await this.connectionManager.sendRequest<{ success: boolean; approvedPath: string }>(
                'request-edit-permission',
                { relativePath }
            );

            if (response && response.success) {
                this.approvedPaths.add(response.approvedPath);
                vscode.window.showInformationMessage(`Edit permission GRANTED for: ${response.approvedPath}`);
                this.triggerPermissionsChanged();
                return true;
            } else {
                vscode.window.showWarningMessage(`Edit permission DENIED for ${relativePath}`);
                return false;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to request permission: ${err.message}`);
            return false;
        }
    }

    private setupRpcHandlers() {
        // HOST SIDE: Handle requests from guest
        this.connectionManager.registerRpcHandler('request-edit-permission', async (payload: { relativePath: string }) => {
            const relPath = payload.relativePath;
            
            // Find host workspace folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return { success: false, approvedPath: '' };
            }

            const hostRoot = workspaceFolders[0].uri.fsPath;
            // Map the virtual relative path to the local absolute path on host
            const hostAbsPath = vscode.Uri.file(require('path').join(hostRoot, relPath)).fsPath;

            const filename = require('path').basename(relPath);
            const parentDir = require('path').dirname(relPath);

            const options = [
                `Approve File (${filename})`,
                `Approve Folder (${parentDir})`,
                'Approve Entire Project',
                'Deny'
            ];

            const choice = await vscode.window.showInformationMessage(
                `Your partner wants edit permission for: ${relPath}. Approve?`,
                ...options
            );

            if (choice === options[0]) {
                // Approve File
                this.approvedPaths.add(relPath);
                this.triggerPermissionsChanged();
                return { success: true, approvedPath: relPath };
            } else if (choice === options[1]) {
                // Approve Folder
                this.approvedPaths.add(parentDir);
                this.triggerPermissionsChanged();
                return { success: true, approvedPath: parentDir };
            } else if (choice === options[2]) {
                // Approve Entire Project (root)
                this.approvedPaths.add('/');
                this.triggerPermissionsChanged();
                return { success: true, approvedPath: '/' };
            }

            return { success: false, approvedPath: '' };
        });
    }
}
