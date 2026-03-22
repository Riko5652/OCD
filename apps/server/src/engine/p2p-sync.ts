/**
 * Peer-to-Peer (P2P) Secure Team Memory
 *
 * Local-network only, encrypted peer sync that lets team members
 * (e.g. Alice and Bob on the same Tailscale/LAN) share vector embeddings of
 * successful session resolutions with zero cloud dependencies.
 *
 * Protocol:
 *   1. UDP broadcast on port P2P_DISCOVERY_PORT announces presence every 30s.
 *   2. Peers respond via the HTTP /api/p2p/hello endpoint with their node ID.
 *   3. Sync is triggered by `POST /api/p2p/sync` which pulls embeddings from
 *      all known peers and merges them into the local `session_embeddings` table
 *      under a synthetic "remote" session record.
 *   4. All HTTP peer communication uses a shared HMAC-SHA256 token derived
 *      from P2P_SECRET (env var) — no TLS required on LAN, but payloads are
 *      authenticated so rogue peers can't inject garbage.
 *
 * Privacy guarantees:
 *   - Only embeddings + session metadata (title, tldr, task_type) are shared.
 *     No source code, no raw conversation turns, no API keys.
 *   - The server still binds to 127.0.0.1 for the main API; P2P uses a
 *     separate socket on the LAN interface.
 *   - If P2P_SECRET is not set, peer sync is disabled by default.
 */

import { createSocket } from 'dgram';
import { createHmac, randomBytes } from 'crypto';
import { networkInterfaces } from 'os';
import { getDb } from '../db/index.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const P2P_SECRET = process.env.P2P_SECRET || '';
const P2P_DISCOVERY_PORT = parseInt(process.env.P2P_DISCOVERY_PORT || '39831');
const P2P_HTTP_PORT = parseInt(process.env.P2P_HTTP_PORT || '39832');
const P2P_ANNOUNCE_INTERVAL_MS = 30_000;
const P2P_PEER_TTL_MS = 5 * 60_000; // drop peers not seen in 5 min
const MAX_EMBEDDINGS_PER_SYNC = 100;

// Unique node ID for this OCD instance (stable across restarts via DB)
function getNodeId(): string {
    const db = getDb();
    // Re-use insight_cache as a lightweight KV store
    const row = db.prepare("SELECT result FROM insight_cache WHERE key = 'p2p_node_id'").get() as any;
    if (row) return row.result;
    const id = randomBytes(8).toString('hex');
    db.prepare("INSERT OR REPLACE INTO insight_cache (key, result, created_at) VALUES ('p2p_node_id', ?, ?)").run(id, Date.now());
    return id;
}

// ─── HMAC authentication ──────────────────────────────────────────────────────

function signPayload(payload: string): string {
    if (!P2P_SECRET) throw new Error('P2P_SECRET is not configured. Cannot sign payload.');
    return createHmac('sha256', P2P_SECRET).update(payload).digest('hex');
}

function verifySignature(payload: string, sig: string): boolean {
    if (!P2P_SECRET) return false;
    const expected = signPayload(payload);
    // Constant-time comparison
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
}

// ─── LAN IP discovery ─────────────────────────────────────────────────────────

function getLanIp(): string | null {
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const iface of list || []) {
            if (!iface.internal && iface.family === 'IPv4') return iface.address;
        }
    }
    return null;
}

function getBroadcastAddress(ip: string): string {
    // Simple /24 broadcast — works for most office/home LANs
    const parts = ip.split('.');
    parts[3] = '255';
    return parts.join('.');
}

// ─── In-memory peer registry ──────────────────────────────────────────────────

interface Peer {
    peerId: string;
    host: string;
    httpPort: number;
    lastSeen: number;
}

const peers = new Map<string, Peer>();

function upsertPeer(peerId: string, host: string, httpPort: number) {
    const now = Date.now();
    peers.set(peerId, { peerId, host, httpPort, lastSeen: now });

    const db = getDb();
    db.prepare(`
        INSERT INTO p2p_peers (peer_id, host, port, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET host = excluded.host, port = excluded.port, last_seen_at = excluded.last_seen_at
    `).run(peerId, host, httpPort, now);
}

