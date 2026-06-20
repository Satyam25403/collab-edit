import * as vscode from 'vscode';
import { ConnectionManager, ConnectionInfo } from './connectionManager';
import { PermissionManager } from './permissionManager';

export class CollabSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'collab-sidebar';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly permissionManager: PermissionManager
    ) {
        // Listen to connection state updates
        this.connectionManager.registerStateChangeListener(() => {
            this.updateWebviewState();
        });

        // Listen to permission updates
        this.permissionManager.registerPermissionsChangedListener(() => {
            this.updateWebviewState();
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void | Thenable<void> {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        // KEY FIX 1: Keep the webview alive when hidden so state is never lost
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from Webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready':
                    // KEY FIX 2: Webview signals it's loaded — push current state immediately
                    this.updateWebviewState();
                    break;
                case 'createRoom':
                    vscode.commands.executeCommand('collab.createRoom');
                    break;
                case 'joinRoom':
                    vscode.commands.executeCommand('collab.joinRoom', data.roomId);
                    break;
                case 'leaveRoom':
                    vscode.commands.executeCommand('collab.leaveRoom');
                    break;
                case 'requestEdit':
                    vscode.commands.executeCommand('collab.requestEditPermission');
                    break;
            }
        });

        // Initial state update
        this.updateWebviewState();
    }

    private updateWebviewState() {
        if (!this._view) return;

        const info = this.connectionManager.getState();
        const approvedPaths = Array.from((this.permissionManager as any).approvedPaths || []);

        this._view.webview.postMessage({
            type: 'stateChanged',
            state: info,
            approvedPaths: approvedPaths
        });
    }

    private getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Collab Panel</title>
            <style>
                :root {
                    --accent-color: #6366f1;
                    --accent-hover: #4f46e5;
                    --success-color: #10b981;
                    --danger-color: #ef4444;
                    --bg-card: rgba(255, 255, 255, 0.03);
                    --border-card: rgba(255, 255, 255, 0.08);
                    --text-muted: #9ca3af;
                }

                body {
                    padding: 12px;
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                    font-size: 13px;
                    background-color: var(--vscode-sideBar-background);
                }

                .container {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }

                h1, h2, h3 {
                    margin: 0;
                    font-weight: 600;
                }

                .card {
                    background: var(--bg-card);
                    border: 1px solid var(--border-card);
                    border-radius: 8px;
                    padding: 14px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    backdrop-filter: blur(10px);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                }

                .badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    padding: 4px 8px;
                    border-radius: 20px;
                    width: fit-content;
                }

                .badge-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                }

                .badge-disconnected {
                    background-color: rgba(239, 68, 68, 0.15);
                    color: var(--danger-color);
                }
                .badge-disconnected .badge-dot {
                    background-color: var(--danger-color);
                }

                .badge-connecting {
                    background-color: rgba(245, 158, 11, 0.15);
                    color: #f59e0b;
                }
                .badge-connecting .badge-dot {
                    background-color: #f59e0b;
                    animation: pulse 1.5s infinite;
                }

                .badge-hosting, .badge-joined {
                    background-color: rgba(16, 185, 129, 0.15);
                    color: var(--success-color);
                }
                .badge-hosting .badge-dot, .badge-joined .badge-dot {
                    background-color: var(--success-color);
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0% { transform: scale(0.9); opacity: 0.6; }
                    50% { transform: scale(1.2); opacity: 1; }
                    100% { transform: scale(0.9); opacity: 0.6; }
                }

                .button {
                    background-color: var(--accent-color);
                    color: #ffffff;
                    border: none;
                    padding: 8px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 600;
                    text-align: center;
                    transition: all 0.2s ease;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 8px;
                }

                .button:hover {
                    background-color: var(--accent-hover);
                    transform: translateY(-1px);
                }

                .button:active {
                    transform: translateY(0);
                }

                .button-secondary {
                    background-color: transparent;
                    border: 1px solid var(--border-card);
                    color: var(--vscode-foreground);
                }
                .button-secondary:hover {
                    background-color: rgba(255, 255, 255, 0.05);
                }

                .button-danger {
                    background-color: rgba(239, 68, 68, 0.15);
                    color: #f87171;
                    border: 1px solid rgba(239, 68, 68, 0.2);
                }
                .button-danger:hover {
                    background-color: var(--danger-color);
                    color: white;
                }

                input {
                    background: rgba(0, 0, 0, 0.2);
                    border: 1px solid var(--border-card);
                    color: var(--vscode-foreground);
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-family: inherit;
                    font-size: 13px;
                    outline: none;
                    transition: border-color 0.2s;
                }

                input:focus {
                    border-color: var(--accent-color);
                }

                .room-code-display {
                    font-size: 24px;
                    font-weight: 700;
                    letter-spacing: 2px;
                    text-align: center;
                    padding: 8px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 6px;
                    border: 1px dashed var(--border-card);
                    cursor: pointer;
                    position: relative;
                }

                .room-code-display::after {
                    content: 'Click to copy';
                    font-size: 10px;
                    color: var(--text-muted);
                    position: absolute;
                    bottom: 2px;
                    right: 6px;
                    font-weight: normal;
                    letter-spacing: 0;
                }

                .list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }

                .list-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 6px 10px;
                    background: rgba(255, 255, 255, 0.02);
                    border-radius: 4px;
                    border-left: 3px solid var(--accent-color);
                }

                .list-item-path {
                    font-family: var(--vscode-editor-font-family, monospace);
                    font-size: 11px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <!-- Status Card -->
                <div class="card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold;">Connection Status</span>
                        <div id="status-badge" class="badge badge-disconnected">
                            <div class="badge-dot"></div>
                            <span id="status-text">Offline</span>
                        </div>
                    </div>
                </div>

                <!-- Disconnected State Controls -->
                <div id="disconnected-controls" class="card">
                    <h3>Host Pair Session</h3>
                    <p style="color: var(--text-muted); margin: 0 0 4px 0;">Share your workspace and files with a partner programmer.</p>
                    <button id="create-btn" class="button">Create Session Room</button>
                    
                    <hr style="border: none; border-top: 1px solid var(--border-card); margin: 8px 0;">

                    <h3>Join Pair Session</h3>
                    <p style="color: var(--text-muted); margin: 0 0 4px 0;">Connect to a partner's room and view their files.</p>
                    <input type="text" id="join-input" placeholder="Enter 6-Digit Room Code" maxLength="6" style="text-align: center;">
                    <button id="join-btn" class="button button-secondary">Join Session</button>
                </div>

                <!-- Hosting/Connected State Controls -->
                <div id="active-controls" class="card" style="display: none;">
                    <h3 id="session-title">Active Session</h3>
                    <div id="room-code" class="room-code-display">------</div>
                    
                    <!-- Guest controls — always visible when joined -->
                    <div id="guest-action-section" style="display: none; flex-direction: column; gap: 8px;">
                        <p style="color: var(--text-muted); margin: 0;">You are in READ mode.</p>
                        <button id="request-edit-btn" class="button" style="width: 100%;">⚡ Request Edit Permission</button>
                    </div>

                    <!-- Host controls -->
                    <div id="host-action-section" style="display: none;">
                        <p style="color: var(--text-muted); margin: 0;">Provide this code to your partner so they can connect.</p>
                    </div>

                    <button id="leave-btn" class="button button-danger">Leave Session</button>
                </div>

                <!-- Approved Permissions List -->
                <div id="permissions-section" class="card" style="display: none;">
                    <h3>Editable Folders/Files</h3>
                    <p style="color: var(--text-muted); margin: 0 0 4px 0;">Write access is approved for these paths:</p>
                    <ul id="permissions-list" class="list">
                    </ul>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                const statusBadge = document.getElementById('status-badge');
                const statusText = document.getElementById('status-text');
                const disconnectedControls = document.getElementById('disconnected-controls');
                const activeControls = document.getElementById('active-controls');
                const sessionTitle = document.getElementById('session-title');
                const roomCodeDisplay = document.getElementById('room-code');
                const permissionsSection = document.getElementById('permissions-section');
                const permissionsList = document.getElementById('permissions-list');
                const guestActionSection = document.getElementById('guest-action-section');
                const hostActionSection = document.getElementById('host-action-section');

                const createBtn = document.getElementById('create-btn');
                const joinBtn = document.getElementById('join-btn');
                const joinInput = document.getElementById('join-input');
                const leaveBtn = document.getElementById('leave-btn');
                const requestEditBtn = document.getElementById('request-edit-btn');

                createBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'createRoom' });
                });

                joinBtn.addEventListener('click', () => {
                    const code = joinInput.value.trim();
                    if (code.length === 6) {
                        vscode.postMessage({ type: 'joinRoom', roomId: code });
                    }
                });

                joinInput.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter') joinBtn.click();
                });

                leaveBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'leaveRoom' });
                });

                requestEditBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'requestEdit' });
                });

                roomCodeDisplay.addEventListener('click', () => {
                    navigator.clipboard.writeText(roomCodeDisplay.innerText);
                    const oldText = roomCodeDisplay.innerText;
                    roomCodeDisplay.innerText = 'COPIED!';
                    setTimeout(() => { roomCodeDisplay.innerText = oldText; }, 1000);
                });

                // Listen for messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'stateChanged') {
                        updateUi(message.state, message.approvedPaths);
                    }
                });

                function updateUi(stateInfo, approvedPaths) {
                    const { state, roomId, role } = stateInfo;

                    // Update Status Badge
                    statusBadge.className = 'badge badge-' + state;
                    statusText.innerText = state.charAt(0).toUpperCase() + state.slice(1);

                    if (state === 'disconnected') {
                        disconnectedControls.style.display = 'flex';
                        activeControls.style.display = 'none';
                        permissionsSection.style.display = 'none';
                        joinInput.value = '';
                    } else if (state === 'connecting') {
                        disconnectedControls.style.display = 'none';
                        activeControls.style.display = 'none';
                        permissionsSection.style.display = 'none';
                    } else { // hosting or joined
                        disconnectedControls.style.display = 'none';
                        activeControls.style.display = 'flex';
                        roomCodeDisplay.innerText = roomId || '------';

                        if (role === 'host') {
                            sessionTitle.innerText = 'Hosting Session';
                            hostActionSection.style.display = 'block';
                            guestActionSection.style.display = 'none';
                        } else {
                            sessionTitle.innerText = 'Joined Session';
                            hostActionSection.style.display = 'none';
                            // KEY FIX: Always show Request Edit button when guest is joined
                            guestActionSection.style.display = 'flex';
                        }

                        // Permissions list
                        permissionsSection.style.display = 'flex';
                        permissionsList.innerHTML = '';
                        if (approvedPaths && approvedPaths.length > 0) {
                            approvedPaths.forEach(path => {
                                const li = document.createElement('li');
                                li.className = 'list-item';
                                li.innerHTML = '<span class="list-item-path">' + (path === '/' ? 'Entire Workspace' : path) + '</span>';
                                permissionsList.appendChild(li);
                            });
                        } else {
                            permissionsList.innerHTML = '<li style="color: var(--text-muted); list-style: none; padding: 4px 0;">No edit permissions approved yet. (Read Only)</li>';
                        }
                    }
                }

                // KEY FIX: Signal to extension that webview is ready to receive state
                vscode.postMessage({ type: 'ready' });
            </script>
        </body>
        </html>`;
    }
}