import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { PermissionManager } from './permissionManager';
import { CollabFileSystemProvider, registerHostFileSystemHandlers } from './collabFileSystemProvider';
import { DocumentSyncManager } from './documentSync';
import { CollabSidebarProvider } from './sidebarProvider';

let connectionManager: ConnectionManager;
let permissionManager: PermissionManager;
let fsProvider: CollabFileSystemProvider;
let docSyncManager: DocumentSyncManager | null = null;
let providerRegistration: vscode.Disposable | null = null;

const RELAY_SERVER_URL = 'wss://collab-edit-server-fv8j.onrender.com'; // Default relay server URL

export function activate(context: vscode.ExtensionContext) {
    console.log('Collab Edit Extension activated');

    // 1. Initialize core managers
    connectionManager = new ConnectionManager();
    permissionManager = new PermissionManager(connectionManager);

    // Register the response listener for RPC responses
    const responseListener = connectionManager.registerResponseListener();
    context.subscriptions.push(new vscode.Disposable(responseListener));

    // 2. Register virtual file system provider
    fsProvider = new CollabFileSystemProvider(connectionManager, permissionManager);
    providerRegistration = vscode.workspace.registerFileSystemProvider('collabfs', fsProvider, {
        isCaseSensitive: true,
        isReadonly: false // Readonly status is handled dynamically per-file inside stat()
    });
    context.subscriptions.push(providerRegistration);

    // 3. Register Sidebar Provider
    const sidebarProvider = new CollabSidebarProvider(connectionManager, permissionManager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CollabSidebarProvider.viewType,
            sidebarProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // 4. Register commands

    // CREATE ROOM
    const createRoomCmd = vscode.commands.registerCommand('collab.createRoom', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('You must open a local project folder in VS Code before hosting a room.');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Creating room...",
                cancellable: false
            }, async () => {
                await connectionManager.connect(RELAY_SERVER_URL);
                const roomId = await connectionManager.createRoom();

                // Host setup
                registerHostFileSystemHandlers(connectionManager);
                docSyncManager = new DocumentSyncManager(connectionManager);

                vscode.window.showInformationMessage(`Room created successfully! Share Code: ${roomId}`, 'Copy Code').then(val => {
                    if (val === 'Copy Code') {
                        vscode.env.clipboard.writeText(roomId);
                    }
                });
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create room: ${err.message}`);
            connectionManager.disconnect();
        }
    });
    context.subscriptions.push(createRoomCmd);

    // JOIN ROOM
    // JOIN ROOM
    const joinRoomCmd = vscode.commands.registerCommand('collab.joinRoom', async (roomId?: string) => {
        if (!roomId) {
            roomId = await vscode.window.showInputBox({
                prompt: 'Enter the 6-digit room code to join',
                placeHolder: 'e.g. 123456',
                validateInput: (val) => {
                    return val.trim().length === 6 && /^\d+$/.test(val.trim()) ? null : 'Please enter a valid 6-digit numeric code';
                }
            });
        }

        if (!roomId) return;

        try {
            const finalRoomId = roomId.trim();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Joining room ${finalRoomId}...`,
                cancellable: false
            }, async () => {
                await connectionManager.connect(RELAY_SERVER_URL);
                await connectionManager.joinRoom(finalRoomId);

                // Guest setup
                permissionManager.clear();
                docSyncManager = new DocumentSyncManager(connectionManager);

                // Wait for host to confirm it's ready before mounting filesystem
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Host did not respond in time. Make sure the host has a folder open.'));
                    }, 10000);

                    // Probe the host with a stat request on root
                    connectionManager.sendRequest<any>('fs-stat', { path: '/' }).then(() => {
                        clearTimeout(timeout);
                        resolve();
                    }).catch((err) => {
                        clearTimeout(timeout);
                        reject(err);
                    });
                });

                // Now safe to mount — host is confirmed responsive
                const uri = vscode.Uri.parse('collabfs:/');
                const folders = vscode.workspace.workspaceFolders || [];
                const collabFolderIndex = folders.findIndex(f => f.uri.scheme === 'collabfs');

                if (collabFolderIndex !== -1) {
                    vscode.workspace.updateWorkspaceFolders(collabFolderIndex, 1, { uri, name: `Collab Room [${finalRoomId}]` });
                } else {
                    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `Collab Room [${finalRoomId}]` });
                }

                vscode.window.showInformationMessage(`Connected to room ${finalRoomId}! Mounting project workspace...`);
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to join room: ${err.message}`);
            connectionManager.disconnect();
        }
    });
    context.subscriptions.push(joinRoomCmd);

    // LEAVE ROOM
    const leaveRoomCmd = vscode.commands.registerCommand('collab.leaveRoom', () => {
        const info = connectionManager.getState();
        if (info.state === 'disconnected') return;

        connectionManager.disconnect();
        permissionManager.clear();

        if (docSyncManager) {
            docSyncManager.dispose();
            docSyncManager = null;
        }

        // Unmount virtual directory if it exists (Guest side)
        const folders = vscode.workspace.workspaceFolders || [];
        const index = folders.findIndex(f => f.uri.scheme === 'collabfs');
        if (index !== -1) {
            vscode.workspace.updateWorkspaceFolders(index, 1);
        }

        vscode.window.showInformationMessage('You have left the session.');
    });
    context.subscriptions.push(leaveRoomCmd);

    // REQUEST EDIT PERMISSION
    const requestEditCmd = vscode.commands.registerCommand('collab.requestEditPermission', async () => {
        const info = connectionManager.getState();
        if (info.state !== 'joined' || info.role !== 'guest') {
            vscode.window.showErrorMessage('You must be a guest in an active session to request edit permissions.');
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        let relativePath = '/';

        if (activeEditor && activeEditor.document.uri.scheme === 'collabfs') {
            relativePath = activeEditor.document.uri.path;
        } else {
            // Ask the user if they want to request permission for everything
            const choice = await vscode.window.showWarningMessage(
                'No active collaborative file is open. Do you want to request edit permission for the entire project workspace?',
                'Yes, Request All',
                'Cancel'
            );
            if (choice !== 'Yes, Request All') return;
        }

        await permissionManager.requestEditPermission(relativePath);
    });
    context.subscriptions.push(requestEditCmd);
}

export function deactivate() {
    if (connectionManager) {
        connectionManager.disconnect();
    }
    if (docSyncManager) {
        docSyncManager.dispose();
    }
}
