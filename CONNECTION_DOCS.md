# Live Drawing Overlay - Peer Connection Documentation

## Overview

This document explains how two laptops connect and share drawing/video in real-time using WebRTC and WebSocket signaling.

---

## Architecture

```
Laptop A (Host)                          Laptop B (Peer)
┌─────────────────┐                       ┌─────────────────┐
│  Browser        │                       │  Browser        │
│  ├─ WebRTC      │◄──────P2P──────►────│  ├─ WebRTC      │
│  ├─ Canvas      │    (Video + Data)     │  ├─ Canvas      │
│  └─ WebSocket   │                       │  └─ WebSocket   │
│       Client    │                       │       Client    │
└────────┬────────┘                       └────────┬────────┘
         │                                          │
         └──────────────┬───────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │  Node.js Server     │
              │  ├─ HTTP (port 3000)│
              │  └─ WebSocket       │
              │     (port 3000)     │
              └─────────────────────┘
                     (Laptop A)
```

---

## Connection Flow

### 1. Initial Setup

**Host (Laptop A):**
1. Runs Node.js server on WSL
2. Windows forwards port 3000 to WSL via `netsh portproxy`
3. Windows firewall allows port 3000 inbound

**Peer (Laptop B):**
1. Opens browser to `http://<Host-IP>:3000`
2. Chrome flag enabled: `unsafely-treat-insecure-origin-as-secure` (for camera access on HTTP)

### 2. Signaling Phase (WebSocket)

```
Laptop A                  Server                  Laptop B
   │    "join room: ABC"    │                         │
   │───────────────────────►│                         │
   │                        │  "peer joined: B"       │
   │◄──────────────────────│◄────────────────────────│
   │    "offer (SDP)"       │                         │
   │───────────────────────►│    "forward offer"      │
   │                        │────────────────────────►│
   │                        │    "answer (SDP)"       │
   │◄──────────────────────│◄────────────────────────│
   │    "ICE candidate"     │                         │
   │───────────────────────►│    "forward ICE"        │
   │                        │────────────────────────►│
```

### 3. WebRTC Handshake

**Initiator Selection:**
- Peer with **lower peerId** initiates the connection
- Prevents both peers from sending offers simultaneously

**State Machine:**
```
Peer A (Initiator)              Peer B (Receiver)
     │                                 │
     │── create offer ──►              │
     │   setLocalDescription(offer)   │
     │   send offer via WS             │
     │──────────────────────────────►  │
     │                                 │── setRemoteDescription(offer)
     │                                 │── create answer
     │                                 │── setLocalDescription(answer)
     │                                 │── send answer via WS
     │◄──────────────────────────────│
     │── setRemoteDescription(answer)  │
     │                                 │
     │── ICE candidate exchange ───►  │
     │◄───────────────────────────────│
     │                                 │
     │◄────── P2P connected ────────►  │
```

### 4. NAT Traversal (ICE)

**ICE Candidate Types:**

| Type | Description | Example |
|------|-------------|---------|
| **host** | Direct local IP | `192.168.1.5:54321` |
| **srflx** | Public IP via STUN | `203.0.113.45:54321` |
| **relay** | TURN server relay | `turn.openrelay.metered.ca:80` |

**STUN/TURN Servers Used:**
```javascript
iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
]
```

### 5. Data Transfer

**Drawing Sync (DataChannel):**
```json
{
    "type": "stroke",
    "fromX": 120,
    "fromY": 300,
    "toX": 125,
    "toY": 305,
    "color": "#00ff88",
    "size": 5,
    "isEraser": false,
    "eraserSize": 20
}
```

**Video Stream (MediaStreamTrack):**
- Local webcam stream added via `pc.addTrack()`
- Remote peer receives via `pc.ontrack` event
- Displayed in `<video>` element with `srcObject = remoteStream`

---

## Security Considerations

### Current Setup (Local Network)

| Aspect | Status | Risk Level |
|--------|--------|------------|
| Connection | HTTP (unencrypted) | Medium |
| IP Exposure | Local IP shared | Low (same WiFi only) |
| Camera Access | Chrome flag bypass | Medium |
| Firewall | Port 3000 opened | Medium |
| Authentication | None | High |

### Production Recommendations

1. **HTTPS**: Use self-signed cert or reverse proxy (nginx/Caddy)
2. **Authentication**: Room passwords or JWT tokens
3. **TURN Server**: Private TURN server instead of public free ones
4. **No IP Sharing**: Use tunneling (ngrok/Cloudflare) or VPN mesh (Tailscale)

---

## Technologies Used

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla HTML/CSS/JS | UI and drawing canvas |
| Backend | Node.js + `ws` library | HTTP server + WebSocket signaling |
| Real-time | WebRTC | P2P video and data channels |
| Hand Tracking | MediaPipe Hands | Gesture-based drawing control |
| NAT Traversal | STUN/TURN | P2P connection across NATs |

---

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js HTTP + WebSocket server |
| `multiplayer.js` | WebRTC peer connection, signaling, video handling |
| `script.js` | Drawing logic, canvas management, hand tracking |
| `index.html` | UI structure |
| `style.css` | Styling and layout |

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "Site cannot be reached" | Windows firewall or wrong IP | Check `ipconfig`, verify port proxy, add firewall rule |
| Camera not accessible | Chrome blocks HTTP camera | Enable `unsafely-treat-insecure-origin-as-secure` flag |
| Drawing not syncing | Data channel not open | Check console for "Data channel opened" message |
| Video not showing | ICE connection failed | Check STUN/TURN server connectivity |
| Black eraser marks | Wrong composite operation | Verify `destination-out` is set correctly |

---

## Limitations

1. **Same network required** for local IP approach
2. **No encryption** on HTTP connections
3. **Manual setup** needed (Chrome flags, firewall rules)
4. **No persistence** — drawings lost on refresh
5. **Single room** per server instance (no room isolation)

---

*Document Version: 1.0*
*Last Updated: 2026-06-25*
