// ============================================================================
// App — Main Application Component
// ============================================================================
// Orchestrates the entire 1-on-1 secure communication flow:
//  1. Lobby screen: Create or join a room
//  2. Room screen: Video + text chat with signaling + WebRTC
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSignaling, type ChatMessage, type PeerInfo } from './hooks/useSignaling';
import { useWebRTC } from './hooks/useWebRTC';
import { VideoPanel } from './components/VideoPanel';
import { TextChat } from './components/TextChat';

// Generate a stable peer ID per session
const LOCAL_PEER_ID = crypto.randomUUID();

/** Resolve Worker API base URL — local proxy in dev, direct in production */
function getApiBase(): string {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocal ? '' : 'https://cloudflare-secure-chat.hashhackersapi.workers.dev';
}

type AppView = 'lobby' | 'room';

export const App: React.FC = () => {
  // Read ?room= and &pin= from URL on initial load
  const urlParams = new URLSearchParams(window.location.search);
  const initialRoom = urlParams.get('room') || '';
  const initialPin = urlParams.get('pin') || '';

  const [view, setView] = useState<AppView>('lobby');
  const [roomId, setRoomId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [joinInput, setJoinInput] = useState(initialRoom);
  const [joinAccessCode, setJoinAccessCode] = useState(initialPin);
  const [displayName, setDisplayName] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [remotePeer, setRemotePeer] = useState<PeerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRoomFull, setIsRoomFull] = useState(false);
  const [shouldConnect, setShouldConnect] = useState(false);
  const [chatVisible, setChatVisible] = useState(true);
  const [maxPeers, setMaxPeers] = useState(2);

  // We need refs to access webrtc methods from signaling callbacks
  const webrtcRef = useRef<ReturnType<typeof useWebRTC> | null>(null);

  // -------------------------------------------------------------------------
  // WebRTC hook
  // -------------------------------------------------------------------------
  const webrtc = useWebRTC({
    onSendOffer: (sdp) => signaling.sendSDPOffer(sdp),
    onSendAnswer: (sdp) => signaling.sendSDPAnswer(sdp),
    onSendICECandidate: (candidate) => signaling.sendICECandidate(candidate),
  });
  webrtcRef.current = webrtc;

  // -------------------------------------------------------------------------
  // Signaling hook
  // -------------------------------------------------------------------------
  const signaling = useSignaling({
    roomId,
    peerId: LOCAL_PEER_ID,
    displayName: displayName || undefined,
    accessCode: accessCode || undefined,

    onPeerJoined: useCallback((peer: PeerInfo) => {
      console.log('[App] Peer joined:', peer);
      setRemotePeer(peer);
      // Only one peer should create the offer — use peer ID comparison
      // The peer with the "higher" ID is the offerer (deterministic)
      if (LOCAL_PEER_ID > peer.peerId) {
        console.log('[App] We are the offerer');
        webrtcRef.current?.createOffer();
      } else {
        console.log('[App] We are the answerer — waiting for offer');
      }
    }, []),

    onPeerLeft: useCallback((peer: PeerInfo) => {
      console.log('[App] Peer left:', peer);
      setRemotePeer(null);
      webrtcRef.current?.cleanup();
      // Re-start media so we're ready for reconnection
      webrtcRef.current?.startMedia();
    }, []),

    onSDPOffer: useCallback((sdp: RTCSessionDescriptionInit) => {
      console.log('[App] Received SDP offer');
      webrtcRef.current?.handleOffer(sdp);
    }, []),

    onSDPAnswer: useCallback((sdp: RTCSessionDescriptionInit) => {
      console.log('[App] Received SDP answer');
      webrtcRef.current?.handleAnswer(sdp);
    }, []),

    onICECandidate: useCallback((candidate: RTCIceCandidateInit) => {
      webrtcRef.current?.handleICECandidate(candidate);
    }, []),

    onChatMessage: useCallback((msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    }, []),

    onRoomFull: useCallback(() => {
      setIsRoomFull(true);
      setError('Room is full. Only 2 participants are allowed.');
    }, []),

    onError: useCallback((err: string) => {
      console.error('[App] Signaling error:', err);
      setError(err);
    }, []),
  });

  // Auto-connect signaling when roomId is set and shouldConnect flag is true
  // This ensures React has re-rendered with the new roomId before we connect
  useEffect(() => {
    if (shouldConnect && roomId && view === 'room') {
      setShouldConnect(false);
      signaling.connect();
    }
  }, [shouldConnect, roomId, view, signaling]);

  // -------------------------------------------------------------------------
  // Room actions
  // -------------------------------------------------------------------------

  const createRoom = async () => {
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPeers }),
      });
      const data = await res.json();
      setRoomId(data.roomId);
      setAccessCode(data.accessCode);
      setView('room');
      // Update URL with room ID so the link is shareable
      window.history.replaceState(null, '', `?room=${data.roomId}`);
      // Start media (gracefully handles missing devices)
      await webrtc.startMedia();
      // Signal connect on next render (after roomId state is committed)
      setShouldConnect(true);
    } catch (err) {
      setError('Failed to create room. Is the worker running?');
      console.error(err);
    }
  };

  const joinRoom = async () => {
    if (!displayName.trim()) {
      setError('Please enter your name');
      return;
    }
    const id = joinInput.trim();
    if (!id) {
      setError('Please enter a room ID');
      return;
    }
    if (!joinAccessCode.trim()) {
      setError('Please enter the 6-digit access code');
      return;
    }
    setError(null);
    setRoomId(id);
    setAccessCode(joinAccessCode.trim());
    setView('room');
    await webrtc.startMedia();
    setShouldConnect(true);
  };

  const leaveRoom = () => {
    signaling.disconnect();
    webrtc.cleanup();
    setView('lobby');
    setRoomId('');
    setAccessCode('');
    setMessages([]);
    setRemotePeer(null);
    setError(null);
    setIsRoomFull(false);
    // Clear room from URL
    window.history.replaceState(null, '', window.location.pathname);
  };

  /** Build the shareable room link (with pin for auto-fill) */
  const getRoomLink = (includePin = false) => {
    const base = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    return includePin && accessCode ? `${base}&pin=${accessCode}` : base;
  };

  const handleSendChat = (message: string) => {
    signaling.sendChatMessage(message);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (view === 'lobby') {
    return (
      <div className="app">
        <div className="lobby">
          <div className="lobby-card">
            <h1 className="logo">🔒 CF Secure Chat</h1>
            <p className="subtitle">
              Secure 1-on-1 text, audio & video communication
            </p>
            <p className="tech-stack">
              Powered by Cloudflare Workers · Durable Objects · WebRTC
            </p>

            {error && <div className="error-banner">{error}</div>}

            <div className="lobby-section">
              <label htmlFor="displayName">Your Name</label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your name (required)"
                className="lobby-input"
                maxLength={32}
                required
              />
            </div>

            <div className="lobby-section">
              <button
                className="btn btn-primary"
                onClick={createRoom}
                disabled={!displayName.trim()}
              >
                ✨ Create New Room
              </button>
            </div>

            <div className="lobby-divider">
              <span>or</span>
            </div>

            <div className="lobby-section">
              <label htmlFor="roomId">Join Existing Room</label>
              <input
                id="roomId"
                type="text"
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value)}
                placeholder="Enter room ID (e.g., a1b2-c3d4-e5f6)"
                className="lobby-input"
                style={{ marginBottom: '0.5rem' }}
              />
              <label htmlFor="accessCode">Access Code</label>
              <div className="input-group">
                <input
                  id="accessCode"
                  type="text"
                  value={joinAccessCode}
                  onChange={(e) => setJoinAccessCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
                  placeholder="6-digit code"
                  className="lobby-input"
                  maxLength={6}
                  inputMode="numeric"
                  pattern="[0-9]*"
                />
                <button className="btn btn-secondary" onClick={joinRoom}>
                  Join →
                </button>
              </div>
            </div>

            <div className="security-info">
              <h4>🛡️ Security</h4>
              <ul>
                <li>6-digit access code required to join rooms</li>
                <li>WebSocket Secure (WSS) for all signaling & chat</li>
                <li>DTLS key negotiation for media encryption</li>
                <li>SRTP with AES_CM cipher suites</li>
                <li>Strict 2-person room limit</li>
                <li>No data stored — ephemeral rooms</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="room">
        {/* Header */}
        <div className="room-header">
          <div className="room-info">
            <h2>🔒 Room: <code>{roomId}</code></h2>
            <span className={`signaling-state ${signaling.state}`}>
              {signaling.state}
            </span>
            {remotePeer && (
              <span className="peer-badge">
                👤 {remotePeer.displayName || remotePeer.peerId.slice(0, 8)}
              </span>
            )}
          </div>
          <button className="btn btn-danger" onClick={leaveRoom}>
            Leave Room
          </button>
        </div>

        {/* Access code banner — shown when waiting for peer */}
        {accessCode && !remotePeer && (
          <div className="access-code-banner">
            <div className="access-code-info">
              <strong>📋 Send this to your peer:</strong>
              <div className="access-code-details">
                <span>🔗 Link:</span>
                <code style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>{getRoomLink()}</code>
                <button className="copy-btn" onClick={() => copyToClipboard(getRoomLink())} title="Copy Room Link">📋 Copy Link</button>
              </div>
              <div className="access-code-details" style={{ marginTop: '0.4rem' }}>
                <span>🔑 Access Code:</span>
                <code className="access-code">{accessCode}</code>
                <button className="copy-btn" onClick={() => copyToClipboard(accessCode)} title="Copy Access Code">📋 Copy Code</button>
                <button
                  className="copy-btn copy-all"
                  onClick={() => copyToClipboard(getRoomLink(true))}
                >
                  📋 Copy Link+Code
                </button>
              </div>
            </div>
          </div>
        )}

        {error && <div className="error-banner" style={{ margin: '0 1rem' }}>{error}</div>}
        {isRoomFull && (
          <div className="error-banner" style={{ margin: '0 1rem' }}>
            Room is full — only 2 participants allowed.
          </div>
        )}

        {/* Main content */}
        <div className="room-content">
          <div className="video-area">
            <VideoPanel
              localStream={webrtc.localStream}
              remoteStream={webrtc.remoteStream}
              webrtcState={webrtc.state}
              isAudioEnabled={webrtc.isAudioEnabled}
              isVideoEnabled={webrtc.isVideoEnabled}
              onToggleAudio={webrtc.toggleAudio}
              onToggleVideo={webrtc.toggleVideo}
              onSwitchCamera={webrtc.switchCamera}
              onHangUp={leaveRoom}
            />
            {/* Chat toggle button */}
            <button
              className={`chat-toggle-btn ${chatVisible ? 'active' : ''}`}
              onClick={() => setChatVisible((v) => !v)}
              title={chatVisible ? 'Hide chat' : 'Show chat'}
            >
              💬 {!chatVisible && messages.length > 0 && <span className="chat-badge">{messages.length}</span>}
            </button>
          </div>
          {chatVisible && (
            <TextChat
              messages={messages}
              onSendMessage={handleSendChat}
              isConnected={signaling.state === 'connected'}
            />
          )}
        </div>
      </div>
    </div>
  );
};
