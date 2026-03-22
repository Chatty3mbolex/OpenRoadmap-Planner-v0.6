# OpenRoadmap Planner — Installation (Windows)

This document explains **how to install and start OpenRoadmap Planner** using **default paths** and **no personal machine-specific values**.

## What you install
OpenRoadmap Planner is a **local Node.js web server + browser UI**.

- Server file: `server.js`
- UI: `public/index.html` (served by the server)
- Data storage: `data/roadmap.json` (created automatically)
- Import folder: `scan/` (drop `*.srd.json` files here)

Default URL after start: **http://localhost:3000**

---

## 1) Prerequisites

### 1.1 Install Node.js (required)
Install the current LTS version of Node.js for Windows.

After installation, open **PowerShell** and verify:
```powershell
node -v
```

---

## 2) Install OpenRoadmap Planner

1. Copy (or unzip) the program folder to a location of your choice, for example:
   - `C:\OpenRoadmap_Planner\`

2. Ensure these folders exist (they are included in the package, but the server will also create them when needed):
   - `data\`
   - `public\`
   - `scan\`

No `npm install` is required (the server uses built-in Node.js modules only).

---

## 3) Choose how the built-in Agent/Chat backend should run

OpenRoadmap Planner supports **three** start modes:

1) **Gateway mode (default)** — uses a local OpenClaw Gateway for chat
2) **ACP mode** — runs chat via **ACPX** (recommended if you need reliable MCP tool usage)
3) **Direct mode** — calls the OpenAI API directly from the server process

You can start any mode using the provided `*.bat` scripts.

---

## 4) Start Option A — Gateway mode (default)

### 4.1 Install OpenClaw (optional but required for Gateway mode)
If you want Gateway mode, install OpenClaw globally via npm:
```powershell
npm install -g openclaw
```

Verify:
```powershell
openclaw --version
```

### 4.2 Start the OpenClaw Gateway
Start OpenClaw’s gateway service (method depends on your OpenClaw setup). Typical commands:
```powershell
openclaw gateway start
openclaw gateway status
```

### 4.3 Start OpenRoadmap Planner in Gateway mode
From the program folder:
```powershell
.\start-roadmap-gateway.bat
```

Then open:
- http://localhost:3000

#### How authentication works in Gateway mode
The Roadmap server tries to read your local OpenClaw config from this **default path**:
- `%USERPROFILE%\.openclaw\openclaw.json`

It uses that file to locate:
- the Gateway port (default: `18500`)
- the Gateway auth token

If that file does not exist, Gateway mode cannot authenticate.

---

## 5) Start Option B — ACP mode (ACPX) (recommended for MCP/tool reliability)

### 5.1 Install ACPX
Install ACPX globally via npm:
```powershell
npm install -g acpx
```

Verify:
```powershell
acpx --version
```

On Windows, the default global npm binary folder is typically:
- `%APPDATA%\npm\`

So the ACPX shim is usually:
- `%APPDATA%\npm\acpx.cmd`

### 5.2 Install OpenClaw (required for ACP mode)
ACP mode uses `openclaw acp` under the hood:
```powershell
npm install -g openclaw
```

Verify:
```powershell
openclaw --version
```

### 5.3 Start OpenRoadmap Planner in ACP mode
From the program folder:
```powershell
.\start-roadmap-acp.bat
```

Then open:
- http://localhost:3000

#### Important note about OpenClaw / OAuth limitation
If your goal was to use an OAuth-based or “operator scope” flow in the way you originally planned:
- **OpenClaw currently does not support the exact non-OAuth mode that was intended for that workflow.**

Practical result:
- **Gateway mode does not guarantee MCP tool availability**.
- If you require deterministic tool execution, use **ACP mode** (or the server’s built-in local ACTION execution).

---

## 6) Start Option C — Direct mode (OpenAI API)

Direct mode connects to the OpenAI API **directly from the server**.

### 6.1 Set the API key (server-side)
In PowerShell (for the current terminal session):
```powershell
$env:OPENAI_API_KEY = "YOUR_KEY_HERE"
```

### 6.2 Start OpenRoadmap Planner in Direct mode
```powershell
.\start-roadmap-direct.bat
```

Then open:
- http://localhost:3000

Security note: The API key stays on the server side. Do not paste it into the browser.

---

## 7) (Optional) Install MCP server for OpenClaw

OpenRoadmap Planner includes an MCP server file:
- `roadmap-mcp.js`

It is designed to be spawned by OpenClaw/ACPX on demand and communicates with the Roadmap server over HTTP (default: `http://localhost:3000`).

If you use OpenClaw MCP configuration, register it as:
- command: `node`
- args: `<path-to-your-install>\roadmap-mcp.js`

Make sure the Roadmap server is running first.

---

## 8) Troubleshooting

### Port 3000 is already in use
The server attempts to gracefully shut down a previous instance via a localhost-only endpoint.
If it still fails, close the old terminal window or stop the other process using port 3000.

### Gateway mode fails: “Gateway Auth not found”
- Ensure OpenClaw is installed and the Gateway is running.
- Ensure `%USERPROFILE%\.openclaw\openclaw.json` exists.

### ACP mode fails: `acpx` not found
- Reinstall ACPX: `npm install -g acpx`
- Confirm `%APPDATA%\npm\` is in your PATH (Windows environment variables).

### Direct mode fails: `OPENAI_API_KEY is not set`
Set `OPENAI_API_KEY` in the environment before starting.

---

## 9) Uninstall

To uninstall OpenRoadmap Planner, delete the program folder.

To remove global tools (optional):
```powershell
npm uninstall -g acpx
npm uninstall -g openclaw
```
