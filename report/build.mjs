// Renders REPORT.md to a print-styled HTML file next to it: node report/build.mjs
// Then print it to PDF: agent-browser open file://<repo>/report/report.html && agent-browser pdf REPORT.pdf
// Image paths in REPORT.md resolve against the repository root (<base href>).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = fs.readFileSync(path.join(root, "REPORT.md"), "utf8");
const body = marked.parse(md, { gfm: true });

const css = `
@page { size: A4; margin: 18mm 16mm 18mm 16mm; }
:root { --ink: #1d2433; --muted: #5b6475; --line: #e3e6ec; --accent: #fa5723; --soft: #f6f7f9; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; }
.cover { border-left: 5px solid var(--accent); padding: 4px 0 4px 16px; margin-bottom: 22px; }
.cover .kicker { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
.cover .meta { color: var(--muted); font-size: 9.5pt; margin-top: 4px; }
h1 { font-size: 22pt; line-height: 1.2; margin: 2px 0 0; }
h2 { font-size: 14.5pt; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--line); page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 18px 0 6px; color: #2c3446; page-break-after: avoid; }
p, ul { margin: 6px 0 10px; }
li { margin: 2px 0; }
strong { color: #111827; }
a { color: inherit; text-decoration: none; }
img { display: block; width: 100%; margin: 10px 0 12px; page-break-inside: avoid; }
code { font: 8.8pt/1.4 "SF Mono", Menlo, Consolas, monospace; background: var(--soft); border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; word-break: break-word; }
pre { background: var(--soft); border: 1px solid var(--line); border-radius: 5px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; page-break-inside: avoid; font-size: 8.3pt; line-height: 1.12; }
pre code { background: none; border: 0; padding: 0; font-size: 8.3pt; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 9pt; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { background: #eef0f4; text-align: left; font-weight: 600; }
th, td { border: 1px solid var(--line); padding: 4px 6px; vertical-align: top; }
tbody tr:nth-child(even) td { background: #fafbfc; }
td code, th code { font-size: 8pt; }
`;

const html = `<!doctype html><html><head><meta charset="utf-8"><base href="file://${root}/"><title>Webiny standalone under load</title><style>${css}</style></head>
<body>
<div class="cover">
  <div class="kicker">Load test report</div>
  <div class="meta">webiny-js 6f462b597f (next) and 6.6.0-alpha.10 · standalone hosting on AWS EC2 · ${new Date().toISOString().slice(0, 10)}</div>
</div>
${body}
</body></html>`;
fs.writeFileSync(path.join(root, "report", "report.html"), html);
