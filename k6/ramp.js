// Stepwise arrival-rate ramp against the CMS API.
//
//   SCENARIO   read | write | mixed (90% read, 10% write)
//   START      first step's rate, req/s (default 10)
//   STEP       added each step, req/s (default 10)
//   STEP_SEC   step length, seconds (default 60)
//   MAX_STEPS  default 40
//   HOLD_RATE  if set, no ramp: hold this rate for HOLD_SEC (default 600) seconds instead
//
// Every request is tagged with its `step`. Requests sent after the first SETTLE_SEC (15) seconds
// of a step also carry `settled`, and the abort thresholds look only at those, so a step is judged
// on its steady state, not on the backlog the previous one left. The run aborts once a step's p95
// is over 1 s or more than 1% of its requests fail; scripts/steps.mjs reports every step from the
// JSON output afterwards.
import http from "k6/http";
import exec from "k6/execution";
import { Counter, Rate } from "k6/metrics";

const API = __ENV.API_URL || "http://nginx:3002";
const KEY = __ENV.API_KEY;
const SCENARIO = __ENV.SCENARIO || "read";
const START = Number(__ENV.START || 10);
const STEP = Number(__ENV.STEP || 10);
const STEP_SEC = Number(__ENV.STEP_SEC || 60);
const MAX_STEPS = Number(__ENV.MAX_STEPS || 40);
const SETTLE_SEC = Number(__ENV.SETTLE_SEC || 15);
const HOLD_RATE = __ENV.HOLD_RATE ? Number(__ENV.HOLD_RATE) : null;
const HOLD_SEC = Number(__ENV.HOLD_SEC || 600);

// A request failed when the status is not 200 or the GraphQL body carries an error.
const failed = new Rate("failed");
const gqlErrors = new Counter("gql_errors");

const stages = [];
if (HOLD_RATE) {
    stages.push({ target: HOLD_RATE, duration: "1s" }, { target: HOLD_RATE, duration: `${HOLD_SEC - 1}s` });
} else {
    for (let i = 0; i < MAX_STEPS; i++) {
        const rate = START + i * STEP;
        stages.push({ target: rate, duration: "1s" }, { target: rate, duration: `${STEP_SEC - 1}s` });
    }
}

const thresholds = { failed: [{ threshold: "rate<0.5", abortOnFail: true }] };
if (!HOLD_RATE) {
    for (let i = 1; i <= MAX_STEPS; i++) {
        thresholds[`http_req_duration{settled:${i}}`] = [
            { threshold: "p(95)<1000", abortOnFail: true }
        ];
        thresholds[`failed{settled:${i}}`] = [{ threshold: "rate<0.01", abortOnFail: true }];
    }
}

export const options = {
    scenarios: {
        ramp: {
            executor: "ramping-arrival-rate",
            startRate: HOLD_RATE || START,
            timeUnit: "1s",
            preAllocatedVUs: 50,
            maxVUs: Number(__ENV.MAX_VUS || 800),
            stages
        }
    },
    thresholds,
    // Listing every entry id takes ~150 list requests; on SQLite each costs ~0.7 s.
    setupTimeout: __ENV.SETUP_TIMEOUT || "60s",
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
    discardResponseBodies: false
};

const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };

const LIST = `query ($where: LoadArticleListWhereInput, $sort: [LoadArticleListSorter], $after: String) {
    listLoadArticles(where: $where, sort: $sort, limit: 20, after: $after) {
        data { id entryId values { title slug author category region price rating views featured releasedOn tags } }
        meta { cursor hasMoreItems totalCount }
    }
}`;
const GET = `query ($entryId: String) {
    getLoadArticle(where: { entryId: $entryId }) {
        data { id entryId values { title slug author category region language sku color summary body notes price stock rating views featured archived releasedOn expiresOn tags } }
    }
}`;
const CREATE = `mutation ($data: LoadArticleInput!) {
    createLoadArticle(data: $data) { data { id } error { message code } }
}`;
const UPDATE = `mutation ($id: ID!, $data: LoadArticleInput!) {
    updateLoadArticle(revision: $id, data: $data) { data { id } error { message code } }
}`;

