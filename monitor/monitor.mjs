// Preloaded into every API process with `node --import`. Prints one JSON line every
// MONITOR_INTERVAL_MS (default 5000) to stdout, prefixed with LTMON, so `docker compose logs`
// carries memory and event-loop lag next to the API's own output.
import { monitorEventLoopDelay } from "node:perf_hooks";

const interval = Number(process.env.MONITOR_INTERVAL_MS || 5000);
const resolutionMs = 10;
const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
histogram.enable();

// The histogram measures how late each 10 ms timer fires plus the 10 ms itself; report only the
// lateness.
const ms = ns => Math.max(0, Math.round((ns / 1e6 - resolutionMs) * 10) / 10);

const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const line = {
        t: new Date().toISOString(),
        proc: process.env.LT_PROC_NAME || String(process.pid),
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        externalMb: Math.round(mem.external / 1048576),
        eldP50Ms: ms(histogram.percentile(50)),
        eldP99Ms: ms(histogram.percentile(99)),
        eldMaxMs: ms(histogram.max),
        handles: process.getActiveResourcesInfo().length
    };
    histogram.reset();
    process.stdout.write(`LTMON ${JSON.stringify(line)}\n`);
}, interval);
timer.unref();
