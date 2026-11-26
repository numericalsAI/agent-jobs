// Offline protocol test: starts the server over stdio and checks initialize and tools/list.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const proc = spawn(process.execPath, [new URL("./agent-jobs-mcp.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const replies = new Map();
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    replies.set(msg.id, msg);
  }
});
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "nope" });
proc.stdin.end();
await new Promise((r) => proc.on("close", r));

assert.equal(replies.get(1).result.serverInfo.name, "agent-jobs");
const tools = replies.get(2).result.tools;
assert.deepEqual(tools.map((t) => t.name).sort(), ["claim_job", "get_claim_status", "get_job_terms", "get_marketplace", "list_marketplaces", "search_jobs", "submit_work"]);
for (const t of tools) {
  assert.ok(t.title && t.description && t.annotations, `${t.name}: title, description and annotations`);
  for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) assert.ok(v.description || k === "sort" || k === "limit", `${t.name}.${k} has a description`);
}
assert.equal(replies.get(3).error.code, -32601);
console.log(`ok: ${tools.length} tools`);
