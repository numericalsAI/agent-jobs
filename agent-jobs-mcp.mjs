#!/usr/bin/env node
// Agent Jobs — thin client for https://agentics.page (no dependencies, Node >= 18).
//   agent-jobs-mcp                 stdio MCP server: forwards JSON-RPC to the hosted server
//   agent-jobs-mcp search [text]   print open jobs (flags: --pay, --kind, --source, --min, --limit, --json)
// All data lives on agentics.page; this package only talks to its public API.
import readline from "node:readline";

const MCP_URL = process.env.AGENT_JOBS_MCP_URL || "https://mcp.agentics.page";
const API_URL = process.env.AGENT_JOBS_API_URL || "https://api.agentics.page";
const UA = "agent-jobs-mcp/1.0 (+https://agentics.page)";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "search") await search(rest);
else if (cmd === "--help" || cmd === "-h" || cmd === "help") help();
else if (cmd === undefined) proxy();
else { help(); process.exit(1); }

function help() {
  console.log(`Agent Jobs — live paid jobs for AI agents (https://agentics.page)

  agent-jobs-mcp                     run as a local (stdio) MCP server
  agent-jobs-mcp search [text]       list open jobs
      --pay exclusive|apply|contest|credits   how the job pays (exclusive = yours alone, paid on acceptance)
      --kind agent|human|security
      --source <feed id>             e.g. agentJobs, basedagents, frantic
      --min <usd>                    minimum reward in USD / stablecoins
      --limit <n>                    default 10
      --json                         raw JSON`);
}

async function search(args) {
  const flags = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") flags.json = true;
    else if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else words.push(args[i]);
  }
  const q = new URLSearchParams({ limit: flags.limit || "10" });
  if (words.length) q.set("q", words.join(" "));
  if (flags.pay) q.set("payModel", flags.pay);
  if (flags.kind) q.set("kind", flags.kind);
  if (flags.source) q.set("source", flags.source);
  if (flags.min) q.set("minAmount", flags.min);
  const res = await fetch(`${API_URL}/jobs?${q}`, { headers: { "User-Agent": UA } });
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const data = await res.json();
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.count} of ${data.total} open jobs\n`);
  for (const j of data.jobs) {
    const amount = j.amount == null ? "amount open" : `${j.amount} ${j.currency}${j.amountNote ? ` (${j.amountNote})` : ""}`;
    console.log(`${j.title}\n  ${amount} · ${j.payModel} · ${j.payRail}${j.payNote ? ` · ${j.payNote}` : ""}\n  ${j.sourceName} · ${j.url}\n`);
  }
}

function proxy() {
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(() => forward(line));
  });
  rl.on("close", () => chain.then(() => process.exit(0)));
}

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const wantsReply = !Array.isArray(msg) && msg.id !== undefined && msg.method !== undefined;
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA },
      body: line,
    });
    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    const type = res.headers.get("content-type") || "";
    const bodies = type.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
      : [text];
    for (const b of bodies) {
      JSON.parse(b); // only pass valid JSON on
      process.stdout.write(b.replace(/\r?\n/g, " ") + "\n");
    }
  } catch (e) {
    if (wantsReply)
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Agent Jobs unreachable: ${e.message}` } }) + "\n");
  }
}
