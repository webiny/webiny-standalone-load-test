// Permanently deletes every loadArticle entry the seed did not create (k6 writes, probes, scheduled
// test entries), through the manage API so the storage's own bookkeeping stays right.
//   node scripts/cleanup.mjs [concurrency=16]
import fs from "node:fs";

const env = Object.fromEntries(
    fs
        .readFileSync(new URL("../.env", import.meta.url), "utf8")
        .split("\n")
        .filter(line => /^[A-Z_]+=/.test(line))
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const API = process.env.API_URL || "http://localhost:3002";
const concurrency = Number(process.argv[2] || 16);
const SEED_AUTHORS = ["Ana", "Ben", "Chen", "Dara", "Eli"];

const gql = async (query, variables) => {
    const res = await fetch(`${API}/cms/manage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LT_API_KEY || env.API_KEY}` },
        body: JSON.stringify({ query, variables })
    });
    const body = await res.json();
    if (body.errors) {
        throw new Error(JSON.stringify(body.errors).slice(0, 300));
    }
    return body.data;
};

const ids = [];
let after = null;
for (;;) {
    const { listLoadArticles } = await gql(
        `query ($after: String) {
            listLoadArticles(limit: 1000, after: $after, sort: [id_ASC]) {
                data { entryId values { author } } meta { cursor hasMoreItems totalCount }
            }
        }`,
        { after }
    );
    for (const entry of listLoadArticles.data) {
        if (!SEED_AUTHORS.includes(entry.values.author)) {
            ids.push(entry.entryId);
        }
    }
    if (!listLoadArticles.meta.hasMoreItems) {
        console.log(`total ${listLoadArticles.meta.totalCount}, to delete ${ids.length}`);
        break;
    }
    after = listLoadArticles.meta.cursor;
}

const started = Date.now();
let next = 0;
let done = 0;
let failed = 0;
await Promise.all(
    Array.from({ length: concurrency }, async () => {
        while (next < ids.length) {
            const id = ids[next++];
            try {
                const { deleteLoadArticle } = await gql(
                    `mutation ($id: ID!) { deleteLoadArticle(revision: $id, options: { permanently: true }) { data error { message } } }`,
                    { id }
                );
                if (deleteLoadArticle.error) {
                    throw new Error(deleteLoadArticle.error.message);
                }
                done++;
            } catch (error) {
                if (++failed <= 5) {
                    console.error(`${id}: ${error.message}`);
                }
            }
            if ((done + failed) % 2000 === 0) {
                console.log(`${done + failed}/${ids.length}`);
            }
        }
    })
);
console.log(`deleted ${done}, failed ${failed}, ${Math.round((Date.now() - started) / 1000)} s`);
