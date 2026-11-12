// Background tasks across both API processes.
//
// Triggers COUNT `testingRun` tasks (one step, returns done) through nginx, so the triggers land on
// both processes, then polls each task until it reaches a final status or WAIT_SEC passes. Reports
// how many finished, failed or never ran, their iterations (1 expected), and the time from trigger
// to finish.
//
// Env: API_URL, API_KEY (needs the `tasks` permission, see README), COUNT (200), CONCURRENCY (8),
// DEFINITION (testingRun), WAIT_SEC (300), OUT.
import fs from "node:fs";

const API = process.env.API_URL || "http://nginx:3002";
const KEY = process.env.API_KEY;
const COUNT = Number(process.env.COUNT || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const DEFINITION = process.env.DEFINITION || "testingRun";
const WAIT_SEC = Number(process.env.WAIT_SEC || 300);
const OUT = process.env.OUT;
const FINAL = new Set(["success", "failed", "aborted"]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gql = async (query, variables) => {
    const res = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ query, variables })
    });
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || body?.errors) {
        throw new Error(`${res.status} ${JSON.stringify(body?.errors || body).slice(0, 200)}`);
    }
    return body.data;
};
const pool = async (items, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < items.length) {
                const i = next++;
                try {
                    out[i] = { ok: true, value: await fn(items[i], i) };
                } catch (error) {
                    out[i] = { ok: false, error: error.message };
                }
            }
        })
    );
    return out;
};
const pct = (s, p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null);

const run = Date.now().toString(36);
const triggered = await pool([...Array(COUNT).keys()], async i => {
    const data = await gql(
        `mutation ($definition: String!, $name: String) {
            backgroundTasks { triggerTask(definition: $definition, name: $name, input: {}) { data { id } error { code message } } }
        }`,
        { definition: DEFINITION, name: `load ${run} ${i}` }
    );
    const result = data.backgroundTasks.triggerTask;
    if (result.error) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    return result.data.id;
});
const ids = triggered.filter(r => r.ok).map(r => r.value);
const triggerErrors = {};
for (const r of triggered.filter(r => !r.ok)) {
    triggerErrors[r.error] = (triggerErrors[r.error] || 0) + 1;
}
console.log(`triggered ${ids.length}/${COUNT} ${DEFINITION} tasks`, Object.keys(triggerErrors).length ? triggerErrors : "");

const tasks = new Map();
const deadline = Date.now() + WAIT_SEC * 1000;
let pending = ids;
while (pending.length && Date.now() < deadline) {
    const results = await pool(pending, async id => {
        const data = await gql(
            `query ($id: ID!) { backgroundTasks { getTask(id: $id) { data { id taskStatus iterations createdOn startedOn finishedOn } error { message } } } }`,
            { id }
        );
        return data.backgroundTasks.getTask.data;
    });
    for (const r of results) {
        if (r.ok && r.value) {
            tasks.set(r.value.id, r.value);
        }
    }
    pending = pending.filter(id => !FINAL.has(tasks.get(id)?.taskStatus));
    if (pending.length) {
        await sleep(5000);
    }
}

const byStatus = {};
const byIterations = {};
const toFinish = [];
for (const id of ids) {
    const t = tasks.get(id);
    const status = t?.taskStatus ?? "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (t) {
        byIterations[t.iterations] = (byIterations[t.iterations] || 0) + 1;
        if (t.finishedOn) {
            toFinish.push(Date.parse(t.finishedOn) - Date.parse(t.createdOn));
        }
    }
}
toFinish.sort((a, b) => a - b);
const report = {
    definition: DEFINITION,
    count: COUNT,
    triggered: ids.length,
    triggerErrors,
    byStatus,
    byIterations,
    triggerToFinishMs: { p50: pct(toFinish, 50), p95: pct(toFinish, 95), max: pct(toFinish, 100) },
    notFinal: pending
};
console.log(JSON.stringify(report, null, 2));
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}
