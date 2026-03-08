# 🚀 Deployment Guide — CloudflareSecureChat

## Prerequisites

| Requirement | How to Get It |
|-------------|---------------|
| **Cloudflare Account** | Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan works) |
| **Node.js ≥ 18** | [nodejs.org](https://nodejs.org) |
| **Wrangler CLI** | `npm install -g wrangler` (already in devDependencies too) |
| **Workers Paid Plan** | Required for **Durable Objects** ($5/mo) — see note below |

> ⚠️ **Important:** Durable Objects require the **Workers Paid plan** ($5/month).
> The free Workers plan does NOT support Durable Objects. You must upgrade at:
> `Cloudflare Dashboard → Workers & Pages → Plans → Workers Paid`

---

## Step-by-Step Deployment

### Step 1: Authenticate with Cloudflare

```bash
wrangler login
```

This opens your browser to authorize Wrangler with your Cloudflare account.
Verify it worked:

```bash
wrangler whoami
```

---

### Step 2: Deploy the Worker (Backend)

```bash
cd worker
npm install
wrangler deploy
```

**Expected output:**
```
Uploading cloudflare-secure-chat...
Published cloudflare-secure-chat (x.xx sec)
  https://cloudflare-secure-chat.<your-subdomain>.workers.dev
```

**Save that URL** — you'll need it for the frontend.

#### Verify the Worker is running:

```bash
curl https://cloudflare-secure-chat.<your-subdomain>.workers.dev/api/health
```

Should return: `{"status":"ok","timestamp":...}`

---

### Step 3: Update Frontend to Point to Worker

Edit `frontend/src/hooks/useSignaling.ts` — update the `getWsUrl` function
to point to your deployed Worker URL when not running locally:

```typescript
const getWsUrl = useCallback(() => {
  if (signalingUrl) return signalingUrl;
  // In production, connect directly to the Worker
  const isLocal = window.location.hostname === 'localhost';
  if (isLocal) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/room/${roomId}`;
  }
  return `wss://cloudflare-secure-chat.<your-subdomain>.workers.dev/ws/room/${roomId}`;
}, [roomId, signalingUrl]);
```

**OR** (better approach) — use environment variables:

Create `frontend/.env.production`:
```
VITE_WORKER_URL=https://cloudflare-secure-chat.<your-subdomain>.workers.dev
```

And update the hook to read `import.meta.env.VITE_WORKER_URL`.

---

### Step 4: Build the Frontend

```bash
cd frontend
npm install
npm run build
```

This creates `frontend/dist/` with the production build.

---

### Step 5: Deploy Frontend to Cloudflare Pages

#### Option A: Wrangler CLI (Quick)

```bash
cd frontend
npx wrangler pages deploy dist --project-name=cloudflare-secure-chat
```

First time it will ask you to create the project. Say yes.

**Expected output:**
```
✨ Deployment complete!
https://cloudflare-secure-chat.pages.dev
```

#### Option B: Git Integration (Recommended for CI/CD)

1. Go to [Cloudflare Dashboard → Workers & Pages → Create](https://dash.cloudflare.com/?to=/:account/pages/new/provider/github)
2. Connect your Git repository
3. Configure build settings:
   - **Framework preset:** None
   - **Build command:** `cd frontend && npm install && npm run build`
   - **Build output directory:** `frontend/dist`
   - **Root directory:** `/` (project root)
4. Click **Deploy**

Every push to your main branch will auto-deploy.

---

### Step 6: Lock Down CORS (Production Security)

Edit `worker/src/index.ts` and replace the wildcard CORS origin:

```typescript
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://cloudflare-secure-chat.pages.dev', // Your Pages URL
  // ... rest stays the same
};
```

Then redeploy the worker:
```bash
cd worker
wrangler deploy
```

---

## Custom Domain (Optional)

### For the Worker (API/WebSocket):
1. Dashboard → Workers → cloudflare-secure-chat → Settings → Triggers
2. Add Custom Domain: `api.yourdomain.com`

### For Pages (Frontend):
1. Dashboard → Pages → cloudflare-secure-chat → Custom domains
2. Add: `chat.yourdomain.com`

Then update CORS and the frontend env var to match.

---

## Environment Variables

### Worker (`wrangler.toml`)
| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_ROOM_SIZE` | `"2"` | Max peers per room |
| `ENVIRONMENT` | `"production"` | Environment label |

### Frontend (`.env.production`)
| Variable | Example | Purpose |
|----------|---------|---------|
| `VITE_WORKER_URL` | `https://api.yourdomain.com` | Worker URL for signaling |

---

## Post-Deployment Verification

### 1. Health Check
```bash
curl https://cloudflare-secure-chat.<your-subdomain>.workers.dev/api/health
# → {"status":"ok","timestamp":...}
```

### 2. Create a Room
```bash
curl -X POST https://cloudflare-secure-chat.<your-subdomain>.workers.dev/api/room
# → {"roomId":"a1b2-c3d4-e5f6","wsUrl":"/ws/room/a1b2-c3d4-e5f6"}
```

### 3. Full Test
1. Open `https://cloudflare-secure-chat.pages.dev` in Chrome
2. Create a room
3. Copy the room ID
4. Open in another browser/incognito → Join with the room ID
5. Allow camera/mic → verify video/audio connects
6. Send text messages → verify real-time delivery

### 4. Monitor Logs
```bash
cd worker
wrangler tail
```

This streams real-time logs from the deployed Worker.

---

## Cost Estimate

| Resource | Free Tier | Paid Plan |
|----------|-----------|-----------|
| **Workers Requests** | 100K/day free | $0.50/million |
| **Durable Objects** | ❌ Not included | $5/mo base + $0.15/million requests |
| **Pages** | Unlimited sites, 500 builds/mo | Free |
| **Bandwidth** | Unlimited | Unlimited |

**For a personal 1-on-1 chat app:** ~$5/month (Durable Objects minimum).

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Durable Objects is not supported` | Upgrade to Workers Paid plan ($5/mo) |
| WebSocket won't connect | Check CORS origin matches your Pages URL |
| Camera/mic denied | Must use HTTPS (Cloudflare provides this) |
| ICE connection fails | Add TURN servers for NAT traversal (see below) |
| `wrangler deploy` fails | Run `wrangler login` again, check account ID |

### Adding TURN Servers (if ICE fails behind strict NATs)

Edit `frontend/src/hooks/useWebRTC.ts`:
```typescript
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Cloudflare Calls TURN (if you have access):
  { urls: 'turn:turn.cloudflare.com:3478', username: 'YOUR_KEY', credential: 'YOUR_SECRET' },
  // Or use a free TURN like Metered:
  { urls: 'turn:a.relay.metered.ca:443', username: 'YOUR_KEY', credential: 'YOUR_SECRET' },
];
```

---

## Quick Deploy Commands Summary

```bash
# 1. Login
wrangler login

# 2. Deploy Worker
cd worker && npm install && wrangler deploy

# 3. Build & Deploy Frontend
cd ../frontend && npm install && npm run build && npx wrangler pages deploy dist --project-name=cloudflare-secure-chat

# 4. Monitor
cd ../worker && wrangler tail
```
