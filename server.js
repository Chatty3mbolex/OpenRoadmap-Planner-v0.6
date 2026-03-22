#!/usr/bin/env node
/*
  OpenRoadmap Planner

  SPDX-License-Identifier: GPL-3.0-or-later

  Copyright (C) 2026 Rick Kühnreich (Embolex)

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.

  Repository: https://github.com/Chatty3mbolex/OpenRoadmap-Planner-v0.6

  Credits / Contributors:
  - Rick Kühnreich (Embolex)
  - OpenClaw Agent (gpt-5.2-codex) — special thanks
  - OpenAI ChatGPT 5.2-codex (assistance)
  - Anthropic Claude (assistance)
*/

// OpenRoadmap Roadmap Server v2.0 â€” Zero-Dependency Node.js Server
// Original-Design ERHALTEN + SSE, Chat-Bridge, Agent-Ticker, Move, Work-Markierungen
// Autoscans /scan folder for .srd files (OpenRoadmap Roadmap Data)
// Serves interactive roadmap UI on http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const https = require('https');

// Chat backend selection:
// - "gateway" (default): POST /v1/responses to the local OpenClaw Gateway
// - "acp": spawn an ACP client (acpx openclaw ...) so MCP tools can be used deterministically
// - "direct": call OpenAI Responses API directly from this server process (no OpenClaw/ACPX tokens involved)
//
// IMPORTANT: the gateway /v1/responses path does NOT guarantee MCP tool availability.
// If you want roadmap_mark_working + full CRUD tooling via MCP, use "acp".
const CHAT_BACKEND = String(process.env.ROADMAP_CHAT_BACKEND || 'gateway').toLowerCase();

// DIRECT backend (OpenAI Responses API)
// Best-practice: keep the API key server-side. Do NOT pass it to the browser.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_PROJECT_KEY || process.env.OPENAI_KEY || '';
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const OPENAI_MODEL = String(process.env.ROADMAP_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini');

// Throttle LLM requests to avoid hammering providers / rate-limits.
// User requirement: 5s minimum gap between LLM requests.
const MIN_LLM_INTERVAL_MS = Number(process.env.ROADMAP_LLM_MIN_INTERVAL_MS || 5000);
let lastLlmRequestAtMs = 0;

async function enforceLlmMinInterval() {
  const now = Date.now();
  const waitMs = Math.max(0, MIN_LLM_INTERVAL_MS - (now - lastLlmRequestAtMs));
  if (waitMs > 0) await delay(waitMs);
  lastLlmRequestAtMs = Date.now();
}

function getOpenClawGatewayAuth() {
  // Best-effort read of the local OpenClaw config so the Roadmap server can
  // authenticate directly against the local Gateway HTTP API without hardcoding secrets.
  try {
    const profileRoot = process.env.USERPROFILE || process.env.HOME || '';
    const cfgPath = path.join(profileRoot, '.openclaw', 'openclaw.json');
    if (!cfgPath || !fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const port = Number(cfg?.gateway?.port || 18500);
    const token = cfg?.gateway?.auth?.token || null;
    const mainKey = cfg?.session?.mainKey || 'main';
    return {
      port,
      token,
      wsUrl: `ws://127.0.0.1:${port}`,
      httpBase: `http://127.0.0.1:${port}`,
      model: `openclaw:${mainKey}`
    };
  } catch (e) {
    return null;
  }
}

// --- Single-instance startup guard (no PID searching)
// If another roadmap server is already bound to PORT, we ask it to shut down via localhost-only HTTP,
// then start fresh. This avoids accumulating multiple Node instances in Task Manager.
function requestShutdownExistingServer(port) {
  return new Promise(resolve => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/admin/shutdown',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 750,
      },
      res => {
        // Drain response.
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.write(JSON.stringify({ reason: 'new instance startup' }));
    req.end();
  });
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SCAN_DIR = path.join(__dirname, 'scan');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'roadmap.json');
const AGENT_STATE_FILE = path.join(DATA_DIR, 'agent-state.json');

// â”€â”€â”€ DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  const empty = {
    meta: { version: '0.10.0', projectName: 'OpenRoadmap Planner', lastScan: null },
    categories: [],
    nodes: [],
    storybeats: [],
    connections: [],
    flags: [],
    scanLog: []
  };
  saveDB(empty);
  return empty;
}

function saveDB(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data || db, null, 2), 'utf8');
}

let db = loadDB();

// â”€â”€â”€ MIME TYPES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

// â”€â”€â”€ SSE (Server-Sent Events) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sseClients = new Set();

function emitSSE(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  }
}

function emitDbChanged(reason, extra) {
  emitSSE('db.changed', { at: new Date().toISOString(), reason, ...extra });
}

// â”€â”€â”€ AGENT STATE + CHAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const chatHistory = [];
let activeProc = null;
let tickTimer = null;


function appendAssistantDelta(message, delta) {
  if (!delta) return;
  const d = String(delta);

  // Keep a raw transcript for action extraction/execution.
  message.rawText = (message.rawText || '') + d;

  // Hide action blocks from the human-visible transcript.
  // We still execute them server-side via executeAssistantActionsFromMessage().
  const visible = d
    .replace(/```action\s*[\s\S]*?```/gi, '')
    .replace(/^\s*ACTION\s*:\s*\{.*\}\s*$/gmi, '');

  if (!visible) return;
  message.text += visible;
  emitSSE('chat.delta', { id: message.id, delta: visible });
}

function appendAssistantError(message, errorText) {
  const safe = String(errorText || '').trim();
  if (!safe) return;
  appendAssistantDelta(message, `
[error]
${safe}
`);
}

function finishAgentRun(code, errorMessage) {
  agentState.busy = false;
  agentState.currentTask = '';
  if (errorMessage) agentState.lastError = String(errorMessage).trim().slice(-5000);
  stopTick();
  saveAgentState();
  emitSSE('agent.state', agentState);
  if (errorMessage) emitSSE('agent.error', { message: errorMessage });
  emitSSE('agent.done', { code });
  activeProc = null;
}

// ============================================================
// LOCAL ACTION EXECUTION (no MCP/operator scopes required)
//
// Goal: allow live chat via Gateway /v1/responses while still performing
// deterministic roadmap mutations locally in this server.
//
// Protocol (assistant output): include one or more JSON action blocks.
// We accept either:
//   1) A fenced block:   ```action\n{...}\n```
//   2) A line prefix:    ACTION: {...}
//
// Each action must contain: {"op":"<toolName>", ...args }
// where <toolName> matches directToolCall() handlers (roadmap_*).
// ============================================================

const ACTIONS_ENABLED = String(process.env.ROADMAP_ACTIONS_ENABLED || '1') !== '0';

// SYSTEM PROMPT for the "gateway" backend to make the model reliably emit action blocks.
// This prompt MUST be concise and deterministic. It is enforced server-side (not user-editable from the browser).
function buildRoadmapActionToolCatalogText() {
  // Derive a concise, always-up-to-date tool catalog from the same schema used elsewhere.
  // This avoids documentation drift between "what the server can do" and "what the agent thinks exists".
  try {
    const specs = (typeof roadmapToolSpecs === 'function') ? roadmapToolSpecs() : [];
    const lines = [];
    lines.push('VerfÃ¼gbare ACTION ops (serverseitig ausgefÃ¼hrt):');
    for (const t of (specs || [])) {
      const fn = t?.function;
      if (!fn?.name) continue;
      const req = Array.isArray(fn.parameters?.required) ? fn.parameters.required : [];
      const reqStr = req.length ? ` required: ${req.join(', ')}` : '';
      const desc = String(fn.description || '').trim();
      lines.push(`- ${fn.name}${reqStr}${desc ? ` â€” ${desc}` : ''}`);
    }
    return lines.join('\n');
  } catch {
    return 'VerfÃ¼gbare ACTION ops: (Katalog konnte nicht generiert werden)';
  }
}

const ROADMAP_AGENT_SYSTEM_PROMPT = String(process.env.ROADMAP_AGENT_SYSTEM_PROMPT || '').trim() || [
  'Du bist ein Live-Agent im OpenRoadmap Roadmap Webchat.',
  '',
  'Ziel: Aus natÃ¼rlicher Sprache Roadmap-Aktionen ableiten, ausfÃ¼hren und Ergebnis berichten.',
  '',
  'WICHTIG: Du darfst Roadmap-Ã„nderungen nur Ã¼ber ACTION-BlÃ¶cke ausfÃ¼hren.',
  'Ein ACTION-Block hat exakt dieses Format (3 Zeilen, sonst nichts im Block):',
  '```action',
  '{"op":"roadmap_<name>", ...}',
  '```',
  '',
  'Regeln:',
  '- Erkenne Catchphrases/Intent aus dem GesprÃ¤ch (z.B. "SRV-001 Status auf entschieden").',
  '- Plane selbststÃ¤ndig: (1) kurz prÃ¼fen/lesen falls nÃ¶tig, (2) mutieren, (3) Ergebnis bestÃ¤tigen.',
  '- Rate nie. Wenn dir Infos fehlen: nutze zuerst read-only ops wie roadmap_get_node oder roadmap_list_nodes.',
  '- WICHTIG (Read-Back): Wenn du read-only ops nutzt (roadmap_get_node, roadmap_list_nodes, roadmap_list_connections, roadmap_get_db_summary, roadmap_list_storybeats), gib die zurÃ¼ckgelieferten Daten danach IMMER direkt als Klartext-Zusammenfassung aus (mindestens Titel/Status/Beschreibung/Refs). Verlasse dich NICHT darauf, dass der Server Tool-Resultate automatisch im Chat anzeigt.',
  '- WICHTIG (Output): Gib im sichtbaren Chattext KEINE ACTION-BlÃ¶cke wieder und wiederhole sie nicht. Nach den ACTION-BlÃ¶cken: schreibe nur 1 kurzen Satz. Eine ausfÃ¼hrliche Zusammenfassung der Tool-Ergebnisse hÃ¤ngt der Server automatisch an.',
  '- Mutationen nur wenn der User es explizit will. Dann: genau die nÃ¶tigen roadmap_* ops als ACTION-BlÃ¶cke.',
  '- Status-Werte sind exakt: OFFEN | ENTSCHIEDEN | PRE-FORMULIERUNG (GroÃŸschreibung beibehalten).',
  '- Nach den ACTION-BlÃ¶cken: kurze Antwort in normalem Text (was geÃ¤ndert wurde).',
  '- Maximal 12 Actions pro Antwort. Wenn mehr: in Etappen arbeiten.',
  '',
  buildRoadmapActionToolCatalogText(),
].join('\n');

