# 🔒 CloudflareSecureChat

Ultra-low-latency, highly secure 1-on-1 text, audio, and video communication system built entirely on Cloudflare's edge infrastructure.

---

## Architecture Overview

```
┌─────────────────┐          WSS           ┌──────────────────────────┐
│   Frontend       │◄─────────────────────► │   Cloudflare Worker      │
│   (React/TS)     │   Signaling + Chat     │   (Edge Router)          │
│   Cloudflare     │                        │                          │
│   Pages          │                        │   ┌────────────────────┐ │
│                  │                        │   │  Durable Object    │ │
│  ┌────────────┐  │   WebRTC (DTLS/SRTP)   │   │  (ChatRoom)        │ │
│  │ WebRTC     │◄─┼───────────────────────►│   │  - 2 WebSockets    │ │
│  │ PeerConn   │  │   Audio/Video/Data     │   │  - SDP Relay       │ │
│  └────────────┘  │                        │   │  - ICE Relay       │ │
│                  │                        │   │  - Text Chat       │ │
└─────────────────┘                        │   └────────────────────┘ │
                                           └──────────────────────────┘
```

### Key Design Decisions

| Concern | Solution |
|---------|----------|
| **Signaling** | Cloudflare Worker + Durable Object per room via WebSocket |
| **Media Transport** | WebRTC peer-to-peer (DTLS + SRTP with AES_CM) |
| **Text Chat** | Same WebSocket as signaling — zero additional latency |
| **Room Limit** | Strict 2-person enforcement at Durable Object level |
| **Codec (Audio)** | Opus — 48kHz, in-band FEC, packet-loss concealment |
| **Codec (Video)** | VP8/H.264 at ~4 Mbps, no simulcast (1:1 optimization) |
| **Latency** | Cloudflare Anycast → nearest edge PoP, <50ms signaling |

---

## Project Structure

```
CloudflareSecureChat/
├── worker/                          # Cloudflare Worker backend
│   ├── wrangler.toml                # Worker + DO configuration
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # Worker entry — HTTP router
│       ├── ChatRoom.ts              # Durable Object — room logic
│       └── types.ts                 # Shared type definitions
│
├── frontend/                        # React/TypeScript frontend
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx                 # App entry point
│       ├── App.tsx                  # Main orchestrator component
│       ├── styles.css               # Global styles
│       ├── vite-env.d.ts
│       ├── hooks/
│       │   ├── useSignaling.ts      # WebSocket signaling hook
│       │   └── useWebRTC.ts         # WebRTC peer connection hook
│       └── components/
│           ├── VideoPanel.tsx        # Video display + controls
│           └── TextChat.tsx          # Real-time text chat
│
└── README.md
```

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account (for deployment)

### 1. Install Dependencies

```bash
# Worker
cd worker
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Run Locally (Development)

**Terminal 1 — Start the Worker:**
```bash
cd worker
npm run dev
# Starts at https://localhost:8787
```

**Terminal 2 — Start the Frontend:**
```bash
cd frontend
npm run dev
# Starts at http://localhost:3000
# API/WS requests proxy to the Worker automatically
```

### 3. Open the App

1. Open `http://localhost:3000` in your browser
2. Click **"Create New Room"** → copies room ID
3. Open another browser tab → paste the room ID → **"Join"**
4. Camera/mic permissions will be requested
5. Video call + text chat begins instantly

---

## API Reference

### Worker Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/room` | Create a new room → `{ roomId, wsUrl }` |
| `GET` | `/api/room/:roomId` | Get room status (peer count) |
| `GET` | `/ws/room/:roomId` | WebSocket upgrade → join room |

### WebSocket Protocol

All messages are JSON over WSS with the envelope:

```typescript
{
  type: string;        // Message type
  payload?: any;       // Type-specific data
  timestamp: number;   // Unix ms
  sender?: string;     // Peer ID of sender
}
```

**Message Types:**

| Type | Direction | Purpose |
|------|-----------|---------|
| `join` | Client → Server | Register in room with peerId |
| `peer-joined` | Server → Client | Another peer entered |
| `peer-left` | Server → Client | Peer disconnected |
| `sdp-offer` | Client ↔ Server | WebRTC SDP offer relay |
| `sdp-answer` | Client ↔ Server | WebRTC SDP answer relay |
| `ice-candidate` | Client ↔ Server | ICE candidate relay |
| `chat` | Client ↔ Server | Text message relay |
| `room-full` | Server → Client | Room at capacity (max 2) |
| `error` | Server → Client | Error notification |
| `ping` / `pong` | Client ↔ Server | Keep-alive heartbeat |

