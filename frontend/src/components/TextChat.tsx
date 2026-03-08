// ============================================================================
// TextChat — Real-time text chat component
// ============================================================================
// Displays chat messages and provides input for sending new messages.
// All messages flow through the same WebSocket/Durable Object connection
// used for signaling — no database polling.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../hooks/useSignaling';

interface TextChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isConnected: boolean;
}

export const TextChat: React.FC<TextChatProps> = ({
  messages,
  onSendMessage,
  isConnected,
}) => {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !isConnected) return;
    onSendMessage(trimmed);
    setInput('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="text-chat">
      <div className="chat-header">
        <h3>💬 Chat</h3>
        <span className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>No messages yet.</p>
            <p className="hint">Messages are sent over the secure WebSocket connection.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-message ${msg.isLocal ? 'local' : 'remote'}`}
          >
            <div className="message-bubble">
              <span className={`message-sender ${msg.isLocal ? 'sender-local' : 'sender-remote'}`}>
                {msg.isLocal ? 'You' : (msg.sender.length > 20 ? msg.sender.slice(0, 8) : msg.sender)}
              </span>
              <p className="message-text">{msg.message}</p>
              <span className="message-time">{formatTime(msg.timestamp)}</span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? 'Type a message…' : 'Connect to start chatting'}
          disabled={!isConnected}
          maxLength={4096}
        />
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={!isConnected || !input.trim()}
          title="Send message"
        >
          ➤
        </button>
      </div>
    </div>
  );
};
