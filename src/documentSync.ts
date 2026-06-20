import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';

export class DocumentSyncManager {
    private connectionManager: ConnectionManager;
    private disposables: vscode.Disposable[] = [];
    private isApplyingIncomingEdit = false;

    // Decoration type for partner's cursor
    private cursorDecorationType: vscode.TextEditorDecorationType;
    // Decoration type for partner's selection
    private selectionDecorationType: vscode.TextEditorDecorationType;

    // Track partner's cursors by file URI string
    // key: relativePath, value: list of selections
    private partnerSelections = new Map<string, vscode.Selection[]>();

    constructor(connectionManager: ConnectionManager) {
        this.connectionManager = connectionManager;

        const role = connectionManager.getState().role;
        const color = role === 'host' ? '#29B6F6' : '#FF7043'; // Blue for Guest, Orange for Host
        const nameLabel = role === 'host' ? ' Guest' : ' Host';

        // Custom cursors with a beautiful small tag containing the user's role
        this.cursorDecorationType = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: color,
            after: {
                contentText: nameLabel,
                color: '#FFFFFF',
                backgroundColor: color,
                margin: '0 0 0 4px',
                fontWeight: 'bold'
            }
        });

        this.selectionDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: role === 'host' ? 'rgba(41, 182, 246, 0.2)' : 'rgba(255, 112, 67, 0.2)'
        });

        this.setupListeners();
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
        this.cursorDecorationType.dispose();
        this.selectionDecorationType.dispose();
    }

    private getRelativePath(uri: vscode.Uri): string {
        const state = this.connectionManager.getState();
        if (state.role === 'host') {
            return '/' + vscode.workspace.asRelativePath(uri);
        } else {
            // guest scheme: collabfs:/src/index.js
            return uri.path;
        }
    }

    private getLocalUri(relativePath: string): vscode.Uri {
        const state = this.connectionManager.getState();
        if (state.role === 'host') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return vscode.Uri.file(relativePath);
            }
            const cleanRel = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
            return vscode.Uri.file(path.join(workspaceFolders[0].uri.fsPath, cleanRel));
        } else {
            return vscode.Uri.parse(`collabfs:${relativePath}`);
        }
    }

    private setupListeners() {
        // 1. Send local document changes to partner
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (this.isApplyingIncomingEdit) return;

                const uri = event.document.uri;
                // Only sync files that belong to our workspace
                const state = this.connectionManager.getState();
                if (state.role === 'guest' && uri.scheme !== 'collabfs') return;
                if (state.role === 'host' && uri.scheme !== 'file') return;

                const relPath = this.getRelativePath(uri);
                const changes = event.contentChanges.map(change => ({
                    range: [
                        change.range.start.line,
                        change.range.start.character,
                        change.range.end.line,
                        change.range.end.character
                    ],
                    rangeOffset: change.rangeOffset,
                    rangeLength: change.rangeLength,
                    text: change.text
                }));

                this.connectionManager.sendRelay('doc-edit', {
                    relativePath: relPath,
                    changes
                });
            })
        );

        this.disposables.push(
            new vscode.Disposable(
                this.connectionManager.on('doc-edit', async (payload: { relativePath: string, changes: any[] }) => {
                    const targetUri = this.getLocalUri(payload.relativePath);
                    
                    this.isApplyingIncomingEdit = true;
                    try {
                        const document = await vscode.workspace.openTextDocument(targetUri);
                        const edit = new vscode.WorkspaceEdit();

                        for (const change of payload.changes) {
                            const start = new vscode.Position(change.range[0], change.range[1]);
                            const end = new vscode.Position(change.range[2], change.range[3]);
                            const range = new vscode.Range(start, end);
                            
                            edit.replace(targetUri, range, change.text);
                        }

                        await vscode.workspace.applyEdit(edit);
                    } catch (err) {
                        console.error('Failed to apply incoming document sync edits', err);
                    } finally {
                        // Reset flag after a tiny delay to ensure events are processed
                        setTimeout(() => {
                            this.isApplyingIncomingEdit = false;
                        }, 50);
                    }
                })
            )
        );

        // 3. Send cursor and selection changes to partner
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                const uri = event.textEditor.document.uri;
                const state = this.connectionManager.getState();
                if (state.role === 'guest' && uri.scheme !== 'collabfs') return;
                if (state.role === 'host' && uri.scheme !== 'file') return;

                const relPath = this.getRelativePath(uri);
                const selections = event.selections.map(sel => ({
                    anchorLine: sel.anchor.line,
                    anchorChar: sel.anchor.character,
                    activeLine: sel.active.line,
                    activeChar: sel.active.character
                }));

                this.connectionManager.sendRelay('cursor-move', {
                    relativePath: relPath,
                    selections
                });
            })
        );

        this.disposables.push(
            new vscode.Disposable(
                this.connectionManager.on('cursor-move', (payload: { relativePath: string, selections: any[] }) => {
                    const selections = payload.selections.map(sel => 
                        new vscode.Selection(
                            new vscode.Position(sel.anchorLine, sel.anchorChar),
                            new vscode.Position(sel.activeLine, sel.activeChar)
                        )
                    );

                    this.partnerSelections.set(payload.relativePath, selections);
                    this.updateDecorationsForRelativePath(payload.relativePath);
                })
            )
        );

        // 5. Update decorations when visible text editors change
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                for (const relPath of this.partnerSelections.keys()) {
                    this.updateDecorationsForRelativePath(relPath);
                }
            })
        );
    }

    private updateDecorationsForRelativePath(relativePath: string) {
        const targetUri = this.getLocalUri(relativePath);
        const editors = vscode.window.visibleTextEditors.filter(
            editor => editor.document.uri.toString() === targetUri.toString()
        );

        const selections = this.partnerSelections.get(relativePath) || [];

        // Build decoration ranges
        const cursorRanges: vscode.Range[] = [];
        const selectionRanges: vscode.Range[] = [];

        for (const sel of selections) {
            // A cursor is just an empty range at the active end of selection
            cursorRanges.push(new vscode.Range(sel.active, sel.active));

            if (!sel.isEmpty) {
                selectionRanges.push(new vscode.Range(sel.start, sel.end));
            }
        }

        for (const editor of editors) {
            editor.setDecorations(this.cursorDecorationType, cursorRanges);
            editor.setDecorations(this.selectionDecorationType, selectionRanges);
        }
    }
}
