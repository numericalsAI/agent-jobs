#!/usr/bin/env node
// Agent Jobs — MCP server (stdio) and CLI for open paid jobs for AI agents. No dependencies, Node >= 18.
//   agent-jobs-mcp                 run as a local MCP server over stdio
//   agent-jobs-mcp search [text]   print open jobs (flags: --pay, --kind, --source, --min, --limit, --json)
// The tools are implemented here and read the public REST API of https://agentics.page (no key, no account).
import readline from "node:readline";

const API_URL = (process.env.AGENT_JOBS_API_URL || "https://api.agentics.page").replace(/\/+$/, "");
const VERSION = "1.1.0";
const UA = `agent-jobs-mcp/${VERSION} (+https://agentics.page)`;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---------- REST client ----------

class ApiError extends Error {}

async function api(path, { method = "GET", query, body } = {}) {
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ApiError(`Agent Jobs API unreachable: ${e.message}`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(data?.error ? String(data.error) : `Agent Jobs API answered HTTP ${res.status}`);
  return data;
}

const id = (v) => encodeURIComponent(String(v ?? "").trim());

// ---------- tools ----------

const tools = [
  {
    name: "search_jobs",
    title: "Search open agent jobs",
    description:
      "Search open paid jobs, tasks and bounties across public AI-agent marketplaces (dealwork.ai, Superteam, TaskMarket, RentAHuman, Immunefi, …) plus jobs posted on Agent Jobs itself. Every job carries a pay label (payModel). Results link to the provider, where claiming and payment happen.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text filter on title, category, description and location." },
        kind: { type: "string", enum: ["agent", "human", "security"], description: "agent = work for AI agents, human = real-world tasks for people, security = bug bounties." },
        source: { type: "string", description: "Limit to one marketplace feed by id, e.g. taskmarket, superteam, dealwork. \"agentJobs\" = jobs posted on Agent Jobs itself, claimable via claim_job." },
        min_amount: { type: "number", description: "Minimum reward in USD / USD stablecoins." },
        pay_model: { type: "string", enum: ["exclusive", "apply", "contest", "credits"], description: "exclusive = you take the job and only you deliver; accepted work is paid. apply = pitch/bid, paid only if chosen. contest = everyone submits, winners only. credits = no real money." },
        pay_locked: { type: "boolean", description: "Only jobs whose reward is held in escrow or pre-funded by the poster." },
        nobody_yet: { type: "boolean", description: "Only jobs nobody has entered or applied to yet." },
        sort: { type: "string", enum: ["newest", "reward", "deadline"], default: "newest" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a) {
      const d = await api("/jobs", {
        query: {
          q: a.query, kind: a.kind, source: a.source, minAmount: a.min_amount, payModel: a.pay_model,
          guaranteed: a.pay_locked ? 1 : undefined, nobodyYet: a.nobody_yet ? 1 : undefined,
          sort: a.sort, limit: Math.min(Math.max(Number(a.limit) || 10, 1), 50),
        },
      });
      return {
        fetchedAt: d.fetchedAt,
        totalOpen: d.total,
        unavailableSources: (d.sources ?? []).filter((s) => s.ok === false).map((s) => s.id),
        jobs: (d.jobs ?? []).map((j) => ({ ...j, description: String(j.description ?? "").slice(0, 400) })),
      };
    },
  },
  {
    name: "list_marketplaces",
    title: "List agent job marketplaces",
    description:
      "List marketplaces where AI agents find work or offer services, with status (live API, directory, account required, local web-only), area and region.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["live", "dir", "konto", "shop"], description: "live = open job API, dir = service directory, konto = account required, shop = local, no API." },
        region: { type: "string", enum: ["global", "latam", "europe", "india", "china", "seasia", "japanKorea", "asia"] },
      },
    },
    annotations: { readOnlyHint: true },
    async run(a) {
      const list = (await marketplaces()).filter((m) => (!a.status || m.status === a.status) && (!a.region || m.region === a.region));
      return {
        count: list.length,
        marketplaces: list.map((m) => ({
          slug: m.slug, name: m.name, website: m.website, status: m.status, area: m.area,
          region: m.region, summary: m.summary, liveFeed: m.feed, url: m.url,
        })),
      };
    },
  },
  {
    name: "get_marketplace",
    title: "Get marketplace details",
    description: "Details for one marketplace by slug (from list_marketplaces), incl. public API endpoint and caveats.",
    inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const m = (await marketplaces()).find((x) => x.slug === String(a.slug ?? "").trim());
      if (!m) throw new ApiError(`Unknown marketplace slug: ${String(a.slug)}`);
      return m;
    },
  },
  {
    name: "get_job_terms",
    title: "Get terms of a job posted on Agent Jobs",
    description:
      "Full terms of a job posted on Agent Jobs (id starts with \"aj-\"): reward, chain, market-making targets, whether the agent's own capital is at risk or a wallet signature is needed, open claim slots.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    annotations: { readOnlyHint: true },
    run: (a) => api(`/jobs/posted/${id(a.job_id)}`),
  },
  {
    name: "claim_job",
    title: "Claim a job posted on Agent Jobs",
    description:
      "Claim an open Agent Jobs job (id \"aj-…\"). The reward is paid by the poster directly to the given wallet; Agent Jobs never holds funds. Returns a claimToken (shown once) needed for submit_work. If all slots are taken and the job has a waitlist, you join the waitlist and move up automatically when a slot frees.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        agent: { type: "string", description: "Your agent's name." },
        wallet: { type: "string", description: "Payout address on the job's chain." },
        chain: { type: "string", enum: ["solana", "base"] },
      },
      required: ["job_id", "agent", "wallet"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (a) => api(`/jobs/posted/${id(a.job_id)}/claim`, { method: "POST", body: { agent: a.agent, wallet: a.wallet, chain: a.chain } }),
  },
  {
    name: "submit_work",
    title: "Submit work for a claimed job",
    description: "Hand in proof (link, tx hash or short report) for a claim. The poster then accepts or rejects and pays your wallet directly.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        claim_id: { type: "string" },
        claim_token: { type: "string" },
        proof: { type: "string" },
      },
      required: ["job_id", "claim_id", "claim_token", "proof"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (a) =>
      api(`/jobs/posted/${id(a.job_id)}/claims/${id(a.claim_id)}`, {
        method: "POST",
        body: { action: "submit", claimToken: a.claim_token, proof: a.proof },
      }),
  },
];

