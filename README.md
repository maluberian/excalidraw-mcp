# Excalidraw MCP App Server

MCP server that streams hand-drawn Excalidraw diagrams with smooth viewport camera control and interactive fullscreen editing.

![Demo](docs/demo.gif)

## Install

Works with any client that supports [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) — Claude, ChatGPT, VS Code, Goose, and others. If something doesn't work, please [open an issue](https://github.com/antonpk1/excalidraw-mcp-app/issues).

### Local

Build from source:

```bash
git clone https://github.com/excalidraw/excalidraw-mcp.git
cd excalidraw-mcp
corepack pnpm install
corepack pnpm build
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-mcp-app/dist/index.js", "--stdio"]
    }
  }
}
```

Restart Claude Desktop.

## Usage

Example prompts:
- "Draw a cute cat using excalidraw"
- "Draw an architecture diagram showing a user connecting to an API server which talks to a database"

### Self-hosted Excalidraw room export

This fork can persist the current diagram directly into a self-hosted Excalidraw collaboration room by writing encrypted scene data into Firestore `scenes/{roomId}`.

Set these environment variables on the MCP server if you want the UI's share button to target your room by default:

```bash
EXCALIDRAW_SELF_HOSTED_ROOM_URL='https://excalidraw.example.net/#room=<roomId>,<roomKey>'
EXCALIDRAW_FIREBASE_CONFIG='{"apiKey":"...","projectId":"...","authDomain":"...","databaseURL":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}'
EXCALIDRAW_SELF_HOSTED_COLLAB_URL='https://excalidraw-collab.example.net'
```

Notes:

- `EXCALIDRAW_SELF_HOSTED_ROOM_URL` is optional for server-side tool calls, but required if you want the UI button to open a shared room instead of `excalidraw.com`.
- `EXCALIDRAW_FIREBASE_CONFIG` defaults to the current `sitesoftllc.net` deployment values in this fork. Override it if your room persistence backend differs.
- The current adapter writes scene elements to Firestore and also emits a live `SCENE_UPDATE` broadcast to the collaboration room.
- Removed elements are sent as tombstones during live sync so connected clients can reconcile deletions.
- Binary file/image persistence is still separate follow-up work.

## What are MCP Apps and how can I build one?

Text responses can only go so far. Sometimes users need to interact with data, not just read about it. [MCP Apps](https://github.com/modelcontextprotocol/ext-apps/) is an official Model Context Protocol extension that lets servers return interactive HTML interfaces (data visualizations, forms, dashboards) that render directly in the chat.

- **Getting started for humans**: [documentation](https://modelcontextprotocol.io/docs/extensions/apps)
- **Getting started for AIs**: [skill](https://github.com/modelcontextprotocol/ext-apps/blob/main/plugins/mcp-apps/skills/create-mcp-app/SKILL.md)

## Contributing

PRs welcome! See [Local](#local) above for build instructions.

### Docker

Build and run locally with Docker:

```bash
docker buildx build --platform linux/amd64 -t excalidraw-mcp:local --load .
docker run --rm -p 3001:3001 excalidraw-mcp:local
```

Endpoints:

- `GET /healthz`
- `POST /mcp`

### k3s / Kubernetes

Example manifests live in `deploy/k8s/` and assume:

- ingress hostname: `excalidraw-mcp.sitesoftllc.net`
- nginx ingress
- cert-manager issuer `letsencrypt-prod`

1. Build and push a multi-arch image to your local registry mirror.

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t REGISTRY_HOST/excalidraw-mcp:latest \
  --push .
```

2. Update [deploy/k8s/deployment.yaml](/home/openclaw/projects/excalidraw-mcp/deploy/k8s/deployment.yaml) so `image:` points at your local registry.
3. Apply the manifests:

```bash
kubectl apply -k deploy/k8s/
```

4. Confirm the service:

```bash
kubectl get pods -n excalidraw-mcp
kubectl get ingress -n excalidraw-mcp
```

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) — a virtual whiteboard for sketching hand-drawn like diagrams.

## License

MIT
