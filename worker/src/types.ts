// ============================================================================
// Shared Types — CloudflareSecureChat Signaling Protocol
// ============================================================================

/** Environment bindings injected by wrangler */
export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  MAX_ROOM_SIZE: string;
  ENVIRONMENT: string;
}

// ---------------------------------------------------------------------------
// WebSocket Message Protocol
// ---------------------------------------------------------------------------

/** All message types flowing through the signaling WebSocket */
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

/** Base message envelope */
export interface WSMessage {
  type: WSMessageType;
  payload?: unknown;
  timestamp: number;
  sender?: string;
}

/** SDP offer/answer payload */
export interface SDPPayload {
  sdp: string;
  sdpType: 'offer' | 'answer';
}

/** ICE candidate payload */
export interface ICECandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/** Chat text payload */
export interface ChatPayload {
  message: string;
  id: string;
}

/** Join payload */
export interface JoinPayload {
  peerId: string;
  displayName?: string;
  accessCode?: string;
}

/** Peer info for room events */
export interface PeerInfo {
  peerId: string;
  displayName?: string;
}
