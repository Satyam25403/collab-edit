const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Collab Edit Relay Server is running\n');
});

const wss = new WebSocketServer({ server });

// Map of roomId -> { hostSocket, guestSocket }
const rooms = new Map();
// Map of socket -> { roomId, role: 'host' | 'guest' }
const clientState = new Map();

function generateRoomId() {
    let roomId;
    do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(roomId));
    return roomId;
}

wss.on('connection', (ws) => {
    console.log('New connection established');

    ws.on('message', (messageText) => {
        try {
            const data = JSON.parse(messageText.toString());
console.log('Received message:', data.type, data.roomId ? `Room: ${data.roomId}` : '(relay)');
            switch (data.type) {
                case 'create-room': {
                    const roomId = generateRoomId();
                    rooms.set(roomId, { hostSocket: ws, guestSocket: null });
                    clientState.set(ws, { roomId, role: 'host' });
                    
                    ws.send(JSON.stringify({
                        type: 'room-created',
                        roomId
                    }));
                    console.log(`Room ${roomId} created by host`);
                    break;
                }

                case 'join-room': {
                    const roomId = data.roomId;
                    const room = rooms.get(roomId);

                    if (!room) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Room ${roomId} not found`
                        }));
                        return;
                    }

                    if (room.guestSocket) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Room ${roomId} is already full`
                        }));
                        return;
                    }

                    room.guestSocket = ws;
                    clientState.set(ws, { roomId, role: 'guest' });

                    ws.send(JSON.stringify({
                        type: 'room-joined',
                        roomId
                    }));

                    room.hostSocket.send(JSON.stringify({
                        type: 'guest-joined'
                    }));

                    console.log(`Guest joined room ${roomId}`);
                    break;
                }

                case 'relay': {
                    const state = clientState.get(ws);
                    if (!state) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Not in a room'
                        }));
                        return;
                    }

                    const room = rooms.get(state.roomId);
                    if (!room) return;

                    const recipient = state.role === 'host' ? room.guestSocket : room.hostSocket;
                    if (recipient && recipient.readyState === ws.OPEN) {
                        recipient.send(JSON.stringify({
                            type: 'relay',
                            payload: data.payload
                        }));
                    }
                    break;
                }

                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });

    ws.on('close', () => {
        console.log('Connection closed');
        const state = clientState.get(ws);
        if (state) {
            const { roomId, role } = state;
            const room = rooms.get(roomId);
            if (room) {
                if (role === 'host') {
                    console.log(`Host disconnected from room ${roomId}. Closing room.`);
                    if (room.guestSocket && room.guestSocket.readyState === ws.OPEN) {
                        room.guestSocket.send(JSON.stringify({
                            type: 'host-disconnected'
                        }));
                        clientState.delete(room.guestSocket);
                    }
                    rooms.delete(roomId);
                } else if (role === 'guest') {
                    console.log(`Guest disconnected from room ${roomId}.`);
                    room.guestSocket = null;
                    if (room.hostSocket && room.hostSocket.readyState === ws.OPEN) {
                        room.hostSocket.send(JSON.stringify({
                            type: 'guest-disconnected'
                        }));
                    }
                }
            }
            clientState.delete(ws);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
