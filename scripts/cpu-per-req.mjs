// API CPU-ms per request, per ramp step: mean API CPU (both processes, in cores) during the step's
// settled part divided by the step's request rate.
//   node scripts/cpu-per-req.mjs <results dir>
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";

const dir = process.argv[2];
const perSec = new Map();
const rl = readline.createInterface({
    input: fs.createReadStream(`${dir}/k6.json.gz`).pipe(zlib.createGunzip())
});
for await (const line of rl) {
    let j;
    try {
        j = JSON.parse(line);
    } catch {
        continue;
    }
    if (j.type !== "Point" || j.metric !== "http_reqs") {
        continue;
    }
    const t = Math.floor(Date.parse(j.data.time) / 1000);
    perSec.set(t, (perSec.get(t) || 0) + 1);
}
const t0 = Math.min(...perSec.keys());
const day = new Date(t0 * 1000).toISOString().slice(0, 10);

const cpu = new Map();
for (const row of fs.readFileSync(`${dir}/stats.csv`, "utf8").split("\n").slice(1)) {
    const [time, name, perc] = row.split(",");
    if (!/api-\d/.test(name || "")) {
        continue;
    }
    const t = Math.floor(Date.parse(`${day}T${time}Z`) / 1000);
    cpu.set(t, (cpu.get(t) || 0) + parseFloat(perc) / 100);
}

const steps = new Map();
for (const [t, cores] of cpu) {
    const step = Math.floor((t - t0) / 60) + 1;
    // Skip the first 15 s of each step (backlog from the step before).
    if ((t - t0) % 60 < 15) {
        continue;
    }
    let reqs = 0;
    for (let s = t - 5; s < t; s++) {
        reqs += perSec.get(s) || 0;
    }
    const e = steps.get(step) || { cores: 0, rate: 0, n: 0 };
    e.cores += cores;
    e.rate += reqs / 5;
    e.n++;
    steps.set(step, e);
}
console.log("step | req/s | API cores | CPU ms/req");
for (const [step, e] of [...steps].sort((a, b) => a[0] - b[0])) {
    const cores = e.cores / e.n;
    const rate = e.rate / e.n;
    console.log(`${step} | ${rate.toFixed(0)} | ${cores.toFixed(2)} | ${((cores * 1000) / rate).toFixed(1)}`);
}