---

## Security Architecture

### Transport Security

```
┌──────────┐                    ┌──────────────┐                    ┌──────────┐
│  Client A │───── WSS/TLS ────►│  CF Worker   │◄──── WSS/TLS ─────│  Client B │
│           │                    │  (Signaling) │                    │           │
│           │                    └──────────────┘                    │           │
│           │                                                       │           │
│           │◄══════════ WebRTC (DTLS + SRTP/AES_CM) ══════════════►│           │
│           │                   Audio / Video                       │           │
└──────────┘                                                       └──────────┘
```

| Layer | Protection |
|-------|-----------|
| **Signaling** | WSS (TLS 1.3) — Cloudflare edge terminates TLS |
| **Text Chat** | Same WSS channel — encrypted in transit |
| **Key Exchange** | DTLS handshake (RFC 5764) — per-session keys |
| **Media Encryption** | SRTP with AES_128_CM_HMAC_SHA1_80 |
| **Room Isolation** | Each Durable Object is a single-tenant instance |
| **Capacity Limit** | Hard-coded 2-peer maximum at DO level |

### What This Means

- **No plaintext media** ever traverses the network
- **No server-side decryption** — the Worker only relays encrypted signaling
- **Forward secrecy** — DTLS generates fresh keys per session
- **Ephemeral rooms** — no data persistence, rooms exist only in memory

---

## Deployment

### Deploy Worker

```bash
cd worker
wrangler login          # One-time auth
wrangler deploy         # Deploys to Cloudflare edge globally
```

### Deploy Frontend (Cloudflare Pages)

```bash
cd frontend
npm run build

# Option A: Wrangler Pages
wrangler pages deploy dist --project-name=cloudflare-secure-chat

# Option B: Connect Git repo to Cloudflare Pages dashboard
#   Build command: npm run build
#   Output directory: dist
```

### Production Configuration

1. **Lock down CORS** in `worker/src/index.ts`:
   ```typescript
   'Access-Control-Allow-Origin': 'https://your-domain.pages.dev'
   ```

2. **Add TURN servers** in `frontend/src/hooks/useWebRTC.ts` for NAT traversal:
   ```typescript
   { urls: 'turn:turn.your-domain.com:3478', username: '...', credential: '...' }
   ```

3. **Set environment variables** per environment in `wrangler.toml`.

---

## Cloudflare Realtime (RealtimeKit) Integration

> **Note:** Cloudflare Realtime (RealtimeKit SDK + SFU) is currently in beta.
> The current implementation uses standard WebRTC peer-to-peer which is optimal
> for 1-on-1 calls. When Cloudflare Realtime becomes generally available, the
> `useWebRTC` hook can be swapped to use the RealtimeKit SDK for SFU-backed
> media routing with Anycast optimization.

### Migration Path to RealtimeKit

1. Replace `RTCPeerConnection` in `useWebRTC.ts` with RealtimeKit client
2. Use RealtimeKit's session tokens (generated by the Worker) for auth
3. Media will route through Cloudflare's SFU with Anycast → shortest path
4. Signaling/text chat remains on the Durable Object WebSocket (unchanged)

---

## WebRTC Quality Configuration

The system is configured for maximum 1-on-1 quality:

### Audio (Opus)
- **Sample rate:** 48,000 Hz
- **Max bitrate:** 510 kbps
- **In-band FEC:** Enabled (packet-loss concealment)
- **DTX:** Disabled (continuous transmission for lowest latency)
- **Echo cancellation:** Enabled
- **Noise suppression:** Enabled

### Video (VP8/H.264)
- **Resolution:** Up to 1920×1080 (ideal), minimum 1280×720
- **Frame rate:** 30 fps (ideal), minimum 24 fps
- **Bitrate:** ~4 Mbps (no simulcast — full quality single stream)
- **Bundle policy:** `max-bundle` (single transport for all media)
- **RTCP mux:** Required (reduced port usage)

---

## Development

```bash
# Type check worker
cd worker && npm run typecheck

# Type check frontend
cd frontend && npm run typecheck

# View worker logs in production
cd worker && npm run tail
```

---

## License

MIT
