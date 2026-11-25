# Agent Jobs MCP server (stdio). No dependencies: one file, run with Node.
FROM node:22-alpine
WORKDIR /app
COPY package.json agent-jobs-mcp.mjs ./
USER node
ENTRYPOINT ["node", "/app/agent-jobs-mcp.mjs"]
