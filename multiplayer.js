// Multiplayer module with video streaming
(function() {
    'use strict';

    // DOM Elements
    const multiplayerPanel = document.getElementById('multiplayer-panel');
    const multiplayerBtn = document.getElementById('multiplayer-btn');
    const closeMultiplayerBtn = document.getElementById('close-multiplayer');
    const roomIdInput = document.getElementById('room-id');
    const createRoomBtn = document.getElementById('create-room-btn');
    const joinRoomBtn = document.getElementById('join-room-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');
    const roomJoinSection = document.getElementById('room-join-section');
    const roomInfoSection = document.getElementById('room-info-section');
    const currentRoomIdSpan = document.getElementById('current-room-id');
    const peerCountSpan = document.getElementById('peer-count');
    const peerListDiv = document.getElementById('peer-list');
    const remoteVideosContainer = document.getElementById('remote-videos');

    // State
    let ws = null;
    let peerId = null;
    let currentRoom = null;
    let peers = new Map(); // peerId -> RTCPeerConnection
    let dataChannels = new Map(); // peerId -> RTCDataChannel
    let localStream = null; // Local video stream
    let remoteStreams = new Map(); // peerId -> MediaStream

    // WebSocket URL - use current host
    const WS_URL = 'ws://' + window.location.host;

    // ============================================================
    // UI Functions
    // ============================================================
    function toggleMultiplayerPanel() {
        multiplayerPanel.classList.toggle('hidden');
    }

    function showRoomInfo(room) {
        currentRoom = room;
        roomJoinSection.classList.add('hidden');
        roomInfoSection.classList.remove('hidden');
        currentRoomIdSpan.textContent = room;
    }

    function showRoomJoin() {
        currentRoom = null;
        roomJoinSection.classList.remove('hidden');
        roomInfoSection.classList.add('hidden');
        peerListDiv.innerHTML = '';
        peerCountSpan.textContent = '0';
        // Remove all remote videos
        remoteVideosContainer.innerHTML = '';
        remoteStreams.clear();
    }

    function updatePeerList(peerIds) {
        peerListDiv.innerHTML = '';
        peerCountSpan.textContent = peerIds.length;
        
        peerIds.forEach(id => {
            const item = document.createElement('div');
            item.className = 'peer-item';
            item.innerHTML = `<div class="peer-indicator"></div><span>Peer ${id.substr(0, 6)}</span>`;
            peerListDiv.appendChild(item);
        });
    }

    function addRemoteVideo(peerId, stream) {
        // Remove existing video for this peer if any
        const existing = document.getElementById('remote-video-' + peerId);
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'remote-video-container';
        container.id = 'remote-video-' + peerId;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;

        const label = document.createElement('div');
        label.className = 'remote-video-label';
        label.textContent = 'Peer ' + peerId.substr(0, 6);

        container.appendChild(video);
        container.appendChild(label);
        remoteVideosContainer.appendChild(container);

        remoteStreams.set(peerId, stream);
    }

    function removeRemoteVideo(peerId) {
        const existing = document.getElementById('remote-video-' + peerId);
        if (existing) existing.remove();
        remoteStreams.delete(peerId);
    }

    // ============================================================
    // Local Video Stream
    // ============================================================
    async function getLocalStream() {
        if (localStream) return localStream;
        
        try {
            // Try to get the existing video element's stream if available
            const video = document.getElementById('webcam');
            if (video && video.srcObject) {
                localStream = video.srcObject;
                return localStream;
            }
            
            // Otherwise request camera access
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: false
            });
            return localStream;
        } catch (err) {
            console.error('Failed to get local stream:', err);
            return null;
        }
    }

    // ============================================================
    // WebSocket Connection
    // ============================================================
    function connectWebSocket() {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('WebSocket connected');
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleSignalingMessage(data);
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    // Track which peers we've already initiated connections to
    let initiatedPeers = new Set();

    function handleSignalingMessage(data) {
        switch (data.type) {
            case 'joined':
                peerId = data.peerId;
                showRoomInfo(data.room);
                updatePeerList(data.peers);
                
                // Clear initiated peers when joining a new room
                initiatedPeers.clear();
                
                // Connect to existing peers - create connection for all, initiate only to higher IDs
                data.peers.forEach(peer => {
                    if (!peers.has(peer)) {
                        if (peerId && peer > peerId) {
                            console.log('Initiating connection to existing peer:', peer);
                            initiatedPeers.add(peer);
                            createPeerConnection(peer, true);
                        } else {
                            console.log('Creating connection for existing peer (waiting):', peer);
                            createPeerConnection(peer, false);
                        }
                    }
                });
                break;

            case 'peer-joined':
                updatePeerList([...Array.from(peers.keys()), data.peerId]);
                
                // Create connection object for the new peer if we don't have one
                if (!peers.has(data.peerId)) {
                    if (peerId && data.peerId > peerId) {
                        // We are the initiator
                        console.log('Initiating connection to new peer:', data.peerId);
                        initiatedPeers.add(data.peerId);
                        createPeerConnection(data.peerId, true);
                    } else {
                        // We wait for the initiator - but still create the connection object
                        console.log('Waiting for peer to initiate, creating connection:', data.peerId);
                        createPeerConnection(data.peerId, false);
                    }
                }
                break;

            case 'peer-left':
                // Clean up peer connection
                const pc = peers.get(data.peerId);
                if (pc) {
                    pc.close();
                }
                peers.delete(data.peerId);
                dataChannels.delete(data.peerId);
                initiatedPeers.delete(data.peerId);
                removeRemoteVideo(data.peerId);
                updatePeerList(Array.from(peers.keys()));
                break;

            case 'offer':
                handleOffer(data.peerId, data.offer);
                break;

            case 'answer':
                handleAnswer(data.peerId, data.answer);
                break;

            case 'ice-candidate':
                handleIceCandidate(data.peerId, data.candidate);
                break;

            case 'drawing-data':
                // Handle drawing data from peer (WebSocket fallback)
                console.log('Received drawing data via WebSocket:', data.data);
                handleRemoteDrawing(data.data);
                break;
        }
    }

    // ============================================================
    // WebRTC Peer Connection with Video
    // ============================================================
    async function createPeerConnection(targetPeerId, isInitiator) {
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                {
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:openrelay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        });

        peers.set(targetPeerId, pc);

        // Add local video stream tracks to peer connection
        const stream = await getLocalStream();
        if (stream) {
            stream.getTracks().forEach(track => {
                pc.addTrack(track, stream);
                console.log('Added local track to peer:', targetPeerId, track.kind);
            });
        }

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log('Received remote track from peer:', targetPeerId, event.track.kind, 'streams:', event.streams.length);
            const remoteStream = event.streams[0];
            if (remoteStream) {
                console.log('Remote stream tracks:', remoteStream.getTracks().map(t => t.kind));
                addRemoteVideo(targetPeerId, remoteStream);
            } else {
                console.log('No remote stream in track event');
            }
        };

        // Create data channel if initiator
        if (isInitiator) {
            const dc = pc.createDataChannel('drawing', {
                ordered: true
            });
            setupDataChannel(targetPeerId, dc);
        } else {
            // Handle incoming data channel
            pc.ondatachannel = (event) => {
                setupDataChannel(targetPeerId, event.channel);
            };
        }

        // ICE candidate handling
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    target: targetPeerId,
                    candidate: event.candidate
                }));
            }
        };

        // Connection state monitoring
        pc.onconnectionstatechange = () => {
            console.log('Peer connection state with', targetPeerId, ':', pc.connectionState);
            if (pc.connectionState === 'connected') {
                console.log('Fully connected to peer:', targetPeerId);
            }
            if (pc.connectionState === 'failed') {
                console.log('Connection failed with peer:', targetPeerId);
                // Restart ICE on failure
                pc.restartIce();
            }
        };

        // ICE gathering state
        pc.onicegatheringstatechange = () => {
            console.log('ICE gathering state with', targetPeerId, ':', pc.iceGatheringState);
        };

        // ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state with', targetPeerId, ':', pc.iceConnectionState);
        };

        // Create offer if initiator
        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({
                type: 'offer',
                target: targetPeerId,
                offer: offer
            }));
        }

        return pc;
    }

    async function handleOffer(fromPeerId, offer) {
        // Check if we already have a connection for this peer
        let pc = peers.get(fromPeerId);
        
        if (!pc) {
            // Create new peer connection as non-initiator
            pc = await createPeerConnection(fromPeerId, false);
        }
        
        // Ignore duplicate offers
        if (pc._lastOffer && pc._lastOffer === offer.sdp) {
            console.log('Ignoring duplicate offer from peer:', fromPeerId);
            return;
        }
        pc._lastOffer = offer.sdp;
        
        // Only set remote description if we're in the right state
        if (pc.signalingState === 'stable') {
            await pc.setRemoteDescription(offer);
            // Flush any buffered ICE candidates
            await flushIceCandidates(fromPeerId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            ws.send(JSON.stringify({
                type: 'answer',
                target: fromPeerId,
                answer: answer
            }));
        } else if (pc.signalingState === 'have-local-offer') {
            // Both sides initiated at the same time - use rollback
            console.log('Both initiated, rolling back and accepting offer from:', fromPeerId);
            await pc.setLocalDescription({type: 'rollback'});
            await pc.setRemoteDescription(offer);
            await flushIceCandidates(fromPeerId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            ws.send(JSON.stringify({
                type: 'answer',
                target: fromPeerId,
                answer: answer
            }));
        } else {
            console.log('Ignoring offer, peer connection in state:', pc.signalingState);
        }
    }

    async function handleAnswer(fromPeerId, answer) {
        const pc = peers.get(fromPeerId);
        if (pc) {
            // Only set remote description if we have a local offer pending
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(answer);
                // Flush any buffered ICE candidates
                await flushIceCandidates(fromPeerId);
            } else {
                console.log('Ignoring answer, peer connection in state:', pc.signalingState);
            }
        }
    }

    async function handleIceCandidate(fromPeerId, candidate) {
        const pc = peers.get(fromPeerId);
        if (pc) {
            // Only add ICE candidate if remote description is set
            if (pc.remoteDescription && pc.remoteDescription.type) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.log('Error adding ICE candidate:', err.message);
                }
            } else {
                console.log('Buffering ICE candidate for peer:', fromPeerId);
                // Buffer the candidate until remote description is set
                if (!pc._iceCandidateBuffer) {
                    pc._iceCandidateBuffer = [];
                }
                pc._iceCandidateBuffer.push(candidate);
            }
        }
    }

    // Flush buffered ICE candidates after remote description is set
    async function flushIceCandidates(peerId) {
        const pc = peers.get(peerId);
        if (pc && pc._iceCandidateBuffer) {
            console.log('Flushing', pc._iceCandidateBuffer.length, 'ICE candidates for peer:', peerId);
            for (const candidate of pc._iceCandidateBuffer) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (err) {
                    console.log('Error adding buffered ICE candidate:', err.message);
                }
            }
            pc._iceCandidateBuffer = [];
        }
    }

    // ============================================================
    // Data Channel
    // ============================================================
    function setupDataChannel(peerId, dc) {
        dataChannels.set(peerId, dc);

        dc.onopen = () => {
            console.log('Data channel opened with peer:', peerId);
            console.log('Total open data channels:', dataChannels.size);
        };

        dc.onmessage = (event) => {
            console.log('Received data channel message from peer:', peerId);
            const data = JSON.parse(event.data);
            handleRemoteDrawing(data);
        };

        dc.onclose = () => {
            console.log('Data channel closed with peer:', peerId);
            dataChannels.delete(peerId);
        };

        dc.onerror = (err) => {
            console.error('Data channel error with peer:', peerId, err);
        };
    }

    // ============================================================
    // Drawing Sync
    // ============================================================
    function handleRemoteDrawing(data) {
        console.log('Received drawing data:', data);
        // Draw remote stroke on canvas
        if (data.type === 'stroke') {
            console.log('Drawing remote stroke from', data.fromX, data.fromY, 'to', data.toX, data.toY);
            drawRemoteStroke(data);
        } else if (data.type === 'stroke-end') {
            // Handle stroke end if needed
        }
    }

    function drawRemoteStroke(data) {
        // Get canvas context from window (set by script.js)
        const canvasCtx = window.drawingCtx;
        if (!canvasCtx) {
            console.error('Canvas context not available - window.drawingCtx is undefined');
            return;
        }
        console.log('Using canvas context:', canvasCtx.canvas ? canvasCtx.canvas.id : 'unknown');
        
        // Use the same drawing logic but with remote data
        canvasCtx.beginPath();
        canvasCtx.moveTo(data.fromX, data.fromY);
        canvasCtx.lineTo(data.toX, data.toY);

        if (data.isEraser) {
            canvasCtx.globalCompositeOperation = 'destination-out';
            canvasCtx.lineWidth = data.eraserSize || 20;
        } else {
            canvasCtx.globalCompositeOperation = 'source-over';
            canvasCtx.strokeStyle = data.color;
            canvasCtx.lineWidth = data.size;
        }

        canvasCtx.lineCap = 'round';
        canvasCtx.lineJoin = 'round';
        canvasCtx.stroke();
    }

    // Function to broadcast drawing data
    function broadcastDrawing(data) {
        console.log('Broadcasting drawing data:', data, 'to', dataChannels.size, 'peers');
        dataChannels.forEach((dc, peerId) => {
            if (dc.readyState === 'open') {
                dc.send(JSON.stringify(data));
                console.log('Sent to peer:', peerId);
            } else {
                console.log('Data channel not open for peer:', peerId, 'state:', dc.readyState);
            }
        });

        // Also send via WebSocket as fallback
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('Sending drawing data via WebSocket fallback');
            ws.send(JSON.stringify({
                type: 'drawing-data',
                data: data
            }));
        } else {
            console.log('WebSocket not available for fallback, ws:', ws ? ws.readyState : 'null');
        }
    }

    // ============================================================
    // Event Listeners
    // ============================================================
    multiplayerBtn.addEventListener('click', toggleMultiplayerPanel);
    closeMultiplayerBtn.addEventListener('click', toggleMultiplayerPanel);

    createRoomBtn.addEventListener('click', () => {
        const room = Math.random().toString(36).substr(2, 9).toUpperCase();
        roomIdInput.value = room;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'join',
                    room: room
                }));
            }, 500);
        } else {
            ws.send(JSON.stringify({
                type: 'join',
                room: room
            }));
        }
    });

    joinRoomBtn.addEventListener('click', () => {
        const room = roomIdInput.value.trim();
        if (!room) {
            alert('Please enter a room ID');
            return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: 'join',
                    room: room
                }));
            }, 500);
        } else {
            ws.send(JSON.stringify({
                type: 'join',
                room: room
            }));
        }
    });

    leaveRoomBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'leave' }));
        }
        
        // Close all peer connections
        peers.forEach(pc => pc.close());
        peers.clear();
        dataChannels.clear();
        initiatedPeers.clear();
        
        showRoomJoin();
    });

    // ============================================================
    // Expose broadcast function to main script
    // ============================================================
    window.multiplayer = {
        broadcast: broadcastDrawing,
        isConnected: () => {
            // Check if any data channel is actually open
            for (const [peerId, dc] of dataChannels) {
                if (dc.readyState === 'open') {
                    return true;
                }
            }
            return false;
        }
    };

})();