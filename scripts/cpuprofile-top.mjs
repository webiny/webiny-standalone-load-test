// Top functions by self time, and by package, from a .cpuprofile.
//   node scripts/cpuprofile-top.mjs <file.cpuprofile> [n=30] [build/api dir]
// With the build folder, bundled frames are mapped back to their source file through the .map
// files next to each chunk, and grouped by package.
import fs from "node:fs";
import path from "node:path";
import { SourceMap } from "node:module";

const buildDir = process.argv[4];
const maps = new Map();
const original = (url, line, column) => {
    if (!buildDir || !url.startsWith("file:///app/")) return null;
    const file = url.slice("file:///app/".length);
    if (!maps.has(file)) {
        const mapFile = path.join(buildDir, `${file}.map`);
        maps.set(file, fs.existsSync(mapFile) ? new SourceMap(JSON.parse(fs.readFileSync(mapFile, "utf8"))) : null);
    }
    const map = maps.get(file);
    const entry = map?.findEntry(line, column);
    return entry?.originalSource ? entry : null;
};
const packageOf = source => {
    const clean = source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(\.\.\/)+/, "");
    const m = clean.match(/(?:node_modules\/)((?:@[^/]+\/)?[^/]+)/) || clean.match(/packages\/([^/]+)/);
    return m ? m[1] : clean.split("/").slice(0, 2).join("/");
};

const profile = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const n = Number(process.argv[3] || 30);
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
    self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (dt[i] || 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const byFn = new Map();
const byPkg = new Map();
for (const [id, us] of self) {
    const { functionName, url, lineNumber, columnNumber } = byId.get(id).callFrame;
    const file = url.replace(/^file:\/\/\/app\//, "");
    const src = original(url, lineNumber, columnNumber);
    const where = src
        ? `${src.originalSource.replace(/^webpack:\/\/[^/]*\//, "")}:${src.originalLine + 1}`
        : `${file}:${lineNumber + 1}`;
    const key = `${functionName || "(anonymous)"} ${where}`;
    byFn.set(key, (byFn.get(key) || 0) + us);
    const pkg = src ? packageOf(src.originalSource) : url ? file.split("/").slice(0, file.startsWith("node_modules") ? 3 : 1).join("/") : functionName;
    byPkg.set(pkg, (byPkg.get(pkg) || 0) + us);
}
const pct = us => `${((us / total) * 100).toFixed(1)}%`;
console.log(`total sampled: ${(total / 1e6).toFixed(1)} s`);
console.log("\nby package / builtin:");
for (const [k, us] of [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${pct(us).padStart(6)}  ${k}`);
console.log("\nby function (self time):");
for (const [k, us] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`  ${pct(us).padStart(6)}  ${k}`);
