// Websockets through a restart of one API process.
//
// Opens CONNECTIONS sockets (as one admin user, like ws-fanout.mjs) and reopens any socket the
// server closes, after RECONNECT_MS plus up to as much again of jitter, as the admin app does. For
// DURATION_SEC it creates an ACO folder every INTERVAL_MS, which sends `aco.folder.created` to
// every socket of the user. Restart a process meanwhile (scripts/scenario4.sh).
//
// Reports: close codes, how long reconnects took, and per message how many sockets got it compared
// with how many were open when it was sent.
//
// Env: API_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CONNECTIONS (1000), OPEN_RATE (50), DURATION_SEC
// (180), INTERVAL_MS (1000), RECONNECT_MS (500), OUT.
import fs from "node:fs";
import crypto from "node:crypto";

const API = process.env.API_URL || "http://nginx:3002";
const CONNECTIONS = Number(process.env.CONNECTIONS || 1000);
const OPEN_RATE = Number(process.env.OPEN_RATE || 50);
const DURATION_SEC = Number(process.env.DURATION_SEC || 180);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 500);
const OUT = process.env.OUT;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();
const pct = (s, p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null);

const login = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        query: `mutation ($email: String!, $password: String!) { selfHostedAuthLogin(email: $email, password: $password) { data { token } } }`,
        variables: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    })
}).then(res => res.json());
const TOKEN = login.data?.selfHostedAuthLogin?.data?.token;
if (!TOKEN) {
    throw new Error(`login failed: ${JSON.stringify(login)}`);
}
const wsUrl = `${API.replace(/^http/, "ws")}/?token=${encodeURIComponent(TOKEN)}&tenant=root`;

let stopping = false;
const slots = []; // one per logical client: { ws, open }
const closes = {};
const closeTimes = []; // [time, code]
const reconnectMs = [];
let openFailures = 0;
const arrivals = new Map(); // folder id -> count

const connect = (slot, closedAt) => {
    const started = now();
    const ws = new WebSocket(wsUrl);
    slot.ws = ws;
    ws.addEventListener("open", () => {
        slot.open = true;
        if (closedAt) {
            reconnectMs.push(now() - closedAt);
        }
    });
    ws.addEventListener("message", event => {
        try {
            const message = JSON.parse(event.data);
            if (message?.action === "aco.folder.created") {
                arrivals.set(message.data.id, (arrivals.get(message.data.id) || 0) + 1);
            }
        } catch {
            // ignore
        }
    });
    ws.addEventListener("close", event => {
        const wasOpen = slot.open;
        slot.open = false;
        if (stopping) {
            return;
        }
        if (!wasOpen) {
            openFailures++;
        }
        closes[event.code] = (closes[event.code] || 0) + 1;
        closeTimes.push([new Date().toISOString(), event.code]);
        const at = closedAt ?? now();
        setTimeout(() => connect(slot, at), RECONNECT_MS + Math.random() * RECONNECT_MS);
    });
    return started;
};

for (let i = 0; i < CONNECTIONS; i++) {
    const slot = { ws: null, open: false };
    slots.push(slot);
    connect(slot, null);
    if ((i + 1) % OPEN_RATE === 0) {
        await sleep(1000);
    }
}
await sleep(10000);
console.log(`${slots.filter(s => s.open).length}/${CONNECTIONS} open; publishing for ${DURATION_SEC} s`);

const messages = [];
const end = Date.now() + DURATION_SEC * 1000;
while (Date.now() < end) {
    const openAtSend = slots.filter(s => s.open).length;
    const tag = crypto.randomBytes(6).toString("hex");
    const sentAt = new Date().toISOString();
    let id = null;
    let error = null;
    try {
        const res = await fetch(`${API}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({
                query: `mutation ($data: FolderCreateInput!) { aco { createFolder(data: $data) { data { id } error { message } } } }`,
                variables: { data: { title: `restart ${tag}`, slug: `restart-${tag}`, type: "ws-load-test" } }
            })
        });
        const body = await res.json().catch(() => null);
        id = body?.data?.aco?.createFolder?.data?.id ?? null;
        error = id ? null : `${res.status} ${JSON.stringify(body?.errors ?? body?.data?.aco?.createFolder?.error ?? body).slice(0, 120)}`;
    } catch (err) {
        error = err.message;
    }
    messages.push({ sentAt, id, error, openAtSend });
    await sleep(INTERVAL_MS);
}
await sleep(5000);
stopping = true;

const rows = messages.map(m => ({ ...m, delivered: m.id ? arrivals.get(m.id) || 0 : 0 }));
const short = rows.filter(m => m.id && m.delivered < m.openAtSend);
reconnectMs.sort((a, b) => a - b);
const report = {
    connections: CONNECTIONS,
    openAtEnd: slots.filter(s => s.open).length,
    closes,
    openFailuresWhileReconnecting: openFailures,
    reconnects: reconnectMs.length,
    reconnectMs: { p50: pct(reconnectMs, 50), p95: pct(reconnectMs, 95), max: pct(reconnectMs, 100) },
    messages: rows.length,
    createFailures: rows.filter(m => m.error).length,
    createErrors: rows.filter(m => m.error).map(m => `${m.sentAt} ${m.error}`),
    messagesShort: short.map(m => `${m.sentAt} delivered ${m.delivered} of ${m.openAtSend} open`),
    deliveredOfOpen: `${rows.reduce((a, m) => a + m.delivered, 0)} of ${rows.filter(m => m.id).reduce((a, m) => a + m.openAtSend, 0)}`,
    closeTimeline: closeTimes.length > 50 ? [...closeTimes.slice(0, 3), "...", ...closeTimes.slice(-3)] : closeTimes
};
console.log(JSON.stringify(report, null, 2));
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({ ...report, perMessage: rows }, null, 2));
}
for (const s of slots) {
    s.ws?.close(1000);
}
await sleep(500);
process.exit(0);
