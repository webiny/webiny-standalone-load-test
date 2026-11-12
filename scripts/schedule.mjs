// Scheduled publishing across both API processes.
//
// Creates COUNT draft loadArticle entries, schedules each to publish at the same moment, LEAD_SEC
// seconds from now (the API refuses less than 65), spread over SPREAD_SEC seconds, then waits until
// WAIT_SEC after the last one is due and checks: is every entry published, is every scheduled action
// gone. Whether each ran exactly once is read from the database afterwards (scripts/claims.sh):
// every run takes one claim in webiny_core_key_value, and the claim names the process.
//
// Env: API_URL, API_KEY, COUNT (300), LEAD_SEC (90), SPREAD_SEC (0), WAIT_SEC (120),
// CONCURRENCY (8), OUT.
import fs from "node:fs";

const API = process.env.API_URL || "http://nginx:3002";
const KEY = process.env.API_KEY;
const COUNT = Number(process.env.COUNT || 300);
const LEAD_SEC = Number(process.env.LEAD_SEC || 90);
const SPREAD_SEC = Number(process.env.SPREAD_SEC || 0);
const WAIT_SEC = Number(process.env.WAIT_SEC || 120);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const OUT = process.env.OUT;
const NAMESPACE = "Cms/Entry/loadArticle";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const gql = async (path, query, variables) => {
    const res = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ query, variables })
    });
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || body?.errors) {
        throw new Error(`${res.status} ${JSON.stringify(body?.errors || body).slice(0, 300)}`);
    }
    return body.data;
};

const pool = async (items, fn) => {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (next < items.length) {
                const i = next++;
                try {
                    results[i] = { ok: true, value: await fn(items[i], i) };
                } catch (error) {
                    results[i] = { ok: false, error: error.message };
                }
            }
        })
    );
    return results;
};

const run = Date.now().toString(36);
const dueAt = Date.now() + LEAD_SEC * 1000;

// 1. Drafts.
const created = await pool([...Array(COUNT).keys()], async i => {
    const data = await gql(
        "/cms/manage",
        `mutation ($data: LoadArticleInput!) { createLoadArticle(data: $data) { data { id } error { message } } }`,
        { data: { values: { title: `scheduled ${run} ${i}`, category: "news", tags: ["scheduled"] } } }
    );
    if (data.createLoadArticle.error) {
        throw new Error(data.createLoadArticle.error.message);
    }
    return data.createLoadArticle.data.id;
});
const ids = created.filter(r => r.ok).map(r => r.value);
console.log(`created ${ids.length}/${COUNT} drafts`);

// 2. Schedule.
const scheduleStarted = Date.now();
const scheduled = await pool(ids, async (id, i) => {
    const at = new Date(dueAt + (SPREAD_SEC ? Math.floor((i / ids.length) * SPREAD_SEC * 1000) : 0));
    const data = await gql(
        "/graphql",
        `mutation ($targetId: ID!, $at: DateTime) {
            scheduler { scheduleAction(namespace: "${NAMESPACE}", targetId: $targetId, scheduleFor: $at, actionType: publish) {
                data { id } error { code message }
            } }
        }`,
        { targetId: id, at: at.toISOString() }
    );
    const result = data.scheduler.scheduleAction;
    if (result.error) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    return { id, actionId: result.data.id, at: at.toISOString() };
});
const ok = scheduled.filter(r => r.ok).map(r => r.value);
const scheduleErrors = {};
for (const r of scheduled.filter(r => !r.ok)) {
    scheduleErrors[r.error] = (scheduleErrors[r.error] || 0) + 1;
}
console.log(
    `scheduled ${ok.length}/${ids.length} in ${((Date.now() - scheduleStarted) / 1000).toFixed(1)} s, due ${new Date(dueAt).toISOString()}` +
        (SPREAD_SEC ? ` over ${SPREAD_SEC} s` : "")
);
if (Object.keys(scheduleErrors).length) {
    console.log("schedule errors:", scheduleErrors);
}

// 3. Wait, then check.
const until = dueAt + SPREAD_SEC * 1000 + WAIT_SEC * 1000;
console.log(`waiting until ${new Date(until).toISOString()}`);
await sleep(Math.max(0, until - Date.now()));

const statuses = await pool(ok, async ({ id }) => {
    const data = await gql(
        "/cms/manage",
        `query ($id: ID) { getLoadArticle(revision: $id) { data { id meta { status } lastPublishedOn } error { message } } }`,
        { id }
    );
    return data.getLoadArticle.data?.meta?.status ?? `error: ${data.getLoadArticle.error?.message}`;
});
const byStatus = {};
for (const s of statuses) {
    const key = s.ok ? s.value : `request failed: ${s.error.slice(0, 80)}`;
    byStatus[key] = (byStatus[key] || 0) + 1;
}

const pending = await gql(
    "/graphql",
    `query { scheduler { listScheduledActions(namespace: "${NAMESPACE}", limit: 1000) { data { id } meta { totalCount } error { message } } } }`
);

const report = {
    run,
    count: COUNT,
    created: ids.length,
    scheduled: ok.length,
    scheduleErrors,
    dueAt: new Date(dueAt).toISOString(),
    spreadSec: SPREAD_SEC,
    checkedAt: new Date().toISOString(),
    entryStatus: byStatus,
    actionsStillPending: pending.scheduler.listScheduledActions.meta?.totalCount,
    actionIds: ok.map(r => r.actionId)
};
console.log(JSON.stringify({ ...report, actionIds: undefined }, null, 2));
if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}
