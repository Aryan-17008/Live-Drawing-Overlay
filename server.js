const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Create HTTP server to serve static files
const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';
    
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.woff': 'application/font-woff',
        '.ttf': 'application/font-ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'application/font-otf',
        '.wasm': 'application/wasm'
    };
    
    const contentType = mimeTypes[extname] || 'application/octet-stream';
    
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store rooms and their peers
const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;
    let peerId = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'join':
                    // Join or create a room
                    currentRoom = data.room;
                    peerId = data.peerId || Math.random().toString(36).substr(2, 9);
                    
                    if (!rooms.has(currentRoom)) {
                        rooms.set(currentRoom, new Map());
                    }
                    
                    const room = rooms.get(currentRoom);
                    room.set(peerId, ws);
                    
                    // Notify peer of their ID
                    ws.send(JSON.stringify({
                        type: 'joined',
                        peerId: peerId,
                        room: currentRoom,
                        peers: Array.from(room.keys()).filter(id => id !== peerId)
                    }));
                    
                    // Notify other peers
                    room.forEach((peer, id) => {
                        if (id !== peerId) {
                            peer.send(JSON.stringify({
                                type: 'peer-joined',
                                peerId: peerId
                            }));
                        }
                    });
                    break;
                    
                case 'offer':
                    // Forward offer to target peer
                    if (currentRoom && rooms.has(currentRoom)) {
                        const targetPeer = rooms.get(currentRoom).get(data.target);
                        if (targetPeer) {
                            targetPeer.send(JSON.stringify({
                                type: 'offer',
                                peerId: peerId,
                                offer: data.offer
                            }));
                        }
                    }
                    break;
                    
                case 'answer':
                    // Forward answer to target peer
                    if (currentRoom && rooms.has(currentRoom)) {
                        const targetPeer = rooms.get(currentRoom).get(data.target);
                        if (targetPeer) {
                            targetPeer.send(JSON.stringify({
                                type: 'answer',
                                peerId: peerId,
                                answer: data.answer
                            }));
                        }
                    }
                    break;
                    
                case 'ice-candidate':
                    // Forward ICE candidate to target peer
                    if (currentRoom && rooms.has(currentRoom)) {
                        const targetPeer = rooms.get(currentRoom).get(data.target);
                        if (targetPeer) {
                            targetPeer.send(JSON.stringify({
                                type: 'ice-candidate',
                                peerId: peerId,
                                candidate: data.candidate
                            }));
                        }
                    }
                    break;
                    
                case 'drawing-data':
                    // Forward drawing data to all other peers in room
                    if (currentRoom && rooms.has(currentRoom)) {
                        rooms.get(currentRoom).forEach((peer, id) => {
                            if (id !== peerId && peer.readyState === WebSocket.OPEN) {
                                peer.send(JSON.stringify({
                                    type: 'drawing-data',
                                    peerId: peerId,
                                    data: data.data
                                }));
                            }
                        });
                    }
                    break;
                    
                case 'leave':
                    // Leave room
                    if (currentRoom && rooms.has(currentRoom)) {
                        const room = rooms.get(currentRoom);
                        room.delete(peerId);
                        
                        // Notify other peers
                        room.forEach((peer) => {
                            peer.send(JSON.stringify({
                                type: 'peer-left',
                                peerId: peerId
                            }));
                        });
                        
                        // Clean up empty rooms
                        if (room.size === 0) {
                            rooms.delete(currentRoom);
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });
    
    ws.on('close', () => {
        // Handle disconnect
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            room.delete(peerId);
            
            room.forEach((peer) => {
                peer.send(JSON.stringify({
                    type: 'peer-left',
                    peerId: peerId
                }));
            });
            
            if (room.size === 0) {
                rooms.delete(currentRoom);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
