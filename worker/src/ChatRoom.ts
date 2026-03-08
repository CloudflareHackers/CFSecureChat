// ============================================================================
// ChatRoom — Durable Object
// ============================================================================
// Each instance represents a single 1-on-1 room. It:
//  • Accepts exactly 2 WebSocket connections (strict 2-person limit).
//  • Relays SDP offers/answers and ICE candidates for WebRTC negotiation.
//  • Routes real-time text chat messages between peers.
//  • Maintains room state and handles graceful disconnect/reconnect.
// ============================================================================

import type {
  Env,
  WSMessage,
  JoinPayload,
  SDPPayload,
  ICECandidatePayload,
  ChatPayload,
  PeerInfo,
} from './types';

/** Connected peer metadata */
interface ConnectedPeer {
  webSocket: WebSocket;
  peerId: string;
  displayName: string;
  joinedAt: number;
}

export class ChatRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private peers: Map<WebSocket, ConnectedPeer> = new Map();
  private maxRoomSize = 2;
  private accessCode: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.maxRoomSize = parseInt(env.MAX_ROOM_SIZE || '2', 10);

    // Restore settings from storage
    this.state.blockConcurrencyWhile(async () => {
      this.accessCode = (await this.state.storage.get<string>('accessCode')) || null;
      const storedMax = await this.state.storage.get<number>('maxRoomSize');
      if (storedMax) this.maxRoomSize = storedMax;
    });

    // Restore any hibernated WebSocket connections
    this.state.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment() as ConnectedPeer | null;
      if (meta) {
        this.peers.set(ws, meta);
      }
    });
  }

  // -------------------------------------------------------------------------
  // HTTP handler — upgrades to WebSocket
  // -------------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          peers: this.peers.size,
          maxPeers: this.maxRoomSize,
          hasAccessCode: !!this.accessCode,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Set access code (internal, called by Worker on room creation)
    if (url.pathname === '/set-access-code' && request.method === 'POST') {
      const body = (await request.json()) as { accessCode: string; maxPeers?: number };
      this.accessCode = body.accessCode;
      await this.state.storage.put('accessCode', body.accessCode);
      if (body.maxPeers && body.maxPeers >= 2 && body.maxPeers <= 10) {
        this.maxRoomSize = body.maxPeers;
        await this.state.storage.put('maxRoomSize', body.maxPeers);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only accept WebSocket upgrades
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Enforce room capacity BEFORE accepting the connection
    if (this.peers.size >= this.maxRoomSize) {
      // Create a WebSocket pair just to send the rejection, then close
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      server.send(
        JSON.stringify(this.createMessage('room-full', { reason: 'Room is full (max 2 peers).' }))
      );
      server.close(4001, 'Room is full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Accept the WebSocket connection via Hibernation API
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket event handlers (Hibernation API)
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    try {
      const data = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
      const message: WSMessage = JSON.parse(data);

      switch (message.type) {
        case 'join':
          this.handleJoin(ws, message);
          break;

        case 'sdp-offer':
        case 'sdp-answer':
          this.handleSDP(ws, message);
          break;

        case 'ice-candidate':
          this.handleICECandidate(ws, message);
          break;

        case 'chat':
          this.handleChat(ws, message);
          break;

        case 'leave':
          this.handleLeave(ws);
          break;

        case 'ping':
          ws.send(JSON.stringify(this.createMessage('pong', null)));
          break;

        default:
          ws.send(
            JSON.stringify(
              this.createMessage('error', { reason: `Unknown message type: ${message.type}` })
            )
          );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Invalid message format';
      ws.send(JSON.stringify(this.createMessage('error', { reason: errorMsg })));
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    this.handleLeave(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    this.handleLeave(ws);
  }

  // -------------------------------------------------------------------------
  // Message Handlers
  // -------------------------------------------------------------------------

  private handleJoin(ws: WebSocket, message: WSMessage): void {
    const payload = message.payload as JoinPayload;

    if (!payload?.peerId) {
      ws.send(
        JSON.stringify(this.createMessage('error', { reason: 'Missing peerId in join payload' }))
      );
      return;
    }

    // Validate access code if one is set for this room
    if (this.accessCode && payload.accessCode !== this.accessCode) {
      ws.send(
        JSON.stringify(this.createMessage('error', { reason: 'Invalid access code. You need the correct 6-digit code to join this room.' }))
      );
      try {
        ws.close(4003, 'Invalid access code');
      } catch {
        // Already closed
      }
      return;
    }

    // Check if this peer is already connected (reconnect scenario)
    for (const [existingWs, peer] of this.peers) {
      if (peer.peerId === payload.peerId && existingWs !== ws) {
        // Remove old connection
        this.peers.delete(existingWs);
        try {
          existingWs.close(4000, 'Replaced by new connection');
        } catch {
          // Already closed
        }
        break;
      }
    }

    const peer: ConnectedPeer = {
      webSocket: ws,
      peerId: payload.peerId,
      displayName: payload.displayName || `Peer-${payload.peerId.slice(0, 6)}`,
      joinedAt: Date.now(),
    };

    this.peers.set(ws, peer);

    // Serialize attachment for hibernation recovery (exclude non-serializable WebSocket)
    ws.serializeAttachment({
      peerId: peer.peerId,
      displayName: peer.displayName,
      joinedAt: peer.joinedAt,
    });

    // Notify the OTHER peer that someone joined
    const peerInfo: PeerInfo = {
      peerId: peer.peerId,
      displayName: peer.displayName,
    };

    this.broadcast(ws, this.createMessage('peer-joined', peerInfo, peer.peerId));

    // Send the joiner info about existing peers
    for (const [otherWs, otherPeer] of this.peers) {
      if (otherWs !== ws) {
        const existingPeerInfo: PeerInfo = {
          peerId: otherPeer.peerId,
          displayName: otherPeer.displayName,
        };
        ws.send(
          JSON.stringify(this.createMessage('peer-joined', existingPeerInfo, otherPeer.peerId))
        );
      }
    }
  }

  private handleSDP(ws: WebSocket, message: WSMessage): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      ws.send(JSON.stringify(this.createMessage('error', { reason: 'Not joined to room' })));
      return;
    }

    const payload = message.payload as SDPPayload;
    if (!payload?.sdp || !payload?.sdpType) {
      ws.send(JSON.stringify(this.createMessage('error', { reason: 'Invalid SDP payload' })));
      return;
    }

    // Relay to the other peer
    this.broadcast(ws, this.createMessage(message.type, payload, peer.peerId));
  }

  private handleICECandidate(ws: WebSocket, message: WSMessage): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      ws.send(JSON.stringify(this.createMessage('error', { reason: 'Not joined to room' })));
      return;
    }

    const payload = message.payload as ICECandidatePayload;
    if (!payload?.candidate) {
      ws.send(
        JSON.stringify(this.createMessage('error', { reason: 'Invalid ICE candidate payload' }))
      );
      return;
    }

    // Relay to the other peer
    this.broadcast(ws, this.createMessage('ice-candidate', payload, peer.peerId));
  }

  private handleChat(ws: WebSocket, message: WSMessage): void {
    const peer = this.peers.get(ws);
    if (!peer) {
      ws.send(JSON.stringify(this.createMessage('error', { reason: 'Not joined to room' })));
      return;
    }

    const payload = message.payload as ChatPayload;
    if (!payload?.message) {
      ws.send(
        JSON.stringify(this.createMessage('error', { reason: 'Empty chat message' }))
      );
      return;
    }

    // Sanitize message length (prevent abuse)
    const sanitizedPayload: ChatPayload = {
      message: payload.message.slice(0, 4096),
      id: payload.id || crypto.randomUUID(),
    };

    // Relay to the other peer
    this.broadcast(ws, this.createMessage('chat', sanitizedPayload, peer.peerId));
  }

  private handleLeave(ws: WebSocket): void {
    const peer = this.peers.get(ws);
    if (peer) {
      const peerInfo: PeerInfo = {
        peerId: peer.peerId,
        displayName: peer.displayName,
      };
      this.broadcast(ws, this.createMessage('peer-left', peerInfo, peer.peerId));
      this.peers.delete(ws);
    }

    try {
      ws.close(1000, 'Leaving room');
    } catch {
      // Already closed
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Broadcast a message to all peers EXCEPT the sender */
  private broadcast(senderWs: WebSocket, message: WSMessage): void {
    const serialized = JSON.stringify(message);
    for (const [ws] of this.peers) {
      if (ws !== senderWs) {
        try {
          ws.send(serialized);
        } catch {
          // Connection may be stale — will be cleaned up on next error/close
        }
      }
    }
  }

  /** Create a properly formatted WSMessage */
  private createMessage(type: WSMessage['type'], payload: unknown, sender?: string): WSMessage {
    return {
      type,
      payload,
      timestamp: Date.now(),
      ...(sender && { sender }),
    };
  }
}
