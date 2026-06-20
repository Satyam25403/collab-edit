import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';

export type ConnectionState = 'disconnected' | 'connecting' | 'hosting' | 'joined';

export interface ConnectionInfo {
    state: ConnectionState;
    roomId?: string;
    role?: 'host' | 'guest';
}

export class ConnectionManager {
    private socket: WebSocket | null = null;
    private state: ConnectionState = 'disconnected';
    private roomId?: string;
    private role?: 'host' | 'guest';
    private pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();

    private onStateChangeCallbacks: ((info: ConnectionInfo) => void)[] = [];
    private onMessageCallbacks = new Map<string, ((payload: any) => void)[]>();

    constructor() { }

    public getState(): ConnectionInfo {
        return {
            state: this.state,
            roomId: this.roomId,
            role: this.role
        };
    }

    public registerStateChangeListener(cb: (info: ConnectionInfo) => void) {
        this.onStateChangeCallbacks.push(cb);
        cb(this.getState());
    }

    private updateState(state: ConnectionState, roomId?: string, role?: 'host' | 'guest') {
        this.state = state;
        this.roomId = roomId;
        this.role = role;
        const info = this.getState();
        for (const cb of this.onStateChangeCallbacks) {
            cb(info);
        }
    }

    public connect(serverUrl: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.updateState('connecting');
            try {
                const ws = new WebSocket(serverUrl);
                this.socket = ws;

                ws.on('open', () => {
                    resolve();
                });

                ws.on('message', (data) => {
                    this.handleMessage(data.toString());
                });

                ws.on('error', (err) => {
                    vscode.window.showErrorMessage(`Collab connection error: ${err.message}`);
                    this.disconnect();
                    reject(err);
                });

                ws.on('close', () => {
                    this.disconnect();
                });
            } catch (err: any) {
                this.updateState('disconnected');
                reject(err);
                return;
            }
        });
    }

    public disconnect() {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) { }
            this.socket = null;
        }
        this.updateState('disconnected');
        this.pendingRequests.forEach(req => req.reject(new Error('Disconnected')));
        this.pendingRequests.clear();
    }

    public createRoom(): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected to relay server'));
                return;
            }

            const timeout = setTimeout(() => {
                reject(new Error('Create room timeout'));
            }, 10000);

            const unsub = this.on('room-created', (payload) => {
                clearTimeout(timeout);
                unsub();
                resolve(payload.roomId);
            });

            const unsubErr = this.on('error', (payload) => {
                clearTimeout(timeout);
                unsubErr();
                reject(new Error(payload.message || 'Failed to create room'));
            });

            this.socket.send(JSON.stringify({ type: 'create-room' }));
        });
    }

    public joinRoom(roomId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected to relay server'));
                return;
            }

            this.socket.send(JSON.stringify({ type: 'join-room', roomId }));
            // We resolve via regular message handling when room-joined is received

            const timeout = setTimeout(() => {
                reject(new Error('Join room timeout'));
            }, 10000);

            const unsub = this.on('room-joined', (payload) => {
                clearTimeout(timeout);
                unsub();
                this.updateState('joined', roomId, 'guest');
                resolve(roomId);
            });

            const unsubErr = this.on('error', (payload) => {
                clearTimeout(timeout);
                unsubErr();
                this.updateState('disconnected');
                reject(new Error(payload.message || 'Failed to join room'));
            });
        });
    }

    public sendRelay(type: string, payload: any) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        this.socket.send(JSON.stringify({
            type: 'relay',
            payload: { type, ...payload }
        }));
    }

    public on(type: string, callback: (payload: any) => void): () => void {
        if (!this.onMessageCallbacks.has(type)) {
            this.onMessageCallbacks.set(type, []);
        }
        this.onMessageCallbacks.get(type)!.push(callback);
        return () => {
            const list = this.onMessageCallbacks.get(type);
            if (list) {
                const idx = list.indexOf(callback);
                if (idx !== -1) list.splice(idx, 1);
            }
        };
    }

    private emit(type: string, payload: any) {
        const list = this.onMessageCallbacks.get(type);
        if (list) {
            for (const cb of [...list]) {
                cb(payload);
            }
        }
    }

    private handleMessage(dataStr: string) {
        try {
            const data = JSON.parse(dataStr);

            if (data.type === 'room-created') {
                this.updateState('hosting', data.roomId, 'host');
                this.emit('room-created', data);
            } else if (data.type === 'room-joined') {
                this.updateState('joined', data.roomId, 'guest');
                this.emit('room-joined', data);
            } else if (data.type === 'guest-joined') {
                vscode.window.showInformationMessage('A programmer has joined your session!');
                this.emit('guest-joined', data);
            } else if (data.type === 'guest-disconnected') {
                vscode.window.showWarningMessage('Your partner has disconnected.');
                this.emit('guest-disconnected', data);
            } else if (data.type === 'host-disconnected') {
                vscode.window.showErrorMessage('The host closed the room.');
                this.disconnect();
            } else if (data.type === 'error') {
                this.emit('error', data);
            } else if (data.type === 'relay') {
                const payload = data.payload;
                if (payload && payload.type) {
                    this.emit(payload.type, payload);
                }
            }
        } catch (err) {
            console.error('Error parsing WebSocket message', err);
        }
    }

    // RPC: Send a request and wait for a response
    public sendRequest<T>(type: string, payload: any): Promise<T> {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 11);

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request timeout: ${type}`));
            }, 30000);

            this.pendingRequests.set(requestId, {
                resolve: (val) => {
                    clearTimeout(timeout);
                    resolve(val);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            this.sendRelay('rpc-request', {
                requestId,
                requestType: type,
                payload
            });
        });
    }

    public registerRpcHandler(type: string, handler: (payload: any) => Promise<any> | any) {
        return this.on('rpc-request', async (msg: any) => {
            if (msg.requestType === type) {
                try {
                    const result = await handler(msg.payload);
                    this.sendRelay('rpc-response', {
                        requestId: msg.requestId,
                        success: true,
                        result
                    });
                } catch (err: any) {
                    this.sendRelay('rpc-response', {
                        requestId: msg.requestId,
                        success: false,
                        error: err.message || String(err)
                    });
                }
            }
        });
    }

    public registerResponseListener() {
        return this.on('rpc-response', (msg: any) => {
            const pending = this.pendingRequests.get(msg.requestId);
            if (pending) {
                this.pendingRequests.delete(msg.requestId);
                if (msg.success) {
                    pending.resolve(msg.result);
                } else {
                    pending.reject(new Error(msg.error));
                }
            }
        });
    }
}