function extractActionJsonBlocks(text) {
  const out = [];
  const s = String(text || '');

  // ```action ... ``` blocks
  {
    // Multi-line fenced blocks
    const re = /```action\s*\n([\s\S]*?)\n```/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const raw = String(m[1] || '').trim();
      if (raw) out.push(raw);
    }
  }

  // ```action { ... }``` single-line fenced blocks (some models emit this)
  {
    const re = /```action\s*(\{[\s\S]*?\})\s*```/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const raw = String(m[1] || '').trim();
      if (raw) out.push(raw);
    }
  }

  // ACTION: {...} single-line
  {
    const re = /^\s*ACTION\s*:\s*(\{.*\})\s*$/gmi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const raw = String(m[1] || '').trim();
      if (raw) out.push(raw);
    }
  }

  // De-duplicate blocks (models sometimes emit the same action twice or
  // our regexes can catch near-identical blocks). Keep order.
  const seen = new Set();
  const uniq = [];
  for (const x of out) {
    const k = String(x || '').trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  return uniq;
}

function parseAction(raw) {
  try {
    const obj = JSON.parse(String(raw || ''));
    if (!obj || typeof obj !== 'object') return null;
    const op = String(obj.op || '').trim();
    if (!op) return null;
    const { op: _op, ...args } = obj;
    return { op, args };
  } catch {
    return null;
  }
}

async function executeAssistantActionsFromMessage(assistantMsg) {
  if (!ACTIONS_ENABLED) return { executed: 0, results: [] };
  // Actions are extracted from the RAW transcript (which contains the action blocks).
  const blocks = extractActionJsonBlocks(assistantMsg?.rawText || assistantMsg?.text || '');
  if (!blocks.length) return { executed: 0, results: [] };

  // Build required-args map from the canonical tool specs.
  const requiredByOp = new Map();
  try {
    const specs = (typeof roadmapToolSpecs === 'function') ? roadmapToolSpecs() : [];
    for (const t of (specs || [])) {
      const fn = t?.function;
      if (!fn?.name) continue;
      const req = Array.isArray(fn.parameters?.required) ? fn.parameters.required : [];
      requiredByOp.set(fn.name, req);
    }
  } catch {
    // If this fails, we just skip required-field validation.
  }

  const results = [];
  let executed = 0;

  // Hard limits: prevent spam / runaway execution.
  const MAX_ACTIONS = 12;
  for (const raw of blocks.slice(0, MAX_ACTIONS)) {
    const act = parseAction(raw);
    if (!act) {
      results.push({ ok: false, error: 'invalid_action_json' });
      continue;
    }

    // Allowlist: only roadmap_* operations.
    if (!act.op.startsWith('roadmap_')) {
      results.push({ ok: false, op: act.op, error: 'op_not_allowed' });
      continue;
    }

    // Required field validation (best-effort): prevents silent no-ops.
    const req = requiredByOp.get(act.op);
    if (Array.isArray(req) && req.length) {
      const missing = [];
      for (const k of req) {
        if (act.args == null || act.args[k] === undefined || act.args[k] === null || String(act.args[k]).trim() === '') {
          missing.push(k);
        }
      }
      if (missing.length) {
        results.push({ ok: false, op: act.op, error: `missing_required: ${missing.join(', ')}` });
        continue;
      }
    }

    try {
      // Mark activity BEFORE mutation so the UI glows on the exact file we're about to touch.
      const refs = [];
      if (typeof act.args?.refId === 'string') refs.push(act.args.refId);
      if (typeof act.args?.fromId === 'string') refs.push(act.args.fromId);
      if (typeof act.args?.toId === 'string') refs.push(act.args.toId);
      if (typeof act.args?.id === 'string') refs.push(act.args.id);
      const activeFiles = resolveFilesForAction(act.op, act.args);
      if (refs.length || activeFiles.length) markWorking(refs, activeFiles);

      const r = await directToolCall(act.op, act.args);
      executed += 1;
      results.push({ ok: true, op: act.op, result: r });

      // When finished, promote files to "last" (keep only 3 recent).
      if (activeFiles.length) promoteLastFiles(activeFiles);

      // Also promote refs to "last" (keep only 3 recent). This enables point-by-point glow.
      if (refs.length) promoteLastRefs(refs);
    } catch (e) {
      results.push({ ok: false, op: act.op, error: e?.message || String(e) });
    }
  }

  // Append a deterministic server-side footer so the user sees what actually happened.
  // This does NOT call any model.
  function clip(s, n) {
    const t = String(s == null ? '' : s);
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + 'â€¦';
  }

  function joinList(arr, max = 10) {
    const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
    if (!a.length) return '';
    const head = a.slice(0, max).join(', ');
    const rest = a.length > max ? ` (+${a.length - max})` : '';
    return head + rest;
  }

  function summarizeNode(n) {
    if (!n || typeof n !== 'object') return '';
    const ref = n.refId || n.id || 'unknown';
    const title = n.title ? ` â€” ${n.title}` : '';
    const status = n.status ? ` [${n.status}]` : '';
    const desc = n.description ? `\n  ${clip(n.description, 240)}` : '';
    const deps = joinList(n.dependsOn);
    const prov = joinList(n.provides);
    const emits = joinList(n.emits);
    const listens = joinList(n.listensTo);
    const flags = joinList(n.flags);
    const lines = [];
    lines.push(`${ref}${status}${title}`);
    if (desc) lines.push(desc);
    if (deps) lines.push(`\n  dependsOn: ${deps}`);
    if (prov) lines.push(`\n  provides: ${prov}`);
    if (emits) lines.push(`\n  emits: ${emits}`);
    if (listens) lines.push(`\n  listensTo: ${listens}`);
    if (flags) lines.push(`\n  flags: ${flags}`);
    return lines.join('');
  }

  function summarizeActionResult(op, result) {
    // Normalize common "{error:" patterns.
    if (result && typeof result === 'object' && typeof result.error === 'string' && result.error.trim()) {
      return `error: ${clip(result.error.trim(), 500)}`;
    }

    switch (op) {
      case 'roadmap_get_node':
      case 'roadmap_create_node':
      case 'roadmap_update_node':
      case 'roadmap_move_node': {
        return summarizeNode(result);
      }

      case 'roadmap_list_nodes': {
        const nodes = Array.isArray(result) ? result : [];
        if (!nodes.length) return '(no nodes)';
        const lines = nodes.slice(0, 20).map(n => `${n.refId || '??'} [${n.status || '?'}] â€” ${n.title || ''}`.trim());
        const rest = nodes.length > 20 ? `\n  â€¦ (+${nodes.length - 20} more)` : '';
        return lines.map(x => `  - ${x}`).join('\n') + rest;
      }

      case 'roadmap_list_connections': {
        const conns = Array.isArray(result) ? result : [];
        if (!conns.length) return '(no connections)';
        const lines = conns.slice(0, 30).map(c => `${c.fromId} -[${c.type}]-> ${c.toId}${c.label ? ` (${c.label})` : ''}`);
        const rest = conns.length > 30 ? `\n  â€¦ (+${conns.length - 30} more)` : '';
        return lines.map(x => `  - ${x}`).join('\n') + rest;
      }

      case 'roadmap_get_db_summary':
      case 'roadmap_validate_refs':
      case 'roadmap_scan': {
        // These are small objects; emit compact JSON.
        return clip(JSON.stringify(result, null, 2), 1500);
      }

      case 'roadmap_list_storybeats': {
        const beats = Array.isArray(result) ? result : [];
        if (!beats.length) return '(no storybeats)';
        const lines = beats.slice(0, 15).map(b => {
          const act = (b.act != null) ? `A${b.act}` : 'A?';
          const ord = (b.order != null) ? `#${b.order}` : '#?';
          return `${act}${ord} [${b.type || '?'}] â€” ${clip(b.title || '', 120)}`;
        });
        const rest = beats.length > 15 ? `\n  â€¦ (+${beats.length - 15} more)` : '';
        return lines.map(x => `  - ${x}`).join('\n') + rest;
      }

      default: {
        // Fallback: emit a small JSON snippet.
        return clip(JSON.stringify(result, null, 2), 1200);
      }
    }
  }

  // Human-friendly summary (natural tone). Do not dump raw ops into the chat.
  const lines = [];
  lines.push('\n\nZusammenfassung:');
  for (const r of results) {
    if (!r.ok) {
      lines.push(`- Konnte ${r.op || 'Aktion'} nicht ausfÃ¼hren: ${clip(r.error, 300)}`);
      continue;
    }
    const summary = summarizeActionResult(r.op, r.result);
    if (!summary) {
      lines.push('- Erledigt.');
      continue;
    }

    if (r.op === 'roadmap_get_node') {
      lines.push('- Inhalt ausgelesen:');
      lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
      continue;
    }

    if (r.op === 'roadmap_update_node') {
      lines.push('- Aktualisiert auf:');
      lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
      continue;
    }

    if (r.op === 'roadmap_create_node') {
      lines.push('- Neu angelegt:');
      lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
      continue;
    }

    if (r.op === 'roadmap_list_nodes') {
      lines.push('- Passende Nodes:');
      lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
      continue;
    }

    if (r.op === 'roadmap_list_connections') {
      lines.push('- Verbindungen:');
      lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
      continue;
    }

    lines.push(`- Ergebnis:`);
    lines.push(String(summary).split('\n').map(ln => `  ${ln}`).join('\n'));
  }
  appendAssistantDelta(assistantMsg, lines.join('\n') + '\n');

  return { executed, results };
}

function extractGatewayTextDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.delta === 'string') {
    const t = String(payload.type || '');
    if (t === 'response.output_text.delta' || t.endsWith('.delta') || t === 'delta') {
      return payload.delta;
    }
  }

  if (Array.isArray(payload.delta)) {
    return payload.delta.map(extractGatewayTextDelta).join('');
  }

  if (Array.isArray(payload.content)) {
    return payload.content.map(extractGatewayTextDelta).join('');
  }

  if (Array.isArray(payload.output)) {
    return payload.output.map(extractGatewayTextDelta).join('');
  }

  if (payload.delta && typeof payload.delta === 'object') {
    return extractGatewayTextDelta(payload.delta);
  }

  return '';
}

async function startGatewayChatRun(userText, assistantMsg) {
  const gateway = getOpenClawGatewayAuth();
  if (!gateway || !gateway.httpBase || !gateway.token) {
    const msg = 'OpenClaw Gateway Auth nicht gefunden. PrÃ¼fe ~/.openclaw/openclaw.json';
    agentState.lastError = msg;
    saveAgentState();
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
    return false;
  }

  // Global throttle across all backends.
  await enforceLlmMinInterval();

  const endpoint = new URL('/v1/responses', gateway.httpBase);
  const payload = JSON.stringify({
    model: gateway.model || 'openclaw:main',
    user: 'roadmap-live',
    stream: true,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          { type: 'input_text', text: ROADMAP_AGENT_SYSTEM_PROMPT }
        ]
      },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: userText }
        ]
      }
    ]
  });

  const sessionKey = `roadmap:${agentState.sessionName || DEFAULT_SESSION_NAME}`;

const requestOptions = {
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gateway.token}`,
      'x-openclaw-session-key': sessionKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = http.request(requestOptions, response => {
    activeProc = { kind: 'gateway-http', req, res: response };

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let errorBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { errorBody += chunk; });
      response.on('end', () => {
        const msg = `Gateway /v1/responses HTTP ${response.statusCode}: ${(errorBody || response.statusMessage || 'request failed').trim()}`;
        appendAssistantError(assistantMsg, msg);
        finishAgentRun(response.statusCode || 1, msg);
      });
      return;
    }

    let sseBuffer = '';
    response.setEncoding('utf8');

    const handleSseBlock = rawBlock => {
      const block = String(rawBlock || '').replace(/\r/g, '').trim();
      if (!block) return;

      let eventName = 'message';
      const dataLines = [];

      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || eventName;
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (!dataLines.length) return;

      const dataText = dataLines.join('\n').trim();
      if (!dataText || dataText === '[DONE]') return;

      let payloadObj;
      try {
        payloadObj = JSON.parse(dataText);
      } catch {
        if (eventName === 'error') {
          appendAssistantError(assistantMsg, dataText);
          agentState.lastError = dataText.slice(-5000);
          saveAgentState();
        }
        return;
      }

      const delta = extractGatewayTextDelta(payloadObj);
      if (delta) appendAssistantDelta(assistantMsg, delta);

      const eventType = String(payloadObj.type || eventName || '');
      const explicitError = payloadObj.error?.message || payloadObj.message;

      if ((eventType.includes('error') || eventName === 'error') && explicitError) {
        appendAssistantError(assistantMsg, explicitError);
        agentState.lastError = String(explicitError).slice(-5000);
        saveAgentState();
      }
    };

    response.on('data', chunk => {
      sseBuffer += chunk.replace(/\r\n/g, '\n');
      let splitIndex = sseBuffer.indexOf('\n\n');
      while (splitIndex !== -1) {
        const block = sseBuffer.slice(0, splitIndex);
        sseBuffer = sseBuffer.slice(splitIndex + 2);
        handleSseBlock(block);
        splitIndex = sseBuffer.indexOf('\n\n');
      }
    });

    response.on('end', () => {
      if (sseBuffer.trim()) handleSseBlock(sseBuffer);
      // After the assistant message is complete, execute any embedded local actions.
      // This keeps "live talk" via gateway while still mutating the roadmap locally.
      Promise.resolve()
        .then(() => executeAssistantActionsFromMessage(assistantMsg))
        .then(() => finishAgentRun(0, null))
        .catch(err => {
          const msg = err?.message || 'Action execution failed';
          appendAssistantError(assistantMsg, msg);
          finishAgentRun(1, msg);
        });
    });

    response.on('error', err => {
      const msg = err.message || 'Gateway stream error';
      appendAssistantError(assistantMsg, msg);
      finishAgentRun(1, msg);
    });

    response.on('aborted', () => {
      const msg = 'Gateway response stream aborted.';
      appendAssistantError(assistantMsg, msg);
      finishAgentRun(1, msg);
    });
  });

  // Safety timeout: avoid hanging forever if the gateway never completes / stalls.
  // (We still stream as long as data arrives.)
  req.setTimeout(120000, () => {
    const msg = 'Gateway request timeout (120s)';
    try { req.destroy(new Error(msg)); } catch {}
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
  });

  req.on('error', err => {
    const msg = err.message || 'Failed to contact OpenClaw Gateway';
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
  });

  req.write(payload);
  req.end();

  activeProc = { kind: 'gateway-http', req };
  return true;
}

// ============================================================
// DIRECT (OpenAI) chat backend: tool-capable agent inside this server
// ============================================================

function openaiHttpJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const base = new URL(OPENAI_BASE_URL);
    const body = JSON.stringify(payload);

    const req = https.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || 443,
        method: 'POST',
        path: pathname,
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`OpenAI HTTP ${res.statusCode}: ${(data || res.statusMessage || '').trim()}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('OpenAI response was not valid JSON'));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(120000, () => {
      try { req.destroy(new Error('OpenAI request timeout (120s)')); } catch {}
    });

    req.write(body);
    req.end();
  });
}

