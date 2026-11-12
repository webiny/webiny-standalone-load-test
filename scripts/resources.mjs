// What the containers and API processes did during a run, per minute, next to the k6 steps.
//   node scripts/resources.mjs results/<run>
// From stats.csv: CPU (% of one core) and memory per container. From pg.csv: Postgres connections
// by state. From logs/api-*.log: RSS and event-loop lag (LTMON lines). Also p95 per k6 `op` per step.
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";
import path from "node:path";

const dir = process.argv[2];
const minute = t => t.slice(0, 5); // HH:MM

const table = (title, rows, cols) => {
    console.log(`\n${title}\n`);
    console.log(`| ${cols.join(" | ")} |`);
    console.log(`| ${cols.map(() => "---").join(" | ")} |`);
    for (const r of rows) {
        console.log(`| ${cols.map(c => r[c] ?? "").join(" | ")} |`);
    }
};
const avg = list => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : "");
const max = list => (list.length ? Math.max(...list) : "");

// docker stats
const stats = {};
for (const line of fs.readFileSync(path.join(dir, "stats.csv"), "utf8").split("\n").slice(1)) {
    const [time, name, cpu, mem] = line.split(",");
    if (!name) continue;
    const short = name.replace(/^webiny-standalone-load-test-(sqlite-)?/, "").replace(/-1$/, "");
    const m = minute(time);
    stats[m] ??= {};
    stats[m][short] ??= { cpu: [], mem: [] };
    stats[m][short].cpu.push(parseFloat(cpu));
    stats[m][short].mem.push(parseFloat(mem));
}
const containers = ["api", "api-1", "api-2", "postgres", "nginx", "valkey"].filter(c =>
    Object.values(stats).some(s => s[c])
);
table(
    "CPU, % of one core (avg / max per minute)",
    Object.entries(stats).map(([m, s]) => ({
        minute: m,
        ...Object.fromEntries(containers.map(c => [c, s[c] ? `${avg(s[c].cpu)} / ${max(s[c].cpu)}` : ""]))
    })),
    ["minute", ...containers]
);

// Postgres connections
const pg = {};
for (const line of fs.readFileSync(path.join(dir, "pg.csv"), "utf8").split("\n").slice(1)) {
    const [time, state, wait, count] = line.split(",");
    if (!time) continue;
    const m = minute(time);
    pg[m] ??= {};
    const key = `${state}${wait ? `(${wait})` : ""}`;
    pg[m][key] ??= [];
    pg[m][key].push(Number(count));
}
const pgKeys = [...new Set(Object.values(pg).flatMap(Object.keys))].sort();
table(
    "Postgres connections by state (max per minute)",
    Object.entries(pg).map(([m, s]) => ({ minute: m, ...Object.fromEntries(pgKeys.map(k => [k, max(s[k] || [])])) })),
    ["minute", ...pgKeys]
);

// LTMON
const mon = {};
const procs = fs.readdirSync(path.join(dir, "logs")).filter(f => /^api(-\d)?\.log$/.test(f)).map(f => f.slice(0, -4));
for (const proc of procs) {
    const file = path.join(dir, "logs", `${proc}.log`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const at = line.indexOf("LTMON ");
        if (at < 0) continue;
        const d = JSON.parse(line.slice(at + 6));
        const m = d.t.slice(11, 16);
        mon[m] ??= {};
        mon[m][proc] ??= { rss: [], p99: [], max: [] };
        mon[m][proc].rss.push(d.rssMb);
        mon[m][proc].p99.push(d.eldP99Ms);
        mon[m][proc].max.push(d.eldMaxMs);
    }
}
table(
    "API processes: RSS MB (max), event-loop lag p99 ms (max of 5 s windows), lag max ms",
    Object.entries(mon).map(([m, s]) => ({
        minute: m,
        ...Object.fromEntries(
            procs.flatMap(p =>
                s[p] ? [[`${p} rss`, max(s[p].rss)], [`${p} lag p99`, max(s[p].p99)], [`${p} lag max`, max(s[p].max)]] : []
            )
        )
    })),
    ["minute", ...procs.flatMap(p => [`${p} rss`, `${p} lag p99`, `${p} lag max`])]
);

// p95 per op per step
const k6file = path.join(dir, "k6.json.gz");
if (fs.existsSync(k6file)) {
    const byStep = {};
    const lines = readline.createInterface({ input: fs.createReadStream(k6file).pipe(zlib.createGunzip()) });
    for await (const line of lines) {
        if (!line.includes('"http_req_duration"') || !line.includes('"Point"')) continue;
        const p = JSON.parse(line);
        const t = p.data.tags;
        if (!t.settled || !t.op) continue;
        byStep[t.settled] ??= {};
        (byStep[t.settled][t.op] ??= []).push(p.data.value);
    }
    const ops = [...new Set(Object.values(byStep).flatMap(Object.keys))].sort();
    const p95 = list => {
        const s = list.sort((a, b) => a - b);
        return Math.round(s[Math.floor(0.95 * (s.length - 1))]);
    };
    table(
        "p95 ms per operation per step (settled part)",
        Object.entries(byStep)
            .sort(([a], [b]) => a - b)
            .map(([step, s]) => ({ step, ...Object.fromEntries(ops.map(o => [o, s[o] ? `${p95(s[o])} (n=${s[o].length})` : ""])) })),
        ["step", ...ops]
    );
}
