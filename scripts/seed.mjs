// Creates the `loadArticle` model (20 fields) and N published entries through the manage API.
//   node scripts/seed.mjs [count=3000] [concurrency=8]
// Reads API_KEY from .env. Safe to re-run: the model is created only when missing, and entries are
// added on top of the ones already there.
import fs from "node:fs";

const env = Object.fromEntries(
    fs
        .readFileSync(new URL("../.env", import.meta.url), "utf8")
        .split("\n")
        .filter(line => /^[A-Z_]+=/.test(line))
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const API = process.env.API_URL || "http://localhost:3002";
const count = Number(process.argv[2] || 3000);
const concurrency = Number(process.argv[3] || 8);

const gql = async (path, query, variables) => {
    const res = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LT_API_KEY || env.API_KEY}` },
        body: JSON.stringify({ query, variables })
    });
    const body = await res.json();
    if (body.errors) {
        throw new Error(JSON.stringify(body.errors));
    }
    return body.data;
};

// The 20 fields. `n` is the type, the rest of the definition follows from it.
export const FIELDS = [
    ["title", "text"],
    ["slug", "text"],
    ["author", "text"],
    ["category", "text"],
    ["region", "text"],
    ["language", "text"],
    ["sku", "text"],
    ["color", "text"],
    ["summary", "long-text"],
    ["body", "long-text"],
    ["notes", "long-text"],
    ["price", "number"],
    ["stock", "number"],
    ["rating", "number"],
    ["views", "number"],
    ["featured", "boolean"],
    ["archived", "boolean"],
    ["releasedOn", "datetime"],
    ["expiresOn", "datetime"],
    ["tags", "text", true]
];

const RENDERER = {
    text: "text-input",
    "long-text": "long-text-text-area",
    number: "number-input",
    boolean: "boolean-input",
    datetime: "date-time-input"
};

const fieldInput = ([fieldId, type, list]) => ({
    id: fieldId,
    fieldId,
    label: fieldId,
    type,
    list: Boolean(list),
    renderer: { name: list ? "text-inputs" : RENDERER[type] },
    settings: type === "datetime" ? { type: "dateTimeWithoutTimezone" } : {}
});

const ensureModel = async () => {
    const { getContentModel } = await gql(
        "/cms/manage",
        `query { getContentModel(modelId: "loadArticle") { data { modelId } error { code } } }`
    );
    if (getContentModel.data) {
        console.log("model loadArticle exists");
        return;
    }
    const { listContentModelGroups } = await gql(
        "/cms/manage",
        `query { listContentModelGroups { data { id } } }`
    );
    const { createContentModel } = await gql(
        "/cms/manage",
        `mutation ($data: CmsContentModelCreateInput!) {
            createContentModel(data: $data) { data { modelId } error { message data } }
        }`,
        {
            data: {
                name: "Load Article",
                modelId: "loadArticle",
                singularApiName: "LoadArticle",
                pluralApiName: "LoadArticles",
                group: listContentModelGroups.data[0].id,
                fields: FIELDS.map(fieldInput),
                layout: FIELDS.map(([fieldId]) => [fieldId]),
                titleFieldId: "title"
            }
        }
    );
    if (createContentModel.error) {
        throw new Error(JSON.stringify(createContentModel.error));
    }
    console.log("created model loadArticle");
};

const pick = (list, i) => list[i % list.length];

export const entryData = i => ({
    title: `Load article ${i} ${Math.random().toString(36).slice(2, 8)}`,
    slug: `load-article-${i}-${Date.now()}`,
    author: pick(["Ana", "Ben", "Chen", "Dara", "Eli"], i),
    category: pick(["news", "guide", "review", "opinion"], i),
    region: pick(["eu", "us", "apac"], i),
    language: pick(["en", "de", "fr"], i),
    sku: `SKU-${100000 + i}`,
    color: pick(["red", "green", "blue", "black"], i),
    summary: "A short summary of the article. ".repeat(4),
    body: "Body text for a load-test entry. ".repeat(40),
    notes: "Notes. ".repeat(10),
    price: (i % 500) + 0.99,
    stock: i % 100,
    rating: (i % 5) + 1,
    views: i * 7,
    featured: i % 10 === 0,
    archived: false,
    releasedOn: new Date(Date.UTC(2025, i % 12, (i % 28) + 1)).toISOString(),
    expiresOn: new Date(Date.UTC(2027, i % 12, (i % 28) + 1)).toISOString(),
    tags: [pick(["a", "b", "c"], i), pick(["x", "y"], i)]
});

const createOne = async i => {
    const { createLoadArticle } = await gql(
        "/cms/manage",
        `mutation ($data: LoadArticleInput!) {
            createLoadArticle(data: $data) { data { id } error { message } }
        }`,
        { data: { values: entryData(i) } }
    );
    if (createLoadArticle.error) {
        throw new Error(createLoadArticle.error.message);
    }
    const { publishLoadArticle } = await gql(
        "/cms/manage",
        `mutation ($id: ID!) { publishLoadArticle(revision: $id) { error { message } } }`,
        { id: createLoadArticle.data.id }
    );
    if (publishLoadArticle.error) {
        throw new Error(publishLoadArticle.error.message);
    }
};

if (import.meta.url === `file://${process.argv[1]}`) {
    await ensureModel();
    const started = Date.now();
    let next = 0;
    let done = 0;
    let failed = 0;
    const worker = async () => {
        while (next < count) {
            const i = next++;
            try {
                await createOne(i);
                done++;
            } catch (err) {
                failed++;
                if (failed <= 5) {
                    console.error(`entry ${i}: ${err.message}`);
                }
            }
            if ((done + failed) % 250 === 0) {
                console.log(`${done + failed}/${count}, ${failed} failed`);
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`done: ${done} created, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`);
}
