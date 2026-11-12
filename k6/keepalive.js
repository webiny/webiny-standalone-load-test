// The keep-alive race: Node closes an idle connection after 5 s (keepAliveTimeout's default), nginx
// keeps idle upstream connections for 60 s. A request nginx sends on a connection at the moment Node
// closes it fails with 502.
//
// One VU sends a CMS read every 2.4-2.6 s. nginx alternates the two API processes, so each upstream
// connection sits idle for about 5 s between requests: right at Node's timeout. Run once against
// nginx/nginx.conf (no upstream reuse) and once against nginx/nginx-keepalive.conf.
//   DURATION (default 10m)
import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

const API = __ENV.API_URL || "http://nginx:3002";
const headers = { "content-type": "application/json", authorization: `Bearer ${__ENV.API_KEY}` };
const bad = new Counter("non_200");

export const options = {
    scenarios: {
        idle_gaps: { executor: "constant-vus", vus: 1, duration: __ENV.DURATION || "10m" }
    }
};

export default function () {
    const res = http.post(
        `${API}/cms/read`,
        JSON.stringify({ query: "{ listLoadArticles(limit: 1) { data { id } } }" }),
        { headers, tags: { op: "list" } }
    );
    if (res.status !== 200) {
        bad.add(1, { status: String(res.status) });
        console.log(`${new Date().toISOString()} ${res.status} ${String(res.body).slice(0, 120)}`);
    }
    // SWEEP=1: step the pause through 2.46-2.53 s, so the per-connection idle gap walks across
    // Node's 5 s in 20 ms steps instead of landing at random.
    sleep(__ENV.SWEEP ? 2.46 + (__ITER % 8) * 0.01 : 2.4 + Math.random() * 0.2);
}