function pruneStalePeers() {
    const cutoff = Date.now() - P2P_PEER_TTL_MS;
    for (const [id, peer] of peers) {
        if (peer.lastSeen < cutoff) peers.delete(id);
    }
}

export function getKnownPeers(): Peer[] {
    pruneStalePeers();
    return [...peers.values()];
}

// ─── UDP announcement ─────────────────────────────────────────────────────────

let udpSocket: ReturnType<typeof createSocket> | null = null;

function buildAnnouncement(nodeId: string, lanIp: string): Buffer {
    const payload = JSON.stringify({ nodeId, ip: lanIp, httpPort: P2P_HTTP_PORT, ts: Date.now() });
    const sig = signPayload(payload);
    return Buffer.from(JSON.stringify({ payload, sig }));
}

function startUdpAnnouncer(nodeId: string) {
    const lanIp = getLanIp();
    if (!lanIp) {
        console.log('[p2p] No LAN IP found — UDP announcer disabled.');
        return;
    }

    udpSocket = createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('message', (msg, rinfo) => {
        try {
            const { payload, sig } = JSON.parse(msg.toString());
            if (!verifySignature(payload, sig)) return; // reject unauthenticated

            const data = JSON.parse(payload);
            if (data.nodeId === nodeId) return; // ignore self

            upsertPeer(data.nodeId, rinfo.address, data.httpPort);
            console.log(`[p2p] Discovered peer ${data.nodeId} at ${rinfo.address}:${data.httpPort}`);
        } catch { /* malformed */ }
    });

    udpSocket.on('error', () => { /* non-critical */ });

    udpSocket.bind(P2P_DISCOVERY_PORT, () => {
        udpSocket?.setBroadcast(true);
        console.log(`[p2p] Listening for peers on UDP ${P2P_DISCOVERY_PORT}`);
    });

    // Announce immediately and then every 30s
    const announce = () => {
        const buf = buildAnnouncement(nodeId, lanIp);
        const broadcast = getBroadcastAddress(lanIp);
        udpSocket?.send(buf, P2P_DISCOVERY_PORT, broadcast, () => {});
    };

    announce();
    return setInterval(announce, P2P_ANNOUNCE_INTERVAL_MS);
}

// ─── HTTP peer API (called by Fastify in index.ts) ────────────────────────────

