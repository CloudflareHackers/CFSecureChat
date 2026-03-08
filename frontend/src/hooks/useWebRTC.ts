// ============================================================================
// useWebRTC — WebRTC Peer Connection Hook
// ============================================================================
// Manages the RTCPeerConnection for 1-on-1 audio/video communication.
// Configured for maximum quality in a strict 2-person scenario:
//  • Opus codec for audio (high fidelity, robust packet-loss concealment)
//  • VP8/H.264 for video at high bitrate (no simulcast — direct 1:1)
//  • DTLS key negotiation + SRTP with AES_CM cipher suites
//  • No simulcast layers (unnecessary for 1-on-1)
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebRTCState =
  | 'idle'
  | 'requesting-media'
  | 'ready'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

export interface MediaConfig {
  audio: boolean;
  video: boolean | MediaTrackConstraints;
}

export interface UseWebRTCOptions {
  /** Callback to send SDP offer via signaling */
  onSendOffer: (sdp: RTCSessionDescriptionInit) => void;
  /** Callback to send SDP answer via signaling */
  onSendAnswer: (sdp: RTCSessionDescriptionInit) => void;
  /** Callback to send ICE candidate via signaling */
  onSendICECandidate: (candidate: RTCIceCandidate) => void;
  /** Called when connection state changes */
  onStateChange?: (state: WebRTCState) => void;
}

export interface UseWebRTCReturn {
  state: WebRTCState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  startMedia: (config?: MediaConfig) => Promise<void>;
  stopMedia: () => void;
  createOffer: () => Promise<void>;
  handleOffer: (sdp: RTCSessionDescriptionInit) => Promise<void>;
  handleAnswer: (sdp: RTCSessionDescriptionInit) => Promise<void>;
  handleICECandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  toggleAudio: () => void;
  toggleVideo: () => void;
  switchCamera: () => Promise<void>;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// Optimal WebRTC configuration for 1-on-1 high-quality calls
// ---------------------------------------------------------------------------

/** STUN/TURN servers — using Google's public STUN + Cloudflare's edge */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add Cloudflare TURN servers here when available:
  // { urls: 'turn:turn.cloudflare.com:3478', username: '...', credential: '...' },
];

const RTC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  // DTLS is enforced by default in modern browsers
};

/** High-quality video constraints for 1-on-1 */
const DEFAULT_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920, min: 1280 },
  height: { ideal: 1080, min: 720 },
  frameRate: { ideal: 30, min: 24 },
  facingMode: 'user',
};