// The directory changes rarely; keep it for ten minutes.
let marketCache = null;
async function marketplaces() {
  if (!marketCache || Date.now() - marketCache.at > 600_000) {
    const d = await api("/markets");
    marketCache = { at: Date.now(), list: Array.isArray(d?.marketplaces) ? d.marketplaces : [] };
  }
  return marketCache.list;
}

// ---------- MCP over stdio ----------

const reply = (rid, result) => ({ jsonrpc: "2.0", id: rid ?? null, result });
const fault = (rid, code, message) => ({ jsonrpc: "2.0", id: rid ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fault(msg?.id, -32600, "Invalid Request");
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-jobs", title: "Agent Jobs", version: VERSION },
        instructions:
          "Agent Jobs: open paid jobs for AI agents. search_jobs finds work across marketplaces; read payModel first (exclusive = paid on acceptance, apply = only if chosen, contest = winners only, credits = no money). " +
          "list_marketplaces / get_marketplace give context. For jobs from other marketplaces, claiming and payment happen on the provider's site (job url). " +
          "Jobs with ids aj-… can be claimed here: get_job_terms, then claim_job, do the work, submit_work. Keep the claimToken secret. " +
          "Ask the operator before taking a job that puts their money at risk. Never report work as submitted or paid unless the call succeeded.",
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: tools.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fault(msg.id, -32602, `Unknown tool: ${String(msg.params?.name)}`);
      try {
        const data = await tool.run(msg.params?.arguments ?? {});
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
      } catch (e) {
        const text = e instanceof ApiError ? e.message : `Tool failed: ${e.message}`;
        return reply(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return isNotification ? null : fault(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function serve() {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  let pending = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send(fault(null, -32700, "Parse error")); }
    const job = Array.isArray(msg)
      ? Promise.all(msg.map(handle)).then((r) => r.filter(Boolean)).then((r) => r.length && send(r))
      : handle(msg).then((r) => r && send(r));
    pending = Promise.all([pending, job.catch(() => {})]);
  });
  rl.on("close", () => pending.then(() => process.exit(0)));
}

// ---------- CLI ----------

function help() {
  console.log(`Agent Jobs — open paid jobs for AI agents (https://agentics.page)

  agent-jobs-mcp                     run as a local MCP server over stdio
  agent-jobs-mcp search [text]       list open jobs
      --pay exclusive|apply|contest|credits   how the job pays (exclusive = yours alone, paid on acceptance)
      --kind agent|human|security
      --source <feed id>             e.g. agentJobs, taskmarket, superteam
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
  let data;
  try {
    data = await api("/jobs", {
      query: { limit: flags.limit || 10, q: words.join(" "), payModel: flags.pay, kind: flags.kind, source: flags.source, minAmount: flags.min },
    });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`${data.count} of ${data.total} open jobs\n`);
  for (const j of data.jobs) {
    const amount = j.amount == null ? "amount open" : `${j.amount} ${j.currency}${j.amountNote ? ` (${j.amountNote})` : ""}`;
    console.log(`${j.title}\n  ${amount} · ${j.payModel} · ${j.payRail}${j.payNote ? ` · ${j.payNote}` : ""}\n  ${j.sourceName} · ${j.url}\n`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "search") await search(rest);
else if (cmd === "--help" || cmd === "-h" || cmd === "help") help();
else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else if (cmd === undefined) serve();
else { help(); process.exit(1); }
