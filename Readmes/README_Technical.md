# OpenRoadmap Planner — User Guide

OpenRoadmap Planner is a **local roadmap planning tool** consisting of:
- a small **Node.js server** (`server.js`)
- an interactive **browser UI** served at **http://localhost:3000**
- a local JSON database stored in `data/roadmap.json`

It is designed to help you:
- manage **System Nodes** (e.g. ARCH/SRV/CLI/GAM…)
- manage **Storyboard beats**
- draw and maintain **connections** between nodes
- optionally use an **Agent/Chat panel** to interact with the roadmap

---

## 1) Start the server

Use one of the three supported start modes:

- **Gateway mode (default):** `start-roadmap-gateway.bat`
- **ACP mode:** `start-roadmap-acp.bat`
- **Direct mode (OpenAI API):** `start-roadmap-direct.bat`

After start, open:
- **http://localhost:3000**

(Installation details are in `README-INSTALL.md`.)

---

## 2) What the server does

When running, the server:

1. **Serves the UI**
   - `GET /` returns the web app (HTML/JS/CSS)

2. **Stores roadmap data locally**
   - Database file: `data/roadmap.json`

3. **Provides a REST API** (used by the UI)
   - Nodes: `GET/POST /api/nodes`, `GET/PUT/DELETE /api/nodes/:id`, `PATCH /api/nodes/:id/move`
   - Storybeats: `GET/POST /api/storybeats`, `PUT/DELETE /api/storybeats/:id`, `PATCH /api/storybeats/:id/move`
   - Connections: `GET/POST/DELETE /api/connections`
   - Export: `GET /api/export`
   - Scan/import: `POST /api/scan`
   - Validation: `GET /api/validate`

4. **Imports roadmap files from the `scan/` folder**
   - Watches the `scan/` directory for changes.
   - Accepts `*.srd.json` files and merges them into the local database.

5. **Streams live updates to the UI (SSE)**
   - The UI connects to: `GET /api/events`
   - Used for live updates (DB changes, agent status, chat deltas).

6. **Runs the Agent (optional)**
   - The Agent is accessed via the UI’s **Agent panel**.
   - Depending on the selected backend (Gateway/ACP/Direct), the agent response is produced differently.
   - The server can also execute deterministic local “ACTION” operations to update the roadmap.

---

## 3) Using the Roadmap UI

### 3.1 Main tabs
- **Systeme**: graph view + sidebar list of nodes
- **Storyboard**: timeline list of story beats

### 3.2 Sidebar (System nodes)
- Use the **search box** to filter by title or REF-ID.
- Nodes are grouped by prefix (e.g. `ARCH-`, `SRV-`, `GAM-`).
- Clicking a node opens the **Detail Panel**.

Status badges:
- **OFFEN** (open)
- **ENTSCHIEDEN** (decided)
- **PRE-FORMULIERUNG** (pre-formulation)

### 3.3 Graph view (Systeme)
- The canvas shows nodes as dots and draws connections.
- Controls:
  - mouse wheel: zoom
  - drag with mouse: pan
  - `+` / `−`: zoom buttons
  - `⚙`: reset pan/zoom
- Click a dot to open its detail.

### 3.4 Detail Panel (editing a node)
For a selected node you can edit:
- **REF-ID**
- **Title**
- **Status**
- **Description**
- **Flags** (add via the input field)
- **Connections** (add a connection to another node by REF-ID)
- **Solution idea** (“Lösungsvorschlag” field)

Delete:
- Use **“Eintrag löschen”** to delete the node (confirmation required).

### 3.5 Create new entries
Click **“+ Neu”**:
- Create a **System-Node**
  - choose category prefix
  - set REF-ID (e.g. `GAM-015`)
  - title/description/status
  - optional flags
- Or create a **Storybeat**

### 3.6 Storyboard tab
- Shows story beats in a vertical timeline.
- Click a beat to edit:
  - title
  - type: `scene` or `cut`
  - order
  - description
  - game references
  - notes

---

## 4) Scan/import (`scan/` folder)

### 4.1 What scan does
- The server scans `scan/` for `*.srd.json` files.
- It merges these into `data/roadmap.json`.
- Nodes and beats receive a `sourceFile` attribute (the filename), which the UI can use for highlighting.

### 4.2 Trigger a scan
- Click **“Scan”** in the header, or
- Call `POST /api/scan`.

---

## 5) Agent panel (Chat)

Open the Agent panel using the **Agent** button in the header.

What you can do:
- Ask questions about the roadmap.
- Request changes (depending on backend configuration).
- Watch **live progress** in the ticker (busy/idle, current task, active/last refs).

### Important backend note (Gateway vs ACP)
- In **Gateway mode**, the server sends chat requests to the local OpenClaw Gateway.
  - This mode **does not guarantee MCP tool availability**.
- In **ACP mode**, the server runs the request through **ACPX**, which is the most reliable path when you need deterministic tool usage.
- In **Direct mode**, the server talks to the OpenAI API directly (requires `OPENAI_API_KEY`).

### Known limitation (OpenClaw OAuth / mode mismatch)
If you expected an OAuth-based workflow (or the specific non-OAuth mode that was originally desired):
- **OpenClaw currently does not support that exact mode for this workflow**, so tool availability may differ from expectations.

For best results:
- use **ACP mode** when you need tool-driven roadmap edits, or
- rely on the server’s deterministic local ACTION execution.

---

## 6) Export

Use the **Export** button to download a JSON export:
- `GET /api/export`

---

## 7) Safety / data scope

- This app is intended for **local use**.
- Default binding is `localhost` (browser connects to `http://localhost:3000`).
- Your roadmap data is stored in `data/roadmap.json`.

---

## 8) Quick checklist

- Server running? → http://localhost:3000
- Want to import files? → put `*.srd.json` in `scan/` and click **Scan**
- Want reliable tool-driven agent edits? → start with `start-roadmap-acp.bat`

