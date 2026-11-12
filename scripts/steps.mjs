// Per-step report from a k6 JSON output file (gzipped or not), written by k6/ramp.js runs.
//   node scripts/steps.mjs results/<run>/k6.json.gz [--md]
// For every step: achieved request rate, p50/p95/p99 and failure rate of the settled part of the
// step, status codes, and the most frequent error messages.
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";

const file = process.argv[2];
const markdown = process.argv.includes("--md");
let input = fs.createReadStream(file);
if (file.endsWith(".gz")) {
    input = input.pipe(zlib.createGunzip());
}

const steps = new Map();
const step = id => {
    if (!steps.has(id)) {
        steps.set(id, {
            durations: [],
            first: Infinity,
            last: 0,
            total: 0,
            settledFailed: 0,
            settledCount: 0,
            statuses: {},
            errors: {},
            ops: {}
        });
    }
    return steps.get(id);
};

const lines = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of lines) {
    if (!line.includes('"Point"')) {
        continue;
    }
    const point = JSON.parse(line);
    const tags = point.data.tags || {};
    if (!tags.step) {
        continue;
    }
    const s = step(Number(tags.step));
    const t = Date.parse(point.data.time);
    if (point.metric === "http_reqs") {
        s.total++;
        s.statuses[tags.status] = (s.statuses[tags.status] || 0) + 1;
        s.ops[tags.op] = (s.ops[tags.op] || 0) + 1;
        if (tags.settled) {
            s.first = Math.min(s.first, t);
            s.last = Math.max(s.last, t);
        }
    } else if (point.metric === "http_req_duration" && tags.settled) {
        s.durations.push(point.data.value);
    } else if (point.metric === "failed" && tags.settled) {
        s.settledCount++;
        s.settledFailed += point.data.value;
    } else if (point.metric === "gql_errors") {
        s.errors[tags.msg] = (s.errors[tags.msg] || 0) + 1;
    }
}

const pct = (sorted, p) =>
    sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]) : null;

const rows = [...steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, s]) => {
        const d = s.durations.sort((a, b) => a - b);
        const seconds = (s.last - s.first) / 1000;
        const errors = Object.entries(s.errors)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([msg, n]) => `${n}x ${msg}`)
            .join("; ");
        return {
            step: id,
            rps: seconds > 0 ? Math.round((d.length / seconds) * 10) / 10 : null,
            reqs: s.total,
            p50: pct(d, 50),
            p95: pct(d, 95),
            p99: pct(d, 99),
            max: d.length ? Math.round(d[d.length - 1]) : null,
            failedPct: s.settledCount ? Math.round((s.settledFailed / s.settledCount) * 10000) / 100 : null,
            statuses: Object.entries(s.statuses)
                .map(([k, v]) => `${k}:${v}`)
                .join(" "),
            errors
        };
    });

if (markdown) {
    console.log("| step | req/s | requests | p50 ms | p95 ms | p99 ms | max ms | failed % | statuses | top errors |");
    console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
    for (const r of rows) {
        console.log(
            `| ${r.step} | ${r.rps} | ${r.reqs} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.failedPct} | ${r.statuses} | ${r.errors.replaceAll("|", "/")} |`
        );
    }
} else {
    console.table(rows.map(({ errors, ...rest }) => rest));
    for (const r of rows.filter(r => r.errors)) {
        console.log(`step ${r.step}: ${r.errors}`);
    }
}
