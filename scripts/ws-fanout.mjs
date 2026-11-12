// Websocket fan-out across both API processes.
//
// Opens CONNECTIONS sockets through nginx (round robin, so they land on both processes), all
// authenticated with one admin user's login token, so all of them belong to the same identity. (An
// API key does not work here: the websocket authenticator registers such a socket as anonymous.) Then creates MESSAGES
// ACO folders, one every INTERVAL_MS. Each create makes the process that handled it send
// `aco.folder.created` to every connection of that identity (SendToIdentity): to its own sockets
// directly, and to the other process's through Valkey. The API picks the folder id (an `id` in the
// input is ignored), so arrivals are recorded by id with their time and matched to the create
// request afterwards; latency is from sending the create request to arrival.
//
// Reports per message: how many sockets got it, and the latency from the create request to arrival.
// Runs in the `client` compose service; env: API_URL, ADMIN_EMAIL, ADMIN_PASSWORD, CONNECTIONS, OPEN_RATE (sockets/s),
// MESSAGES, INTERVAL_MS, SETTLE_MS, OUT (JSON report path).
import fs from "node:fs";
import crypto from "node:crypto";

const API = process.env.API_URL || "http://nginx:3002";
const CONNECTIONS = Number(process.env.CONNECTIONS || 1000);
const OPEN_RATE = Number(process.env.OPEN_RATE || 50);
const MESSAGES = Number(process.env.MESSAGES || 50);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 10000);
const HOLD_MS = Number(process.env.HOLD_MS || 0);
const OUT = process.env.OUT;

const login = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        query: `mutation ($email: String!, $password: String!) {
            selfHostedAuthLogin(email: $email, password: $password) { data { token } error { message } }
        }`,
        variables: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    })
}).then(res => res.json());
const KEY = login.data?.selfHostedAuthLogin?.data?.token;
if (!KEY) {
    throw new Error(`login failed: ${JSON.stringify(login)}`);
}
const wsUrl = `${API.replace(/^http/, "ws")}/?token=${encodeURIComponent(KEY)}&tenant=root`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

const sockets = [];
const arrivedAt = new Map(); // folder id -> [ms]
const closes = {}; // close code -> count
const openTimes = [];
let openErrors = 0;
let otherMessages = 0;
let reconnects = 0;

const open = index =>
    new Promise(resolve => {
        const started = now();
        const ws = new WebSocket(wsUrl);
        const entry = { ws, index, open: false };
        ws.addEventListener("open", () => {
            entry.open = true;
            openTimes.push(now() - started);
            resolve(entry);
        });
        ws.addEventListener("error", () => {
            if (!entry.open) {
                openErrors++;
                resolve(entry);
            }
        });
        ws.addEventListener("close", event => {
            closes[event.code] = (closes[event.code] || 0) + 1;
            entry.open = false;
        });
        ws.addEventListener("message", event => {
            const at = now();
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                otherMessages++;
                return;
            }
            const id = message?.data?.id;
            if (message?.action === "aco.folder.created" && id) {
                if (!arrivedAt.has(id)) {
                    arrivedAt.set(id, []);
                }
                arrivedAt.get(id).push(at);
            } else {
                otherMessages++;
                if (otherMessages === 1 && process.env.DEBUG) {
                    console.log("first unmatched message:", event.data.slice(0, 500));
                }
            }
        });
        sockets.push(entry);
    });

const gql = async (query, variables) => {
    const res = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ query, variables })
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

const CREATE = `mutation ($data: FolderCreateInput!) {
    aco { createFolder(data: $data) { data { id } error { code message } } }
}`;
const DELETE = `mutation ($id: ID!) { aco { deleteFolder(id: $id) { data error { code message } } } }`;

const pct = (sorted, p) =>
    sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]) : null;

// 1. Open the sockets at OPEN_RATE per second.
const openStarted = now();
const opening = [];
for (let i = 0; i < CONNECTIONS; i++) {
    opening.push(open(i));
    if ((i + 1) % OPEN_RATE === 0) {
        await sleep(1000);
    }
}
await Promise.all(opening);
const openSeconds = (now() - openStarted) / 1000;
const opened = sockets.filter(s => s.open).length;
console.log(`opened ${opened}/${CONNECTIONS} in ${openSeconds.toFixed(1)} s, ${openErrors} failed`);

// Registration (authenticate + registry write) runs after the socket opens; give it time.
await sleep(SETTLE_MS);
if (HOLD_MS) {
    console.log(`holding ${HOLD_MS} ms`);
    await sleep(HOLD_MS);
}

// 2. Publish.
const createResults = [];
for (let i = 0; i < MESSAGES; i++) {
    const tag = crypto.randomBytes(6).toString("hex");
    const started = now();
    const { status, body } = await gql(CREATE, {
        data: { title: `ws ${i} ${tag}`, slug: `ws-${tag}`, type: "ws-load-test" }
    });
    const id = body?.data?.aco?.createFolder?.data?.id;
    const error =
        body?.errors?.[0]?.message || body?.data?.aco?.createFolder?.error?.message || (id ? null : "no id");
    createResults.push({ id, sentAt: started, status, ms: Math.round(now() - started), error });
    if (error && i < 3) {
        console.log(`create ${i}: ${status} ${error}`);
    }
    await sleep(INTERVAL_MS);
}
await sleep(SETTLE_MS);

// 3. Report.
const stillOpen = sockets.filter(s => s.open).length;
const allLatencies = [];
const perMessage = createResults.map(r => {
    const latencies = (arrivedAt.get(r.id) || []).map(at => at - r.sentAt).sort((a, b) => a - b);
    allLatencies.push(...latencies);
    return {
        id: r.id,
        createStatus: r.status,
        createMs: r.ms,
        createError: r.error,
        delivered: latencies.length,
        p50: pct(latencies, 50),
        p95: pct(latencies, 95),
        max: latencies.length ? Math.round(latencies[latencies.length - 1]) : null
    };
});
const all = allLatencies.sort((a, b) => a - b);
const ok = perMessage.filter(m => !m.createError);
const report = {
    connections: CONNECTIONS,
    opened,
    openErrors,
    openSeconds,
    openMs: { p50: pct(openTimes.sort((a, b) => a - b), 50), p95: pct(openTimes, 95), max: pct(openTimes, 100) },
    messages: MESSAGES,
    createFailures: perMessage.length - ok.length,
    expectedDeliveries: ok.length * opened,
    deliveries: all.length,
    lost: ok.length * opened - all.length,
    latencyMs: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: pct(all, 100) },
    stillOpenAtEnd: stillOpen,
    closes,
    otherMessages,
    // Arrivals for folders this run did not create, or that arrived after the report.
    unmatchedFolderMessages: [...arrivedAt.keys()].filter(id => !createResults.some(r => r.id === id)).length,
    reconnects,
    perMessage
};
console.log(JSON.stringify({ ...report, perMessage: undefined }, null, 2));
console.log("per message: delivered / p50 / p95 / max ms");
for (const m of perMessage) {
    console.log(`  ${m.id} ${m.delivered} ${m.p50} ${m.p95} ${m.max} create=${m.createStatus}/${m.createMs}ms ${m.createError || ""}`);
}
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}

// Clean up the folders, then the sockets.
for (const r of createResults.filter(r => !r.error)) {
    await gql(DELETE, { id: r.id }).catch(() => {});
}
for (const s of sockets) {
    s.ws.close(1000);
}
await sleep(1000);
process.exit(0);