export function setup() {
    const ids = [];
    let after = null;
    while (ids.length < 3000) {
        const res = http.post(
            `${API}/cms/read`,
            JSON.stringify({ query: LIST, variables: { sort: ["id_ASC"], after } }),
            { headers, tags: { phase: "setup" } }
        );
        const body = res.json();
        const list = body.data.listLoadArticles;
        list.data.forEach(entry => ids.push(entry.entryId));
        if (!list.meta.hasMoreItems) {
            break;
        }
        after = list.meta.cursor;
    }
    if (ids.length === 0) {
        throw new Error("no loadArticle entries; run scripts/seed.mjs");
    }
    return { ids };
}

const tagsNow = () => {
    // From the scenario's start, not the test run's: setup() comes before it.
    const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
    const step = HOLD_RATE ? 1 : Math.min(MAX_STEPS, Math.floor(elapsed / STEP_SEC) + 1);
    const tags = { step: String(step) };
    if (HOLD_RATE || elapsed % STEP_SEC >= SETTLE_SEC) {
        tags.settled = String(step);
    }
    return tags;
};

const send = (path, op, query, variables) => {
    const tags = { ...tagsNow(), op };
    const res = http.post(`${API}${path}`, JSON.stringify({ query, variables }), { headers, tags });
    let message = null;
    if (res.status !== 200) {
        message = `HTTP ${res.status}`;
    } else {
        try {
            const body = res.json();
            if (body.errors) {
                message = body.errors[0].message;
            } else {
                const result = Object.values(body.data)[0];
                if (result && result.error) {
                    message = result.error.code || result.error.message;
                }
            }
        } catch (err) {
            message = "invalid JSON";
        }
    }
    failed.add(message !== null, tags);
    if (message !== null) {
        gqlErrors.add(1, { ...tags, msg: String(message).slice(0, 100) });
    }
    return res;
};

const pick = list => list[Math.floor(Math.random() * list.length)];
const CATEGORIES = ["news", "guide", "review", "opinion"];
const SORTS = ["values_views_DESC", "values_price_ASC", "values_title_ASC", "createdOn_DESC"];

const read = ids => {
    if (Math.random() < 0.5) {
        const where = { values: { category: pick(CATEGORIES) } };
        if (Math.random() < 0.5) {
            where.values.rating_gte = 3;
        }
        send("/cms/read", "list", LIST, { where, sort: [pick(SORTS)] });
        return;
    }
    send("/cms/read", "get", GET, { entryId: pick(ids) });
};

// Drafts this VU created, so updates hit unlocked revisions only.
const mine = [];
let counter = 0;

const values = () => {
    counter++;
    const n = exec.vu.idInTest * 1000000 + counter;
    return {
        title: `k6 article ${n}`,
        slug: `k6-${n}`,
        author: "k6",
        category: pick(CATEGORIES),
        region: "eu",
        language: "en",
        sku: `K6-${n}`,
        color: "red",
        summary: "A short summary of the article. ".repeat(4),
        body: "Body text for a load-test entry. ".repeat(40),
        notes: "Notes. ".repeat(10),
        price: (n % 500) + 0.99,
        stock: n % 100,
        rating: (n % 5) + 1,
        views: n % 10000,
        featured: false,
        archived: false,
        releasedOn: "2026-01-01T00:00:00.000Z",
        expiresOn: "2027-01-01T00:00:00.000Z",
        tags: ["k6"]
    };
};

const write = () => {
    if (mine.length > 0 && Math.random() < 0.5) {
        send("/cms/manage", "update", UPDATE, { id: pick(mine), data: { values: values() } });
        return;
    }
    const res = send("/cms/manage", "create", CREATE, { data: { values: values() } });
    try {
        const id = res.json().data.createLoadArticle.data.id;
        mine.push(id);
        if (mine.length > 50) {
            mine.shift();
        }
    } catch (err) {
        // counted as failed by send()
    }
};

export default function (data) {
    if (SCENARIO === "read") {
        read(data.ids);
    } else if (SCENARIO === "write") {
        write();
    } else if (Math.random() < 0.9) {
        read(data.ids);
    } else {
        write();
    }
}
