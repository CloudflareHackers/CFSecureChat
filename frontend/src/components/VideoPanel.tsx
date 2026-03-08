// ============================================================================
// VideoPanel — Video display component
// ============================================================================

import React, { useEffect, useRef } from 'react';
import type { WebRTCState } from '../hooks/useWebRTC';

interface VideoPanelProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  webrtcState: WebRTCState;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onSwitchCamera: () => void;
  onHangUp: () => void;
}

export const VideoPanel: React.FC<VideoPanelProps> = ({
  localStream,
  remoteStream,
  webrtcState,
  isAudioEnabled,
  isVideoEnabled,
  onToggleAudio,
  onToggleVideo,
  onSwitchCamera,
  onHangUp,
}) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const hasRemoteVideo = remoteStream && remoteStream.getVideoTracks().length > 0;
  const isConnected = webrtcState === 'connected';

  const getStateLabel = () => {
    switch (webrtcState) {
      case 'idle': return 'Waiting…';
      case 'requesting-media': return 'Requesting media…';
      case 'ready': return 'Waiting for peer…';
      case 'connecting': return 'Connecting…';
      case 'connected': return '● Connected';
      case 'disconnected': return 'Disconnected';
      case 'failed': return 'Failed';
      default: return '';
    }
  };

  return (
    <div className="video-panel">
      {/* Remote video */}
      <div className="video-container remote-video-container">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="remote-video"
        />
        {!hasRemoteVideo && (
          <div className="video-placeholder">
            <div className="placeholder-icon">👤</div>
            {!isConnected && <p className="placeholder-text">{getStateLabel()}</p>}
          </div>
        )}
      </div>

      {/* Local video PIP */}
      {localStream && (
        <div className="video-container local-video-container">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="local-video"
          />
        </div>
      )}

      {/* Connection badge — hide when connected */}
      {webrtcState !== 'connected' && (
        <div className={`connection-badge ${webrtcState}`}>
          {getStateLabel()}
        </div>
      )}

      {/* Media controls */}
      <div className="media-controls">
        <button
          className={`control-btn ${!isAudioEnabled ? 'off' : ''}`}
          onClick={onToggleAudio}
          title={isAudioEnabled ? 'Mute' : 'Unmute'}
        >
          {isAudioEnabled ? '🎤' : '🔇'}
        </button>
        <button
          className={`control-btn ${!isVideoEnabled ? 'off' : ''}`}
          onClick={onToggleVideo}
          title={isVideoEnabled ? 'Camera off' : 'Camera on'}
        >
          {isVideoEnabled ? '📹' : '🚫'}
        </button>
        <button
          className="control-btn"
          onClick={onSwitchCamera}
          title="Switch camera"
        >
          🔄
        </button>
        <button className="control-btn hangup" onClick={onHangUp} title="Hang up">
          📞
        </button>
      </div>
    </div>
  );
};