function roadmapToolSpecs() {
  // Keep these aligned with the server's REST API semantics.
  // We expose "refId" as the stable identifier (SRV-xxx, ARCH-xxx, etc.).
  return [
    {
      type: 'function',
      function: {
        name: 'roadmap_get_db_summary',
        description: 'Return counts and distributions (nodes/storybeats/connections; nodes by category and status).',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_get_node',
        description: 'Get a node by refId (e.g. SRV-010).',
        parameters: {
          type: 'object',
          properties: { refId: { type: 'string' } },
          required: ['refId'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_list_nodes',
        description: 'List nodes. Optional filters: categoryId, status, flag.',
        parameters: {
          type: 'object',
          properties: {
            categoryId: { type: 'string' },
            status: { type: 'string' },
            flag: { type: 'string' }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_create_node',
        description: 'Create a new node. Required: categoryId, refId, title, status. Optional: description, dependsOn, provides, emits, listensTo, flags.',
        parameters: {
          type: 'object',
          properties: {
            categoryId: { type: 'string' },
            refId: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            description: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            provides: { type: 'array', items: { type: 'string' } },
            emits: { type: 'array', items: { type: 'string' } },
            listensTo: { type: 'array', items: { type: 'string' } },
            flags: { type: 'array', items: { type: 'string' } }
          },
          required: ['categoryId', 'refId', 'title', 'status'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_update_node',
        description: 'Update a node by refId. Provide only fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            refId: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            description: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            provides: { type: 'array', items: { type: 'string' } },
            emits: { type: 'array', items: { type: 'string' } },
            listensTo: { type: 'array', items: { type: 'string' } },
            flags: { type: 'array', items: { type: 'string' } },
            codeSolution: { type: 'string' }
          },
          required: ['refId'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_move_node',
        description: 'Move a node: sortKey and/or layout x/y/pinned.',
        parameters: {
          type: 'object',
          properties: {
            refId: { type: 'string' },
            sortKey: { type: 'number' },
            layout: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                pinned: { type: 'boolean' }
              },
              additionalProperties: false
            }
          },
          required: ['refId'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_delete_node',
        description: 'Delete a node by refId.',
        parameters: {
          type: 'object',
          properties: { refId: { type: 'string' } },
          required: ['refId'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_list_storybeats',
        description: 'List storybeats sorted by act/order.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_create_storybeat',
        description: 'Create a storybeat. Required: title, order, type. Optional: act, description, gameRefs, notes.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            order: { type: 'number' },
            type: { type: 'string' },
            act: { type: 'number' },
            description: { type: 'string' },
            gameRefs: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' }
          },
          required: ['title', 'order', 'type'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_update_storybeat',
        description: 'Update a storybeat by id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            order: { type: 'number' },
            type: { type: 'string' },
            act: { type: 'number' },
            description: { type: 'string' },
            gameRefs: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' }
          },
          required: ['id'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_delete_storybeat',
        description: 'Delete a storybeat by id.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_move_storybeat',
        description: 'Move a storybeat: change order and/or act.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, order: { type: 'number' }, act: { type: 'number' } },
          required: ['id'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_list_connections',
        description: 'List connections. Optional filter by refId.',
        parameters: {
          type: 'object',
          properties: { refId: { type: 'string' } },
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_add_connection',
        description: 'Add a connection {fromId,toId,type,label?}.',
        parameters: {
          type: 'object',
          properties: {
            fromId: { type: 'string' },
            toId: { type: 'string' },
            type: { type: 'string' },
            label: { type: 'string' }
          },
          required: ['fromId', 'toId', 'type'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_remove_connection',
        description: 'Remove a connection {fromId,toId,type}.',
        parameters: {
          type: 'object',
          properties: {
            fromId: { type: 'string' },
            toId: { type: 'string' },
            type: { type: 'string' }
          },
          required: ['fromId', 'toId', 'type'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_mark_working',
        description: 'Light up active refs/files in the UI.',
        parameters: {
          type: 'object',
          properties: {
            activeRefs: { type: 'array', items: { type: 'string' } },
            activeFiles: { type: 'array', items: { type: 'string' } }
          },
          required: ['activeRefs'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_validate_refs',
        description: 'Validate references and connections against existing nodes.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'roadmap_scan',
        description: 'Trigger scan of /scan directory for .srd.json files.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    }
  ];
}

function safeJsonParse(maybeJson) {
  if (maybeJson == null) return null;
  if (typeof maybeJson === 'object') return maybeJson;
  const t = String(maybeJson).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

async function directToolCall(name, args) {
  // Tool execution happens locally on the server DB.
  // We keep semantics identical to the REST endpoints.
  switch (name) {
    case 'roadmap_get_db_summary': {
      const byCat = {};
      for (const n of db.nodes || []) byCat[n.categoryId] = (byCat[n.categoryId] || 0) + 1;
      const byStatus = {};
      for (const n of db.nodes || []) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
      return {
        totalNodes: (db.nodes || []).length,
        totalStorybeats: (db.storybeats || []).length,
        totalConnections: (db.connections || []).length,
        totalFlags: (db.flags || []).length,
        totalCategories: (db.categories || []).length,
        nodesByCategory: byCat,
        nodesByStatus: byStatus
      };
    }

    case 'roadmap_get_node': {
      const refId = String(args?.refId || '').trim();
      const node = db.nodes.find(n => n.refId === refId || n.id === refId);
      if (!node) return { error: `Not found: ${refId}` };
      return node;
    }

    case 'roadmap_list_nodes': {
      const categoryId = args?.categoryId ? String(args.categoryId) : null;
      const status = args?.status ? String(args.status) : null;
      const flag = args?.flag ? String(args.flag) : null;
      let nodes = db.nodes || [];
      if (categoryId) nodes = nodes.filter(n => n.categoryId === categoryId);
      if (status) nodes = nodes.filter(n => n.status === status);
      if (flag) nodes = nodes.filter(n => (n.flags || []).includes(flag));
      return nodes.map(n => ({
        refId: n.refId,
        title: n.title,
        status: n.status,
        categoryId: n.categoryId,
        workState: n.workState,
        flags: n.flags
      }));
    }

    case 'roadmap_mark_working': {
      const activeRefs = Array.isArray(args?.activeRefs) ? args.activeRefs.filter(Boolean) : [];
      const activeFiles = Array.isArray(args?.activeFiles) ? args.activeFiles.filter(Boolean) : [];
      markWorking(activeRefs, activeFiles);
      return { ok: true };
    }

    case 'roadmap_create_node': {
      const body = { ...args };
      if (!body.refId) return { error: 'refId required' };
      // Prevent duplicate refIds: refId is the canonical merge key in scans/imports.
      // If a node with the same refId already exists, creating another one would
      // produce ambiguous references and confusing UI behavior.
      if ((db.nodes || []).some(n => n.refId === body.refId)) {
        return { error: `Already exists: ${body.refId}` };
      }
      markWorking([body.refId], []);
      body.id = body.id || `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      body.createdAt = new Date().toISOString();
      body.workState = body.workState || 'idle';
      body.sortKey = body.sortKey || (db.nodes.length * 10);
      db.nodes.push(body);
      saveDB(db);
      emitDbChanged('node.created', { refId: body.refId });
      return body;
    }

    case 'roadmap_update_node': {
      const refId = String(args?.refId || '').trim();
      if (!refId) return { error: 'refId required' };
      const idx = db.nodes.findIndex(n => n.refId === refId || n.id === refId);
      if (idx < 0) return { error: `Not found: ${refId}` };
      const patch = { ...args };
      delete patch.refId;
      markWorking([refId], []);
      db.nodes[idx] = {
        ...db.nodes[idx],
        ...patch,
        updatedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
        lastTouchedBy: 'direct-agent'
      };
      saveDB(db);
      emitDbChanged('node.updated', { refId: db.nodes[idx].refId });
      return db.nodes[idx];
    }

    case 'roadmap_move_node': {
      const refId = String(args?.refId || '').trim();
      if (!refId) return { error: 'refId required' };
      const idx = db.nodes.findIndex(n => n.refId === refId || n.id === refId);
      if (idx < 0) return { error: `Not found: ${refId}` };
      markWorking([refId], []);
      if (args.sortKey !== undefined) db.nodes[idx].sortKey = args.sortKey;
      if (args.layout) db.nodes[idx].layout = { ...db.nodes[idx].layout, ...args.layout };
      db.nodes[idx].lastTouchedAt = new Date().toISOString();
      db.nodes[idx].lastTouchedBy = 'direct-agent';
      saveDB(db);
      emitDbChanged('node.moved', { refId: db.nodes[idx].refId });
      return db.nodes[idx];
    }

    case 'roadmap_delete_node': {
      const refId = String(args?.refId || '').trim();
      if (!refId) return { error: 'refId required' };
      markWorking([refId], []);
      db.nodes = db.nodes.filter(n => n.refId !== refId && n.id !== refId);
      db.connections = db.connections.filter(c => c.fromId !== refId && c.toId !== refId);
      saveDB(db);
      emitDbChanged('node.deleted', { refId });
      return { ok: true };
    }

    case 'roadmap_list_storybeats': {
      const beats = (db.storybeats || []).slice();
      beats.sort((a, b) => (a.act || 0) - (b.act || 0) || (a.order || 0) - (b.order || 0));
      return beats;
    }

    case 'roadmap_create_storybeat': {
      const body = { ...args };
      markWorking(['storybeats'], []);
      body.id = body.id || `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      body.workState = body.workState || 'idle';
      body.createdAt = new Date().toISOString();
      body.lastTouchedAt = new Date().toISOString();
      body.lastTouchedBy = 'direct-agent';
      db.storybeats.push(body);
      saveDB(db);
      emitDbChanged('storybeat.created');
      return body;
    }

    case 'roadmap_update_storybeat': {
      const id = String(args?.id || '').trim();
      const idx = db.storybeats.findIndex(s => s.id === id);
      if (idx < 0) return { error: `Not found: ${id}` };
      const patch = { ...args };
      delete patch.id;
      markWorking([id], []);
      db.storybeats[idx] = {
        ...db.storybeats[idx],
        ...patch,
        lastTouchedAt: new Date().toISOString(),
        lastTouchedBy: 'direct-agent'
      };
      saveDB(db);
      emitDbChanged('storybeat.updated');
      return db.storybeats[idx];
    }

    case 'roadmap_move_storybeat': {
      const id = String(args?.id || '').trim();
      const idx = db.storybeats.findIndex(s => s.id === id);
      if (idx < 0) return { error: `Not found: ${id}` };
      markWorking([id], []);
      if (args.order !== undefined) db.storybeats[idx].order = args.order;
      if (args.act !== undefined) db.storybeats[idx].act = args.act;
      db.storybeats[idx].lastTouchedAt = new Date().toISOString();
      db.storybeats[idx].lastTouchedBy = 'direct-agent';
      saveDB(db);
      emitDbChanged('storybeat.moved');
      return db.storybeats[idx];
    }

    case 'roadmap_delete_storybeat': {
      const id = String(args?.id || '').trim();
      markWorking([id], []);
      db.storybeats = db.storybeats.filter(s => s.id !== id);
      saveDB(db);
      emitDbChanged('storybeat.deleted');
      return { ok: true };
    }

    case 'roadmap_list_connections': {
      const refId = args?.refId ? String(args.refId).trim() : '';
      let conns = db.connections || [];
      if (refId) conns = conns.filter(c => c.fromId === refId || c.toId === refId);
      return conns;
    }

    case 'roadmap_add_connection': {
      const body = { ...args };
      markWorking([body.fromId, body.toId].filter(Boolean), []);
      const exists = db.connections.some(c => c.fromId === body.fromId && c.toId === body.toId && c.type === body.type);
      if (exists) return { error: 'Connection already exists' };
      db.connections.push(body);
      saveDB(db);
      emitDbChanged('connection.created');
      return body;
    }

    case 'roadmap_remove_connection': {
      const body = { ...args };
      markWorking([body.fromId, body.toId].filter(Boolean), []);
      db.connections = db.connections.filter(c => !(c.fromId === body.fromId && c.toId === body.toId && c.type === body.type));
      saveDB(db);
      emitDbChanged('connection.deleted');
      return { ok: true };
    }

    case 'roadmap_validate_refs': {
      const allRefIds = new Set((db.nodes || []).map(n => n.refId).filter(Boolean));
      const issues = [];
      for (const node of db.nodes || []) {
        for (const dep of (node.dependsOn || [])) if (!allRefIds.has(dep)) issues.push({ node: node.refId, field: 'dependsOn', missing: dep });
        for (const prov of (node.provides || [])) if (!allRefIds.has(prov)) issues.push({ node: node.refId, field: 'provides', missing: prov });
        for (const lt of (node.listensTo || [])) if (!allRefIds.has(lt)) issues.push({ node: node.refId, field: 'listensTo', missing: lt });
      }
      for (const conn of db.connections || []) {
        if (!allRefIds.has(conn.fromId)) issues.push({ connection: `${conn.fromId}â†’${conn.toId}`, field: 'fromId', missing: conn.fromId });
        if (!allRefIds.has(conn.toId)) issues.push({ connection: `${conn.fromId}â†’${conn.toId}`, field: 'toId', missing: conn.toId });
      }
      return { valid: issues.length === 0, issues };
    }

    case 'roadmap_scan': {
      markWorking(['scan'], []);
      const result = scanAll();
      return result;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function extractAssistantTextFromOpenAIResponse(resp) {
  // Prefer `output_text` if present.
  if (resp && typeof resp.output_text === 'string') return resp.output_text;
  // Fallback: scan output items.
  const out = resp?.output;
  if (!Array.isArray(out)) return '';
  let text = '';
  for (const item of out) {
    if (!item) continue;
    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    }
  }
  return text;
}

function extractFunctionCallsFromOpenAIResponse(resp) {
  // Responses API returns tool/function calls as output items.
  const calls = [];
  const out = resp?.output;
  if (!Array.isArray(out)) return calls;
  for (const item of out) {
    if (!item) continue;
    if (item.type === 'function_call') {
      const name = item.name;
      const args = safeJsonParse(item.arguments) || {};
      const callId = item.call_id || item.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (name) calls.push({ name, args, callId });
    }
  }
  return calls;
}

async function startDirectChatRun(userText, assistantMsg) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'NOT_SET') {
    const msg = 'DIRECT backend selected but OPENAI_API_KEY is not set (server-side env var).';
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
    return false;
  }

  // Global throttle across all backends.
  await enforceLlmMinInterval();

  try {
    emitSSE('agent.log', { stream: 'meta', text: `[DIRECT] OpenAI model=${OPENAI_MODEL}` });

    const systemPrompt = [
      'You are a live agent embedded in the OpenRoadmap Roadmap server.',
      'You can read and mutate the roadmap using the provided tools.',
      'Rules:',
      '- When you need roadmap data, call tools; do not guess.',
      '- Prefer small, safe edits. After each mutation, ensure the UI can reflect the change.',
      '- If a user asks for changes, execute them via tools and then summarize what changed.',
      '- Keep outputs concise and operational.'
    ].join('\n');

    // We keep a short conversation context: last N messages.
    const contextWindow = 12;
    const recent = chatHistory.slice(-contextWindow).map(m => ({ role: m.role, content: m.text }));

    let response = await openaiHttpJson('/v1/responses', {
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        ...recent.map(x => ({ role: x.role, content: x.content })),
        { role: 'user', content: userText }
      ],
      tools: roadmapToolSpecs(),
      tool_choice: 'auto'
    });

    // Tool loop.
    for (let step = 0; step < 8; step++) {
      const calls = extractFunctionCallsFromOpenAIResponse(response);
      if (!calls.length) break;

      // Execute tool calls serially to keep DB mutations deterministic.
      const toolResults = [];
      for (const c of calls) {
        emitSSE('agent.log', { stream: 'tool', text: `[tool] ${c.name} ${JSON.stringify(c.args)}` });
        let result;
        try {
          result = await directToolCall(c.name, c.args);
        } catch (e) {
          result = { error: e?.message || String(e) };
        }
        toolResults.push({
          type: 'tool_result',
          tool_call_id: c.callId,
          content: JSON.stringify(result)
        });
      }

      response = await openaiHttpJson('/v1/responses', {
        model: OPENAI_MODEL,
        previous_response_id: response.id,
        input: toolResults
      });
    }

    const finalText = extractAssistantTextFromOpenAIResponse(response);
    if (finalText) appendAssistantDelta(assistantMsg, finalText);
    finishAgentRun(0, null);
    return true;
  } catch (err) {
    const msg = err?.message || 'DIRECT backend failed';
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
    return false;
  }
}

async function startAcpChatRun(userText, assistantMsg) {
  // Spawn ACP client via acpx.
  // IMPORTANT: For OpenClaw, acpx must authenticate against the local Gateway.
  // We reuse the existing OpenClaw Gateway token from ~/.openclaw/openclaw.json
  // (we do NOT modify tokens; we only read them, similar to startGatewayChatRun).
  // Global throttle across all backends.
  await enforceLlmMinInterval();

  const sessionName = agentState.sessionName || DEFAULT_SESSION_NAME;
  const cwd = __dirname;
  // Resolve acpx command on Windows reliably.
  // Users frequently have acpx installed as a shim under %APPDATA%\npm\acpx.cmd.
  const cmdCandidates = [];
  if (process.env.ROADMAP_ACPX_CMD) cmdCandidates.push(process.env.ROADMAP_ACPX_CMD);
  cmdCandidates.push('acpx');
  try {
    const appData = process.env.APPDATA;
    if (appData) cmdCandidates.push(path.join(appData, 'npm', 'acpx.cmd'));
  } catch {}
  try {
    const profileRoot = process.env.USERPROFILE || process.env.HOME;
    if (profileRoot) cmdCandidates.push(path.join(profileRoot, 'AppData', 'Roaming', 'npm', 'acpx.cmd'));
  } catch {}

  const normalizeCmd = (s) => {
    const t = String(s || '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  const pickCmd = () => {
    // Prefer explicit/absolute paths first. Only fall back to the bare command
    // name ("acpx") if no path candidate exists.
    let bareFallback = null;
    for (const c of cmdCandidates) {
      const candidate = normalizeCmd(c);
      // If it's a bare command like "acpx", we can't existsSync it here.
      // Keep it only as a last-resort fallback.
      if (!candidate.includes('\\') && !candidate.includes('/')) {
        bareFallback = bareFallback || candidate;
        continue;
      }
      if (fs.existsSync(candidate)) return candidate;
    }
    return bareFallback || 'acpx';
  };

  const cmd = pickCmd();

  const gateway = getOpenClawGatewayAuth();
  if (!gateway || !gateway.wsUrl || !gateway.token) {
    const msg = 'OpenClaw Gateway Auth nicht gefunden. PrÃ¼fe ~/.openclaw/openclaw.json';
    agentState.lastError = msg;
    saveAgentState();
    appendAssistantError(assistantMsg, msg);
    finishAgentRun(1, msg);
    return false;
  }

  // We intentionally avoid acpx's `--agent "openclaw acp --url ..."` escape hatch here.
  // On Windows that string is extremely easy to mis-quote, causing `--url` to be parsed
  // as an acpx flag (you observed: "unknown option --url").
  //
  // Instead we use the built-in acpx agent "openclaw" (which runs `openclaw acp`) and
  // provide Gateway auth via env vars that OpenClaw CLI understands.
  // This makes the command line stable across shells.
  const resolvedCmd = normalizeCmd(cmd);
  const isWindowsCmd = /\.cmd$/i.test(resolvedCmd);

  try {
    // Surface what we're about to run (useful for debugging from the browser).
    emitSSE('agent.log', { stream: 'meta', text: `[ACP] spawning acpx openclaw (session=${sessionName})` });

    const env = {
      ...process.env,
      // Let the MCP server know where the Roadmap API lives.
      ROADMAP_API_BASE: process.env.ROADMAP_API_BASE || 'http://localhost:3000',
      // Auth for `openclaw acp` (OpenClaw CLI reads these).
      OPENCLAW_GATEWAY_TOKEN: String(gateway.token),
      OPENCLAW_GATEWAY_URL: String(gateway.wsUrl)
    };

    // Ensure an acpx session exists for this cwd+agent+name. Otherwise acpx refuses to prompt.
    // This is a fast local operation (creates a queue owner session record).
    try {
      if (process.platform === 'win32' && isWindowsCmd) {
        const ensureLine = [
          resolvedCmd,
          'openclaw',
          'sessions',
          'ensure',
          '--name', sessionName
        ].join(' ');
        spawnSync('cmd.exe', ['/d', '/s', '/c', ensureLine], { cwd, windowsHide: true, env, stdio: 'ignore' });
      } else {
        spawnSync(cmd, ['--cwd', cwd, 'openclaw', 'sessions', 'ensure', '--name', sessionName], { cwd, env, stdio: 'ignore' });
      }
    } catch {}

    let child;

    if (process.platform === 'win32' && isWindowsCmd) {
      // Use cmd.exe to run the .cmd shim reliably.
      // No nested quoting tricks needed now (no --agent raw string).
      const line = [
        resolvedCmd,
        '--approve-all',
        '--non-interactive-permissions', 'fail',
        'openclaw',
        'prompt',
        '-s', sessionName,
        '"' + String(userText).replace(/"/g, '""') + '"'
      ].join(' ');
      child = spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd, windowsHide: true, env });
    } else {
      child = spawn(
        cmd,
        ['--cwd', cwd, '--approve-all', '--non-interactive-permissions', 'fail', 'openclaw', 'prompt', '-s', sessionName, userText],
        { cwd, shell: false, env }
      );
    }

    activeProc = { kind: 'acp', pid: child.pid, child };

    let stderrTail = '';

    child.stdout.on('data', chunk => {
      const delta = chunk.toString();
      appendAssistantDelta(assistantMsg, delta);
    });

    child.stderr.on('data', chunk => {
      // Keep stderr visible in chat so failures are obvious.
      const text = chunk.toString();
      emitSSE('agent.log', { stream: 'stderr', text });

      // Keep a tail so we can surface the real reason when acpx exits.
      stderrTail = (stderrTail + text).slice(-8000);
    });

    child.on('close', code => {
      const exitCode = code || 0;
      if (exitCode !== 0) {
        const tail = String(stderrTail || '').trim();
        const msg = tail ? ('ACP client exited with code ' + exitCode + ':\n' + tail) : ('ACP client exited with code ' + exitCode);
        appendAssistantError(assistantMsg, msg);
        finishAgentRun(exitCode, msg);
        return;
      }
      finishAgentRun(0, null);
    });

    child.on('error', err => {
      const msg = err?.message || 'ACP spawn error';
      appendAssistantError(assistantMsg, msg);
      finishAgentRun(1, msg);
    });

    return true;
  } catch (err) {
    const msg = err?.message || 'Failed to start ACP client';
    appendAssistantError(assistantMsg, msg);
    agentState.lastError = msg;
    finishAgentRun(1, msg);
    return false;
  }
}

const DEFAULT_SESSION_NAME = 'OpenRoadmap-roadmap';

let agentState = {
  busy: false,
  turnId: null,
  startedAt: null,
  elapsedSec: 0,
  tick: 0,
  backend: CHAT_BACKEND,
  sessionName: DEFAULT_SESSION_NAME,
  currentTask: '',
  lastError: null,
  activeRefs: [],
  lastRefs: [],
  activeFiles: [],
  lastFiles: []
};

function loadAgentState() {
  try {
    if (fs.existsSync(AGENT_STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(AGENT_STATE_FILE, 'utf8'));
      agentState = { ...agentState, ...saved, busy: false, tick: 0, elapsedSec: 0 };
      // Always pin to current default to avoid stale session names/cwd collisions.
      agentState.sessionName = DEFAULT_SESSION_NAME;
      // Always pin to the currently configured backend (env ROADMAP_CHAT_BACKEND)
      // so old persisted state cannot force us back to gateway mode.
      agentState.backend = CHAT_BACKEND;
    }
  } catch (e) { /* ignore */ }
}

function saveAgentState() {
  try {
    const { tick, elapsedSec, ...persist } = agentState;
    fs.writeFileSync(AGENT_STATE_FILE, JSON.stringify(persist, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (!agentState.busy || !agentState.startedAt) return;
    agentState.elapsedSec = Math.floor((Date.now() - new Date(agentState.startedAt).getTime()) / 1000);
    agentState.tick += 1;
    emitSSE('agent.tick', {
      busy: agentState.busy,
      elapsedSec: agentState.elapsedSec,
      tick: agentState.tick,
      currentTask: agentState.currentTask,
      activeRefs: agentState.activeRefs,
      activeFiles: agentState.activeFiles
    });
  }, 1000);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function beginNewTurn(task) {
  for (const node of db.nodes) {
    if (node.workState === 'last') node.workState = 'idle';
    if (node.workState === 'active') node.workState = 'last';
  }
  for (const beat of db.storybeats) {
    if (beat.workState === 'last') beat.workState = 'idle';
    if (beat.workState === 'active') beat.workState = 'last';
  }
  agentState.lastRefs = [...agentState.activeRefs];
  agentState.lastFiles = [...agentState.activeFiles];
  agentState.activeRefs = [];
  agentState.activeFiles = [];
  agentState.turnId = `turn_${Date.now()}`;
  agentState.busy = true;
  agentState.startedAt = new Date().toISOString();
  agentState.elapsedSec = 0;
  agentState.tick = 0;
  agentState.currentTask = task;
  agentState.lastError = null;
  saveDB();
  saveAgentState();
}

function markWorking(activeRefs, activeFiles) {
  agentState.activeRefs = activeRefs || [];
  agentState.activeFiles = activeFiles || [];
  for (const node of db.nodes) {
    if (activeRefs.includes(node.refId)) {
      node.workState = 'active';
      node.lastTouchedAt = new Date().toISOString();
      node.lastTouchedBy = 'openclaw';
    }
  }
  for (const beat of db.storybeats) {
    if (activeRefs.includes(beat.id)) {
      beat.workState = 'active';
      beat.lastTouchedAt = new Date().toISOString();
      beat.lastTouchedBy = 'openclaw';
    }
  }
  saveDB();
  emitSSE('agent.activity', {
    activeRefs,
    lastRefs: agentState.lastRefs || [],
    activeFiles,
    lastFiles: agentState.lastFiles || [],
    turnId: agentState.turnId
  });
  emitDbChanged('mark.working');
}

function normalizeFilesList(files) {
  const out = [];
  for (const f of (files || [])) {
    const t = String(f || '').trim();
    if (!t) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

function promoteLastFiles(files) {
  // Keep exactly the 3 most recent "last" files.
  const incoming = normalizeFilesList(files);
  if (!incoming.length) return;

  const cur = Array.isArray(agentState.lastFiles) ? agentState.lastFiles.slice() : [];
  // Most-recent-first ordering.
  const next = [];
  for (const f of incoming) next.push(f);
  for (const f of cur) if (!next.includes(f)) next.push(f);
  agentState.lastFiles = next.slice(0, 3);
  // When we mark something as "last", it must not remain "active".
  agentState.activeFiles = [];
  saveAgentState();
  emitSSE('agent.activity', { activeRefs: agentState.activeRefs || [], activeFiles: agentState.activeFiles || [], lastFiles: agentState.lastFiles, turnId: agentState.turnId });
  emitSSE('agent.state', agentState);
}

function normalizeRefsList(refs) {
  const out = [];
  for (const r of (refs || [])) {
    const t = String(r || '').trim();
    if (!t) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

function promoteLastRefs(refs) {
  // Keep exactly the 3 most recent "last" refs (refId).
  const incoming = normalizeRefsList(refs);
  if (!incoming.length) return;

  const cur = Array.isArray(agentState.lastRefs) ? agentState.lastRefs.slice() : [];
  // Most-recent-first ordering.
  const next = [];
  for (const r of incoming) next.push(r);
  for (const r of cur) if (!next.includes(r)) next.push(r);
  agentState.lastRefs = next.slice(0, 3);
  // Clear active refs when promoting last.
  agentState.activeRefs = [];
  saveAgentState();
  emitSSE('agent.activity', {
    activeRefs: agentState.activeRefs || [],
    lastRefs: agentState.lastRefs,
    activeFiles: agentState.activeFiles || [],
    lastFiles: agentState.lastFiles || [],
    turnId: agentState.turnId
  });
  emitSSE('agent.state', agentState);
}

function resolveFilesForAction(op, args) {
  // Return a best-effort list of files that will be "touched" by this action.
  // The UI expects filenames (typically node.sourceFile / storybeat.sourceFile), but we fall back to roadmap.json.
  const files = [];
  try {
    const dbFileName = path.basename(DB_FILE);

    if (op === 'roadmap_scan') {
      // Scan touches many files. Prefer the most recently modified 3 .srd.json in /scan.
      try {
        const list = fs.readdirSync(SCAN_DIR)
          .filter(f => f.endsWith('.srd.json'))
          .map(f => {
            const fp = path.join(SCAN_DIR, f);
            let m = 0;
            try { m = fs.statSync(fp).mtimeMs || 0; } catch {}
            return { f, m };
          })
          .sort((a, b) => b.m - a.m)
          .slice(0, 3)
          .map(x => x.f);
        files.push(...list);
      } catch {}
      files.push(dbFileName);
      return normalizeFilesList(files);
    }

    if (op.startsWith('roadmap_')) {
      if (typeof args?.refId === 'string') {
        const refId = String(args.refId).trim();
        const n = db.nodes.find(x => x.refId === refId || x.id === refId);
        if (n?.sourceFile) files.push(n.sourceFile);
        else files.push(dbFileName);
        return normalizeFilesList(files);
      }
      if (typeof args?.fromId === 'string' || typeof args?.toId === 'string') {
        const ids = [args?.fromId, args?.toId].filter(Boolean).map(String);
        for (const id of ids) {
          const n = db.nodes.find(x => x.refId === id || x.id === id);
          if (n?.sourceFile) files.push(n.sourceFile);
        }
        if (!files.length) files.push(dbFileName);
        return normalizeFilesList(files);
      }
      if (typeof args?.id === 'string') {
        const id = String(args.id).trim();
        const b = (db.storybeats || []).find(x => x.id === id);
        if (b?.sourceFile) files.push(b.sourceFile);
        else files.push(dbFileName);
        return normalizeFilesList(files);
      }
    }

    files.push(path.basename(DB_FILE));
    return normalizeFilesList(files);
  } catch {
    return [];
  }
}

// â”€â”€â”€ SCANNER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function scanFile(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.error(`[SCAN] Invalid JSON in ${filepath}: ${e.message}`);
    return { added: 0, updated: 0, errors: [e.message] };
  }

  if (!parsed._srd_version) {
    console.error(`[SCAN] Missing _srd_version in ${filepath}`);
    return { added: 0, updated: 0, errors: ['Missing _srd_version'] };
  }

  const sourceFile = path.basename(filepath);
  let added = 0, updated = 0;

  // Import categories
  if (parsed.categories && Array.isArray(parsed.categories)) {
    for (const cat of parsed.categories) {
      const existing = db.categories.find(c => c.id === cat.id);
      if (existing) { Object.assign(existing, cat); updated++; }
      else { db.categories.push(cat); added++; }
    }
  }

  // Import nodes (with new fields)
  if (parsed.nodes && Array.isArray(parsed.nodes)) {
    for (let i = 0; i < parsed.nodes.length; i++) {
      const node = parsed.nodes[i];
      if (!node.id) node.id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const existing = db.nodes.find(n => n.id === node.id || (n.refId && n.refId === node.refId));
      // Enrich with new fields
      node.sourceFile = sourceFile;
      if (node.sortKey === undefined) node.sortKey = existing ? existing.sortKey : (db.nodes.length + i) * 10;
      if (!node.layout) node.layout = existing ? existing.layout : null;
      if (!node.workState) node.workState = existing ? (existing.workState || 'idle') : 'idle';
      if (!node.lastTouchedAt) node.lastTouchedAt = existing ? existing.lastTouchedAt : null;
      if (!node.lastTouchedBy) node.lastTouchedBy = existing ? existing.lastTouchedBy : null;
      if (existing) { Object.assign(existing, node); updated++; }
      else { db.nodes.push(node); added++; }
    }
  }

  // Import storybeats (with new fields)
  if (parsed.storybeats && Array.isArray(parsed.storybeats)) {
    for (const beat of parsed.storybeats) {
      if (!beat.id) beat.id = `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const existing = db.storybeats.find(s => s.id === beat.id);
      beat.sourceFile = sourceFile;
      if (!beat.workState) beat.workState = existing ? (existing.workState || 'idle') : 'idle';
      if (!beat.lastTouchedAt) beat.lastTouchedAt = existing ? existing.lastTouchedAt : null;
      if (!beat.lastTouchedBy) beat.lastTouchedBy = existing ? existing.lastTouchedBy : null;
      if (existing) { Object.assign(existing, beat); updated++; }
      else { db.storybeats.push(beat); added++; }
    }
  }

  // Import connections
  if (parsed.connections && Array.isArray(parsed.connections)) {
    for (const conn of parsed.connections) {
      const dup = db.connections.find(c => c.fromId === conn.fromId && c.toId === conn.toId && c.type === conn.type);
      if (!dup) { db.connections.push(conn); added++; }
    }
  }

  // Import flags
  if (parsed.flags && Array.isArray(parsed.flags)) {
    for (const flag of parsed.flags) {
      const existing = db.flags.find(f => f.id === flag.id);
      if (existing) { Object.assign(existing, flag); updated++; }
      else { db.flags.push(flag); added++; }
    }
  }

  db.meta.lastScan = new Date().toISOString();
  db.scanLog.push({ timestamp: new Date().toISOString(), file: sourceFile, nodesAdded: added, nodesUpdated: updated });
  saveDB(db);
  console.log(`[SCAN] ${sourceFile}: +${added} added, ~${updated} updated`);
  return { added, updated, errors: [] };
}

function scanAll() {
  fs.mkdirSync(SCAN_DIR, { recursive: true });
  const files = fs.readdirSync(SCAN_DIR).filter(f => f.endsWith('.srd.json'));
  let totalAdded = 0, totalUpdated = 0;
  for (const f of files) {
    const result = scanFile(path.join(SCAN_DIR, f));
    totalAdded += result.added;
    totalUpdated += result.updated;
  }
  emitDbChanged('scan.complete');
  return { files: files.length, totalAdded, totalUpdated };
}

// â”€â”€â”€ FILE WATCHER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startWatcher() {
  fs.mkdirSync(SCAN_DIR, { recursive: true });
  let debounce = {};
  fs.watch(SCAN_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.srd.json')) return;
    if (debounce[filename]) clearTimeout(debounce[filename]);
    debounce[filename] = setTimeout(() => {
      const fp = path.join(SCAN_DIR, filename);
      if (fs.existsSync(fp)) {
        console.log(`[WATCH] Detected change: ${filename}`);
        scanFile(fp);
        emitDbChanged('scan.file', { file: filename });
      }
      delete debounce[filename];
    }, 500);
  });
  console.log(`[WATCH] Watching ${SCAN_DIR} for .srd.json files`);
}

// â”€â”€â”€ ROUTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function isLocalRequest(req) {
  const ra = String(req.socket?.remoteAddress || '');
  return ra === '127.0.0.1' || ra === '::1' || ra.startsWith('::ffff:127.');
}

function killActiveProc() {
  if (!activeProc) return;

  try {
    if (typeof activeProc.abort === 'function') activeProc.abort();
    if (typeof activeProc.destroy === 'function') activeProc.destroy();
    if (activeProc.req && typeof activeProc.req.destroy === 'function') activeProc.req.destroy();
    if (activeProc.res && typeof activeProc.res.destroy === 'function') activeProc.res.destroy();
    if (activeProc.pid) {
      spawn('taskkill', ['/PID', String(activeProc.pid), '/T', '/F'], { shell: true });
    }
  } catch (e) {
    try { if (activeProc.req && typeof activeProc.req.abort === 'function') activeProc.req.abort(); } catch {}
  } finally {
    activeProc = null;
  }
}

async function handleAPI(req, res, pathname, method) {

  // â”€â”€ ADMIN: SHUTDOWN (localhost only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/admin/shutdown' && method === 'POST') {
    if (!isLocalRequest(req)) return json(res, { error: 'forbidden' }, 403);
    // stop any running agent process
    try { killActiveProc(); } catch {}
    // respond first, then close server
    json(res, { ok: true, shuttingDown: true });
    emitSSE('server.shutdown', { at: new Date().toISOString() });
    // Allow the response to flush.
    setTimeout(() => {
      try { server.close(() => process.exit(0)); } catch { process.exit(0); }
      // Safety: force exit if close hangs.
      setTimeout(() => process.exit(0), 750).unref?.();
    }, 50);
    return;
  }

  // â”€â”€ SSE EVENT STREAM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');
    sseClients.add(res);
    emitSSE('agent.state', agentState);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // â”€â”€ AGENT STATUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/agent/status' && method === 'GET') {
    const proc = activeProc ? { kind: activeProc.kind || 'unknown', pid: activeProc.pid || null } : null;
    return json(res, { ...agentState, activeProc: proc });
  }

  // â”€â”€ AGENT CANCEL (kills in-flight run) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/agent/cancel' && method === 'POST') {
    try { killActiveProc(); } catch {}
    finishAgentRun(1, 'Cancelled');
    return json(res, { ok: true, cancelled: true });
  }

  // â”€â”€ AGENT MARK-WORKING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/agent/mark-working' && method === 'POST') {
    const body = await parseBody(req);
    markWorking(body.activeRefs || [], body.activeFiles || []);
    return json(res, { ok: true });
  }

  // â”€â”€ CHAT HISTORY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/chat/history' && method === 'GET') return json(res, chatHistory);

  // â”€â”€ CHAT SEND (starts agent) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/chat/send' && method === 'POST') {
    const body = await parseBody(req);
    const text = String(body.text || '').trim();
    if (!text) return json(res, { error: 'Empty message' }, 400);
    if (activeProc) return json(res, { error: 'Agent already running' }, 409);

    const userMsg = { id: `u_${Date.now()}`, role: 'user', text, ts: new Date().toISOString() };
    chatHistory.push(userMsg);
    emitSSE('chat.message', userMsg);

    const assistantMsg = { id: `a_${Date.now()}`, role: 'assistant', text: '', ts: new Date().toISOString() };
    chatHistory.push(assistantMsg);
    emitSSE('chat.message', assistantMsg);

    beginNewTurn(text);
    emitSSE('agent.state', agentState);
    startTick();

    const started = (CHAT_BACKEND === 'direct')
      ? startDirectChatRun(text, assistantMsg)
      : (CHAT_BACKEND === 'acp')
        ? startAcpChatRun(text, assistantMsg)
        : startGatewayChatRun(text, assistantMsg);
    if (!started) {
      const msg = agentState.lastError || (CHAT_BACKEND === 'direct'
        ? 'DIRECT start failed'
        : (CHAT_BACKEND === 'acp' ? 'ACP start failed' : 'Gateway start failed'));
      return json(res, { ok: false, backend: CHAT_BACKEND, error: msg }, 500);
    }

    return json(res, { ok: true, accepted: true });
  }

  // â”€â”€ VALIDATE REFS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (pathname === '/api/validate' && method === 'GET') {
    const allRefIds = new Set(db.nodes.map(n => n.refId).filter(Boolean));
    const issues = [];
    for (const node of db.nodes) {
      for (const dep of (node.dependsOn || [])) { if (!allRefIds.has(dep)) issues.push({ node: node.refId, field: 'dependsOn', missing: dep }); }
      for (const prov of (node.provides || [])) { if (!allRefIds.has(prov)) issues.push({ node: node.refId, field: 'provides', missing: prov }); }
      for (const lt of (node.listensTo || [])) { if (!allRefIds.has(lt)) issues.push({ node: node.refId, field: 'listensTo', missing: lt }); }
    }
    for (const conn of db.connections) {
      if (!allRefIds.has(conn.fromId)) issues.push({ connection: `${conn.fromId}â†’${conn.toId}`, field: 'fromId', missing: conn.fromId });
      if (!allRefIds.has(conn.toId)) issues.push({ connection: `${conn.fromId}â†’${conn.toId}`, field: 'toId', missing: conn.toId });
    }
    return json(res, { valid: issues.length === 0, issues });
  }

  // â”€â”€ ORIGINAL API ROUTES (unverÃ¤ndert) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // GET /api/db
  if (pathname === '/api/db' && method === 'GET') return json(res, db);

  // GET /api/meta
  if (pathname === '/api/meta' && method === 'GET') return json(res, db.meta || {});

  // PUT /api/meta
  // Update server metadata (e.g. projectName). This is used by the UI "Change Roadmap Name".
  if (pathname === '/api/meta' && method === 'PUT') {
    const body = await parseBody(req);
    if (!body || typeof body !== 'object') return json(res, { error: 'meta payload must be an object' }, 400);

    db.meta = db.meta || {};

    if (body.projectName !== undefined) {
      const name = String(body.projectName || '').trim();
      if (!name) return json(res, { error: 'projectName must not be empty' }, 400);
      db.meta.projectName = name;
    }

    saveDB(db);
    emitDbChanged('meta.updated', { meta: db.meta });
    return json(res, db.meta || {});
  }

  // GET /api/categories
  if (pathname === '/api/categories' && method === 'GET') return json(res, db.categories);

  // PUT /api/categories
  // Replace the full category config. This is intended for the UI "Edit Categories" dialog.
  if (pathname === '/api/categories' && method === 'PUT') {
    const body = await parseBody(req);
    const cats = Array.isArray(body) ? body : body?.categories;
    if (!Array.isArray(cats)) return json(res, { error: 'categories must be an array' }, 400);

    // Normalize + validate
    const normalized = [];
    const ids = new Set();
    for (const c of cats) {
      if (!c || typeof c !== 'object') continue;
      const id = String(c.id || '').trim();
      if (!id) return json(res, { error: 'category.id is required' }, 400);
      if (ids.has(id)) return json(res, { error: `duplicate category id: ${id}` }, 400);
      ids.add(id);
      normalized.push({
        id,
        name: (c.name != null) ? String(c.name) : id,
        prefix: (c.prefix != null) ? String(c.prefix) : id,
        color: (c.color != null) ? String(c.color) : '#888',
        description: (c.description != null) ? String(c.description) : ''
      });
    }

    db.categories = normalized;

    // If categories were removed/renamed, nodes may still reference old categoryIds.
    // Those nodes would fall back into "OTHER" in the UI. We normalize by clearing
    // invalid categoryIds (so prefix matching can still categorize when possible).
    const validIds = new Set(normalized.map(c => c.id));
    for (const n of (db.nodes || [])) {
      const cid = String(n?.categoryId || '').trim();
      if (cid && !validIds.has(cid)) {
        n.categoryId = '';
      }
    }

    saveDB(db);
    emitDbChanged('categories.updated', { count: normalized.length });
    return json(res, db.categories);
  }

  // â”€â”€ NODES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/nodes' && method === 'GET') return json(res, db.nodes);

  if (pathname === '/api/nodes' && method === 'POST') {
    const body = await parseBody(req);
    if (!body || !String(body.refId || '').trim()) {
      return json(res, { error: 'refId required' }, 400);
    }
    const refId = String(body.refId).trim();
    if (db.nodes.some(n => n.refId === refId)) {
      return json(res, { error: `Already exists: ${refId}` }, 409);
    }
    body.id = body.id || `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    body.createdAt = new Date().toISOString();
    body.workState = body.workState || 'idle';
    body.sortKey = body.sortKey || db.nodes.length * 10;
    db.nodes.push(body);
    saveDB(db);
    emitDbChanged('node.created', { refId: body.refId });
    return json(res, body, 201);
  }

  // Node MOVE
  const nodeMoveMatch = pathname.match(/^\/api\/nodes\/([^/]+)\/move$/);
  if (nodeMoveMatch && method === 'PATCH') {
    const id = decodeURIComponent(nodeMoveMatch[1]);
    const idx = db.nodes.findIndex(n => n.id === id || n.refId === id);
    if (idx < 0) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    if (body.sortKey !== undefined) db.nodes[idx].sortKey = body.sortKey;
    if (body.layout) db.nodes[idx].layout = { ...db.nodes[idx].layout, ...body.layout };
    db.nodes[idx].lastTouchedAt = new Date().toISOString();
    saveDB(db);
    emitDbChanged('node.moved', { refId: db.nodes[idx].refId });
    return json(res, db.nodes[idx]);
  }

  // Node GET/PUT/DELETE by ID
  if (pathname.startsWith('/api/nodes/') && !pathname.includes('/move')) {
    const id = pathname.split('/')[3];
    if (method === 'GET') {
      const node = db.nodes.find(n => n.id === id || n.refId === id);
      return node ? json(res, node) : json(res, { error: 'Not found' }, 404);
    }
    if (method === 'PUT') {
      const idx = db.nodes.findIndex(n => n.id === id || n.refId === id);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      const body = await parseBody(req);
      db.nodes[idx] = { ...db.nodes[idx], ...body, updatedAt: new Date().toISOString() };
      saveDB(db);
      emitDbChanged('node.updated', { refId: db.nodes[idx].refId });
      return json(res, db.nodes[idx]);
    }
    if (method === 'DELETE') {
      db.nodes = db.nodes.filter(n => n.id !== id && n.refId !== id);
      db.connections = db.connections.filter(c => c.fromId !== id && c.toId !== id);
      saveDB(db);
      emitDbChanged('node.deleted', { refId: id });
      return json(res, { ok: true });
    }
  }

  // â”€â”€ STORYBEATS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/storybeats' && method === 'GET') return json(res, db.storybeats);

  if (pathname === '/api/storybeats' && method === 'POST') {
    const body = await parseBody(req);
    body.id = body.id || `story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    body.workState = body.workState || 'idle';
    db.storybeats.push(body);
    saveDB(db);
    emitDbChanged('storybeat.created');
    return json(res, body, 201);
  }

  // Storybeat MOVE
  const beatMoveMatch = pathname.match(/^\/api\/storybeats\/([^/]+)\/move$/);
  if (beatMoveMatch && method === 'PATCH') {
    const id = decodeURIComponent(beatMoveMatch[1]);
    const idx = db.storybeats.findIndex(s => s.id === id);
    if (idx < 0) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    if (body.order !== undefined) db.storybeats[idx].order = body.order;
    if (body.act !== undefined) db.storybeats[idx].act = body.act;
    db.storybeats[idx].lastTouchedAt = new Date().toISOString();
    saveDB(db);
    emitDbChanged('storybeat.moved');
    return json(res, db.storybeats[idx]);
  }

  // Storybeat PUT/DELETE by ID
  if (pathname.startsWith('/api/storybeats/') && !pathname.includes('/move')) {
    const id = pathname.split('/')[3];
    if (method === 'PUT') {
      const idx = db.storybeats.findIndex(s => s.id === id);
      if (idx === -1) return json(res, { error: 'Not found' }, 404);
      const body = await parseBody(req);
      db.storybeats[idx] = { ...db.storybeats[idx], ...body };
      saveDB(db);
      emitDbChanged('storybeat.updated');
      return json(res, db.storybeats[idx]);
    }
    if (method === 'DELETE') {
      db.storybeats = db.storybeats.filter(s => s.id !== id);
      saveDB(db);
      emitDbChanged('storybeat.deleted');
      return json(res, { ok: true });
    }
  }

  // â”€â”€ CONNECTIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/connections' && method === 'GET') return json(res, db.connections);

  if (pathname === '/api/connections' && method === 'POST') {
    const body = await parseBody(req);
    // Arrow flag controls ONLY arrow rendering on highlighted lines.
    // Allowed: from | to | both | unspecified
    if (!body.arrowFlag) body.arrowFlag = 'unspecified';

    const exists = db.connections.some(c => c.fromId === body.fromId && c.toId === body.toId && c.type === body.type);
    if (exists) return json(res, { error: 'Connection already exists' }, 409);
    db.connections.push(body);
    saveDB(db);
    emitDbChanged('connection.created');
    return json(res, body, 201);
  }

  // PATCH /api/connections
  // Update an existing connection's arrowFlag (and/or label).
  if (pathname === '/api/connections' && method === 'PATCH') {
    const body = await parseBody(req);
    const idx = db.connections.findIndex(c => c.fromId === body.fromId && c.toId === body.toId && c.type === body.type);
    if (idx < 0) return json(res, { error: 'Not found' }, 404);

    if (body.arrowFlag !== undefined) {
      const af = String(body.arrowFlag || '').trim().toLowerCase();
      const allowed = new Set(['from', 'to', 'both', 'unspecified']);
      if (!allowed.has(af)) return json(res, { error: 'invalid arrowFlag' }, 400);
      db.connections[idx].arrowFlag = af;
    }
    if (body.label !== undefined) {
      db.connections[idx].label = String(body.label || '');
    }

    saveDB(db);
    emitDbChanged('connection.updated');
    return json(res, db.connections[idx]);
  }

  if (pathname === '/api/connections' && method === 'DELETE') {
    const body = await parseBody(req);
    db.connections = db.connections.filter(c => !(c.fromId === body.fromId && c.toId === body.toId && c.type === body.type));
    saveDB(db);
    emitDbChanged('connection.deleted');
    return json(res, { ok: true });
  }

  // â”€â”€ FLAGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/flags' && method === 'GET') return json(res, db.flags);

  if (pathname === '/api/flags' && method === 'POST') {
    const body = await parseBody(req);
    body.id = body.id || `flag_${Date.now()}`;
    if (!db.flags.some(f => f.id === body.id)) db.flags.push(body);
    saveDB(db);
    return json(res, body, 201);
  }

  // â”€â”€ SCAN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/scan' && method === 'POST') {
    const result = scanAll();
    return json(res, result);
  }

  if (pathname === '/api/scan/log' && method === 'GET') return json(res, db.scanLog.slice(-50));

  // â”€â”€ EXPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  if (pathname === '/api/export' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="OpenRoadmap_roadmap_export.json"' });
    return res.end(JSON.stringify(db, null, 2));
  }

  return json(res, { error: 'Not found' }, 404);
}

// â”€â”€â”€ STATIC FILES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

// â”€â”€â”€ SERVER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleAPI(req, res, pathname, method);
    } else {
      serveStatic(res, pathname);
    }
  } catch (err) {
    console.error(`[ERROR] ${method} ${pathname}:`, err.message);
    json(res, { error: err.message }, 500);
  }
});

// â”€â”€â”€ STARTUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('[INIT] Loading agent state...');
loadAgentState();

console.log('[INIT] Scanning existing files...');
const initScan = scanAll();
console.log(`[INIT] Initial scan: ${initScan.files} files, +${initScan.totalAdded} nodes`);

startWatcher();

async function startServer() {
  // Try to shut down any existing instance first (no PID hunting).
  const shutOk = await requestShutdownExistingServer(PORT);
  if (shutOk) {
    // give the old server a moment to release the port
    await delay(250);
  }

  server.on('error', async err => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[INIT] Port ${PORT} already in use. Requesting shutdown of existing server...`);
      const ok = await requestShutdownExistingServer(PORT);
      if (ok) {
        await delay(350);
        try {
          server.listen(PORT);
          return;
        } catch (e) {
          console.error(`[INIT] Retry listen failed: ${e.message}`);
        }
      }
      console.error(`[INIT] Could not take over port ${PORT}. Is another process blocking it?`);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
  console.log(`\n  â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—`);
  console.log(`  â•‘  OpenRoadmap ROADMAP SERVER v2.0             â•‘`);
  console.log(`  â•‘  http://localhost:${PORT}                    â•‘`);
  console.log(`  â•‘  SSE:  /api/events                       â•‘`);
  console.log(`  â•‘  Chat: /api/chat/send                    â•‘`);
  console.log(`  â•‘  Drop .srd.json files into /scan         â•‘`);
  console.log(`  â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n`);
  });
}

startServer();

