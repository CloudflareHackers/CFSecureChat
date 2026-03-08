// ============================================================================
// useSignaling — WebSocket Signaling Hook
// ============================================================================
// Manages the WebSocket connection to the Cloudflare Worker/Durable Object.
// Handles:
//  • Connection lifecycle (connect, disconnect, reconnect)
//  • Sending/receiving signaling messages (SDP, ICE candidates)
//  • Real-time text chat over the same WebSocket
//  • Heartbeat keep-alive via ping/pong
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types (mirrored from worker for frontend use)
// ---------------------------------------------------------------------------

export type WSMessageType =
  | 'join'
  | 'leave'
  | 'sdp-offer'
  | 'sdp-answer'
  | 'ice-candidate'
  | 'chat'
  | 'peer-joined'
  | 'peer-left'
  | 'room-full'
  | 'error'
  | 'ping'
  | 'pong';

export interface WSMessage {
  type: WSMessageType;
  payload?: unknown;
  timestamp: number;
  sender?: string;
}

export interface PeerInfo {
  peerId: string;
  displayName?: string;
}

export interface ChatMessage {
  id: string;
  message: string;
  sender: string;
  timestamp: number;
  isLocal: boolean;
}

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface UseSignalingOptions {
  roomId: string;
  peerId: string;
  displayName?: string;
  accessCode?: string;
  signalingUrl?: string;
  onPeerJoined?: (peer: PeerInfo) => void;
  onPeerLeft?: (peer: PeerInfo) => void;
  onSDPOffer?: (sdp: RTCSessionDescriptionInit) => void;
  onSDPAnswer?: (sdp: RTCSessionDescriptionInit) => void;
  onICECandidate?: (candidate: RTCIceCandidateInit) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onRoomFull?: () => void;
  onError?: (error: string) => void;
}

export interface UseSignalingReturn {
  state: SignalingState;
  connect: () => void;
  disconnect: () => void;
  sendSDPOffer: (sdp: RTCSessionDescriptionInit) => void;
  sendSDPAnswer: (sdp: RTCSessionDescriptionInit) => void;
  sendICECandidate: (candidate: RTCIceCandidate) => void;
  sendChatMessage: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSignaling(options: UseSignalingOptions): UseSignalingReturn {
  const {
    roomId,
    peerId,
    displayName,
    signalingUrl,
    onChatMessage,
    onError,
  } = options;

  const [state, setState] = useState<SignalingState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  // Store latest callbacks in refs to avoid stale closures
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const getWsUrl = useCallback(() => {
    if (signalingUrl) return signalingUrl;
    // In production, connect directly to the Worker; locally, use the Vite proxy
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocal) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws/room/${roomId}`;
    }
    return `wss://cloudflare-secure-chat.hashhackersapi.workers.dev/ws/room/${roomId}`;
  }, [roomId, signalingUrl]);

  const sendMessage = useCallback((type: WSMessageType, payload?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: WSMessage = { type, payload, timestamp: Date.now() };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    pingIntervalRef.current = setInterval(() => {
      sendMessage('ping');
    }, 30_000);
  }, [sendMessage]);

  const stopHeartbeat = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: WSMessage = JSON.parse(event.data);
      const cb = callbacksRef.current;

      switch (message.type) {
        case 'peer-joined':
          cb.onPeerJoined?.(message.payload as PeerInfo);
          break;

        case 'peer-left':
          cb.onPeerLeft?.(message.payload as PeerInfo);
          break;

        case 'sdp-offer': {
          const offerPayload = message.payload as { sdp: string; sdpType: string };
          cb.onSDPOffer?.({ type: 'offer', sdp: offerPayload.sdp });
          break;
        }

        case 'sdp-answer': {
          const answerPayload = message.payload as { sdp: string; sdpType: string };
          cb.onSDPAnswer?.({ type: 'answer', sdp: answerPayload.sdp });
          break;
        }

        case 'ice-candidate': {
          const icePayload = message.payload as {
            candidate: string;
            sdpMid: string | null;
            sdpMLineIndex: number | null;
          };
          cb.onICECandidate?.(icePayload);
          break;
        }

        case 'chat': {
          const chatPayload = message.payload as { message: string; id: string; senderName?: string };
          cb.onChatMessage?.({
            id: chatPayload.id,
            message: chatPayload.message,
            sender: chatPayload.senderName || message.sender || 'Unknown',
            timestamp: message.timestamp,
            isLocal: false,
          });
          break;
        }

        case 'room-full':
          cb.onRoomFull?.();
          break;

        case 'error': {
          const errorPayload = message.payload as { reason: string };
          cb.onError?.(errorPayload.reason);
          break;
        }

        case 'pong':
          // Heartbeat acknowledged
          break;
      }
    } catch (err) {
      console.error('[Signaling] Failed to parse message:', err);
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setState('connecting');

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setState('connected');
      reconnectAttempts.current = 0;

      // Join the room immediately with access code
      const accessCode = callbacksRef.current.accessCode;
      sendMessage('join', {
        peerId,
        displayName: displayName || `User-${peerId.slice(0, 6)}`,
        ...(accessCode && { accessCode }),
      });
      startHeartbeat();
    };

    ws.onmessage = handleMessage;

    ws.onclose = (event) => {
      setState('disconnected');
      stopHeartbeat();

      // Auto-reconnect on abnormal close
      if (event.code !== 1000 && event.code !== 4001 && reconnectAttempts.current < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 16_000);
        reconnectAttempts.current++;
        console.log(`[Signaling] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      setState('error');
      onError?.('WebSocket connection error');
    };
  }, [getWsUrl, peerId, displayName, sendMessage, startHeartbeat, stopHeartbeat, handleMessage, onError]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttempts.current = maxReconnectAttempts; // Prevent auto-reconnect
    stopHeartbeat();

    if (wsRef.current) {
      sendMessage('leave');
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }
    setState('disconnected');
  }, [sendMessage, stopHeartbeat]);

  const sendSDPOffer = useCallback(
    (sdp: RTCSessionDescriptionInit) => {
      sendMessage('sdp-offer', { sdp: sdp.sdp, sdpType: 'offer' });
    },
    [sendMessage]
  );

  const sendSDPAnswer = useCallback(
    (sdp: RTCSessionDescriptionInit) => {
      sendMessage('sdp-answer', { sdp: sdp.sdp, sdpType: 'answer' });
    },
    [sendMessage]
  );

  const sendICECandidate = useCallback(
    (candidate: RTCIceCandidate) => {
      sendMessage('ice-candidate', {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      });
    },
    [sendMessage]
  );

  const sendChatMessage = useCallback(
    (message: string) => {
      const id = crypto.randomUUID();
      const name = callbacksRef.current.displayName || `User-${peerId.slice(0, 6)}`;
      sendMessage('chat', { message, id, senderName: name });

      // Also deliver locally with display name
      onChatMessage?.({
        id,
        message,
        sender: name,
        timestamp: Date.now(),
        isLocal: true,
      });
    },
    [sendMessage, peerId, onChatMessage]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    state,
    connect,
    disconnect,
    sendSDPOffer,
    sendSDPAnswer,
    sendICECandidate,
    sendChatMessage,
  };
}