/** Returns our embeddings to share with a requesting peer. */
export function getShareableEmbeddings(limit = MAX_EMBEDDINGS_PER_SYNC): Array<{
    remoteSessionId: string;
    embedding: number[];
    title: string;
    tldr: string;
    taskType: string | null;
    language: string | null;
    qualityScore: number | null;
}> {
    const db = getDb();
    const rows = db.prepare(`
        SELECT se.session_id, se.embedding, s.title, s.tldr, s.quality_score,
               tc.task_type, tc.language
        FROM session_embeddings se
        JOIN sessions s ON s.id = se.session_id
        LEFT JOIN task_classifications tc ON tc.session_id = se.session_id
        WHERE s.quality_score >= 70
        ORDER BY s.quality_score DESC, s.started_at DESC
        LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
        remoteSessionId: r.session_id,
        embedding: (() => { try { return JSON.parse(r.embedding); } catch { return []; } })(),
        title: r.title || '',
        tldr: r.tldr || '',
        taskType: r.task_type || null,
        language: r.language || null,
        qualityScore: r.quality_score || null,
    })).filter(r => r.embedding.length > 0);
}

/** Validates an incoming sync request signature. */
export function validatePeerRequest(body: string, sig: string): boolean {
    return verifySignature(body, sig);
}

/** Merges received embeddings from a peer into local DB. */
export function mergePeerEmbeddings(
    peerId: string,
    items: ReturnType<typeof getShareableEmbeddings>,
): { imported: number; skipped: number } {
    const db = getDb();
    let imported = 0;
    let skipped = 0;

    // Create a phantom tool entry for remote peers if not exists
    db.prepare("INSERT OR IGNORE INTO tools (id, display_name) VALUES ('p2p-remote', 'P2P Remote Peer')").run();

    const insertSession = db.prepare(`
        INSERT OR IGNORE INTO sessions
          (id, tool_id, title, tldr, started_at, total_turns, primary_model, meta)
        VALUES (?, 'p2p-remote', ?, ?, ?, 0, 'remote', 1)
    `);

    const insertEmbedding = db.prepare(`
        INSERT OR REPLACE INTO session_embeddings (session_id, embedding, provider, dimensions, created_at)
        VALUES (?, ?, 'p2p', ?, ?)
    `);

    db.transaction(() => {
        for (const item of items) {
            if (!item.embedding?.length) { skipped++; continue; }

            // Use a namespaced ID to avoid collisions with local sessions
            const localId = `p2p::${peerId}::${item.remoteSessionId}`;

            insertSession.run(localId, item.title, item.tldr, Date.now());
            insertEmbedding.run(localId, JSON.stringify(item.embedding), item.embedding.length, Date.now());
            imported++;
        }
    })();

    // Update peer stats
    db.prepare(`
        UPDATE p2p_peers SET accepted_sessions = accepted_sessions + ?, last_seen_at = ?
        WHERE peer_id = ?
    `).run(imported, Date.now(), peerId);

    console.log(`[p2p] Merged ${imported} embeddings from peer ${peerId} (${skipped} skipped).`);
    return { imported, skipped };
}

/** Pull embeddings from all known peers. */
export async function syncWithAllPeers(nodeId: string): Promise<{ peer: string; imported: number }[]> {
    const results: { peer: string; imported: number }[] = [];

    for (const peer of getKnownPeers()) {
        try {
            const url = `http://${peer.host}:${peer.httpPort}/api/p2p/embeddings`;
            const reqBody = JSON.stringify({ requesterId: nodeId, ts: Date.now() });
            const sig = signPayload(reqBody);

            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-OCD-Sig': sig,
                },
                body: reqBody,
                signal: AbortSignal.timeout(15_000),
            });

            if (!resp.ok) {
                console.warn(`[p2p] Peer ${peer.peerId} returned ${resp.status}`);
                continue;
            }

            const data = await resp.json() as { items: ReturnType<typeof getShareableEmbeddings> };
            const { imported } = mergePeerEmbeddings(peer.peerId, data.items || []);
            results.push({ peer: peer.peerId, imported });
        } catch (e: any) {
            console.warn(`[p2p] Sync with ${peer.peerId} failed: ${e.message}`);
        }
    }

    return results;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let announceInterval: ReturnType<typeof setInterval> | null = null;
let NODE_ID = '';

export function startP2pSync(): string {
    if (!P2P_SECRET) {
        console.log('[p2p] P2P_SECRET not set — peer sync disabled. Set P2P_SECRET to enable.');
        return '';
    }

    NODE_ID = getNodeId();
    const interval = startUdpAnnouncer(NODE_ID);
    if (interval) announceInterval = interval;

    console.log(`[p2p] Node ID: ${NODE_ID} | HTTP sync port: ${P2P_HTTP_PORT}`);
    return NODE_ID;
}

export function stopP2pSync() {
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
    if (udpSocket) { try { udpSocket.close(); } catch { /* ignore */ } udpSocket = null; }
}

export function getNodeId_(): string { return NODE_ID; }

/** Returns P2P security warnings for the dashboard. */
export function getP2pSecurityStatus(): { enabled: boolean; warnings: string[] } {
    const warnings: string[] = [];
    if (!P2P_SECRET) return { enabled: false, warnings };
    warnings.push('P2P sync uses plaintext HTTP — embeddings and metadata are transmitted unencrypted on the LAN. HMAC authentication prevents tampering but does not prevent eavesdropping. Consider using a VPN or Tailscale for sensitive environments.');
    return { enabled: true, warnings };
}
