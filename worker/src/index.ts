// ============================================================================
// CloudflareSecureChat — Worker Entry Point
// ============================================================================
// This Worker acts as the HTTP router. It:
//  • Routes WebSocket upgrade requests to the correct Durable Object room.
//  • Provides a REST API for room creation and health checks.
//  • Enforces CORS for the frontend origin.
//  • Generates unique room IDs for new sessions.
// ============================================================================

import { ChatRoom } from './ChatRoom';
import type { Env } from './types';

// Re-export the Durable Object class so wrangler can discover it
export { ChatRoom };

// ---------------------------------------------------------------------------
// CORS Configuration
// ---------------------------------------------------------------------------
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*', // Lock down in production
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // -----------------------------------------------------------------------
      // Route: GET /api/health
      // -----------------------------------------------------------------------
      if (url.pathname === '/api/health') {
        return corsResponse(
          new Response(
            JSON.stringify({ status: 'ok', timestamp: Date.now() }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        );
      }

      // -----------------------------------------------------------------------
      // Route: POST /api/room — Create a new room, returns room ID + access code
      // -----------------------------------------------------------------------
      if (url.pathname === '/api/room' && request.method === 'POST') {
        const roomId = generateRoomId();
        const accessCode = generateAccessCode();

        // Read optional maxPeers from request body
        let maxPeers = 2;
        try {
          const body = (await request.json()) as { maxPeers?: number };
          if (body.maxPeers && body.maxPeers >= 2 && body.maxPeers <= 10) {
            maxPeers = body.maxPeers;
          }
        } catch {
          // No body or invalid JSON — use default
        }

        // Store the access code and max peers in the Durable Object
        const durableId = env.CHAT_ROOM.idFromName(roomId);
        const stub = env.CHAT_ROOM.get(durableId);
        await stub.fetch(new Request(`https://internal/set-access-code`, {
          method: 'POST',
          body: JSON.stringify({ accessCode, maxPeers }),
        }));

        return corsResponse(
          new Response(
            JSON.stringify({ roomId, accessCode, wsUrl: `/ws/room/${roomId}` }),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }

      // -----------------------------------------------------------------------
      // Route: GET /api/room/:roomId — Get room status
      // -----------------------------------------------------------------------
      const roomStatusMatch = url.pathname.match(/^\/api\/room\/([a-zA-Z0-9-]+)$/);
      if (roomStatusMatch && request.method === 'GET') {
        const roomId = roomStatusMatch[1];
        const durableId = env.CHAT_ROOM.idFromName(roomId);
        const stub = env.CHAT_ROOM.get(durableId);

        const roomUrl = new URL('/health', request.url);
        const healthRes = await stub.fetch(roomUrl.toString());
        const health = (await healthRes.json()) as Record<string, unknown>;

        return corsResponse(
          new Response(
            JSON.stringify({ roomId, ...health }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        );
      }

      // -----------------------------------------------------------------------
      // Route: GET /ws/room/:roomId — WebSocket upgrade to join a room
      // -----------------------------------------------------------------------
      const wsMatch = url.pathname.match(/^\/ws\/room\/([a-zA-Z0-9-]+)$/);
      if (wsMatch) {
        const roomId = wsMatch[1];

        // Validate WebSocket upgrade
        if (request.headers.get('Upgrade') !== 'websocket') {
          return corsResponse(
            new Response('Expected WebSocket upgrade request', { status: 426 })
          );
        }

        // Derive the Durable Object ID from the room name for deterministic routing
        const durableId = env.CHAT_ROOM.idFromName(roomId);
        const stub = env.CHAT_ROOM.get(durableId);

        // Forward the WebSocket upgrade request to the Durable Object
        return stub.fetch(request);
      }

      // -----------------------------------------------------------------------
      // 404 — Unknown route
      // -----------------------------------------------------------------------
      return corsResponse(
        new Response(
          JSON.stringify({
            error: 'Not Found',
            routes: [
              'GET  /api/health',
              'POST /api/room',
              'GET  /api/room/:roomId',
              'GET  /ws/room/:roomId (WebSocket)',
            ],
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      console.error('Worker error:', err);
      return corsResponse(
        new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe, human-readable room ID.
 * Format: xxxx-xxxx-xxxx (12 chars + dashes)
 */
function generateRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const segments: string[] = [];
  for (let s = 0; s < 3; s++) {
    let segment = '';
    for (let i = 0; i < 4; i++) {
      const randomBytes = new Uint8Array(1);
      crypto.getRandomValues(randomBytes);
      segment += chars[randomBytes[0] % chars.length];
    }
    segments.push(segment);
  }
  return segments.join('-');
}

/**
 * Generate a 6-digit numeric access code for room security.
 * Must be shared out-of-band to join the room.
 */
function generateAccessCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const num = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(num % 1000000).padStart(6, '0');
}