/** High-quality audio constraints with Opus optimization */
const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  sampleRate: 48000,
  channelCount: 1,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebRTC(options: UseWebRTCOptions): UseWebRTCReturn {
  const { onStateChange } = options;

  const [state, setState] = useState<WebRTCState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  // Store latest callbacks
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const updateState = useCallback(
    (newState: WebRTCState) => {
      setState(newState);
      onStateChange?.(newState);
    },
    [onStateChange]
  );

  // -------------------------------------------------------------------------
  // Create and configure RTCPeerConnection
  // -------------------------------------------------------------------------

  const createPeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        callbacksRef.current.onSendICECandidate(event.candidate);
      }
    };

    pc.onicecandidateerror = (event) => {
      console.warn('[WebRTC] ICE candidate error:', event);
    };

    // Handle remote tracks
    const remoteMs = new MediaStream();
    remoteStreamRef.current = remoteMs;
    setRemoteStream(remoteMs);

    pc.ontrack = (event) => {
      console.log('[WebRTC] Remote track received:', event.track.kind);
      remoteMs.addTrack(event.track);
      // Force React re-render with new stream reference
      setRemoteStream(new MediaStream(remoteMs.getTracks()));
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      switch (pc.connectionState) {
        case 'connecting':
          updateState('connecting');
          break;
        case 'connected':
          updateState('connected');
          break;
        case 'disconnected':
          updateState('disconnected');
          break;
        case 'failed':
          updateState('failed');
          break;
        case 'closed':
          updateState('idle');
          break;
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', pc.iceConnectionState);
    };

    // Add local tracks if we already have a stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    return pc;
  }, [updateState]);

  // -------------------------------------------------------------------------
  // Apply high-quality codec preferences
  // -------------------------------------------------------------------------

  const preferCodecs = useCallback((description: RTCSessionDescriptionInit): RTCSessionDescriptionInit => {
    if (!description.sdp) return description;

    let sdp = description.sdp;

    // Prefer Opus for audio — boost bitrate for maximum quality
    // Set Opus to max bitrate (510kbps for fullband stereo, 128kbps mono)
    sdp = sdp.replace(
      /a=fmtp:111 /g,
      'a=fmtp:111 maxaveragebitrate=510000;stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;'
    );

    // Boost video bitrate — set b=AS line for video
    // For 1080p30 without simulcast, target ~4 Mbps
    const videoMLineIndex = sdp.indexOf('m=video');
    if (videoMLineIndex !== -1) {
      const nextMLine = sdp.indexOf('\nm=', videoMLineIndex + 1);
      const videoSection = nextMLine !== -1
        ? sdp.substring(videoMLineIndex, nextMLine)
        : sdp.substring(videoMLineIndex);

      if (!videoSection.includes('b=AS:')) {
        // Insert bandwidth line after the first line of video m-section
        const firstNewline = sdp.indexOf('\n', videoMLineIndex);
        if (firstNewline !== -1) {
          sdp = sdp.slice(0, firstNewline + 1) + 'b=AS:4000\r\n' + sdp.slice(firstNewline + 1);
        }
      }
    }

    return { type: description.type, sdp };
  }, []);

  // -------------------------------------------------------------------------
  // Media controls
  // -------------------------------------------------------------------------

  const startMedia = useCallback(
    async (config?: MediaConfig) => {
      updateState('requesting-media');

      try {
        // Check what devices are actually available
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasAudio = devices.some((d) => d.kind === 'audioinput');
        const hasVideo = devices.some((d) => d.kind === 'videoinput');

        const wantAudio = config?.audio !== false && hasAudio;
        const wantVideo = config?.video !== false && hasVideo;

        // If no devices at all, just go to ready state (text-only mode)
        if (!wantAudio && !wantVideo) {
          console.warn('[WebRTC] No media devices found — text-only mode');
          updateState('ready');
          return;
        }

        const constraints: MediaStreamConstraints = {
          audio: wantAudio ? DEFAULT_AUDIO_CONSTRAINTS : false,
          video: wantVideo
            ? (typeof config?.video === 'object' ? config.video : DEFAULT_VIDEO_CONSTRAINTS)
            : false,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        localStreamRef.current = stream;
        setLocalStream(stream);

        // Start with mic and camera OFF — user explicitly enables them
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
        stream.getVideoTracks().forEach((t) => { t.enabled = false; });
        setIsAudioEnabled(false);
        setIsVideoEnabled(false);
        updateState('ready');
      } catch (err) {
        // Gracefully handle — fall back to text-only mode
        console.warn('[WebRTC] Failed to get user media, continuing in text-only mode:', err);
        updateState('ready');
      }
    },
    [updateState]
  );

  const stopMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsAudioEnabled((prev) => !prev);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsVideoEnabled((prev) => !prev);
    }
  }, []);

  /** Switch between front and back camera (mobile) */
  const facingModeRef = useRef<'user' | 'environment'>('user');
  const switchCamera = useCallback(async () => {
    if (!localStreamRef.current) return;

    // Toggle facing mode
    facingModeRef.current = facingModeRef.current === 'user' ? 'environment' : 'user';

    try {
      // Stop current video tracks
      localStreamRef.current.getVideoTracks().forEach((track) => track.stop());

      // Get new video with switched camera
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...DEFAULT_VIDEO_CONSTRAINTS,
          facingMode: facingModeRef.current,
        },
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      // Replace track in local stream
      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
      if (oldVideoTrack) {
        localStreamRef.current.removeTrack(oldVideoTrack);
      }
      localStreamRef.current.addTrack(newVideoTrack);

      // Replace track in peer connection sender
      const pc = pcRef.current;
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        }
      }

      // Update React state
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
    } catch (err) {
      console.warn('[WebRTC] Failed to switch camera:', err);
      // Revert facing mode
      facingModeRef.current = facingModeRef.current === 'user' ? 'environment' : 'user';
    }
  }, []);

  // -------------------------------------------------------------------------
  // Signaling handlers
  // -------------------------------------------------------------------------

  const createOffer = useCallback(async () => {
    const pc = createPeerConnection();

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });

    const optimizedOffer = preferCodecs(offer);
    await pc.setLocalDescription(optimizedOffer);
    callbacksRef.current.onSendOffer(optimizedOffer);
  }, [createPeerConnection, preferCodecs]);

  const handleOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const pc = createPeerConnection();

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));

      // Flush any pending ICE candidates
      for (const candidate of pendingCandidates.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidates.current = [];

      const answer = await pc.createAnswer();
      const optimizedAnswer = preferCodecs(answer);
      await pc.setLocalDescription(optimizedAnswer);
      callbacksRef.current.onSendAnswer(optimizedAnswer);
    },
    [createPeerConnection, preferCodecs]
  );

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const pc = pcRef.current;
    if (!pc) {
      console.warn('[WebRTC] No peer connection for answer');
      return;
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // Flush any pending ICE candidates
    for (const candidate of pendingCandidates.current) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    pendingCandidates.current = [];
  }, []);

  const handleICECandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      // Queue if remote description not yet set
      pendingCandidates.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] Failed to add ICE candidate:', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  const cleanup = useCallback(() => {
    stopMedia();
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    remoteStreamRef.current = null;
    setRemoteStream(null);
    pendingCandidates.current = [];
    updateState('idle');
  }, [stopMedia, updateState]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    localStream,
    remoteStream,
    startMedia,
    stopMedia,
    createOffer,
    handleOffer,
    handleAnswer,
    handleICECandidate,
    toggleAudio,
    toggleVideo,
    switchCamera,
    isAudioEnabled,
    isVideoEnabled,
    cleanup,
  };
}
