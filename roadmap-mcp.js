#!/usr/bin/env node
/*
  OpenRoadmap Planner — MCP Server

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
  - OpenAI ChatGPT 5.2-codex (assistance)
  - Anthropic Claude (assistance)
*/

// ============================================================
// OPENROADMAP PLANNER MCP SERVER
// stdio-basiert, spricht per HTTP gegen localhost:3000
// Registrieren in OpenClaw:
//   /mcp set roadmap={"command":"node","args":["PFAD/roadmap-mcp.js"]}
// ============================================================

// Guardrail: this MCP server is intended to be spawned on-demand by OpenClaw/ACPX.
// If you start it manually in multiple terminals, you will see "node" duplicates in Task Manager.
// We keep it simple: warn loudly when run interactively.
if (process.stdin.isTTY) {
  process.stderr.write('[roadmap-mcp] Note: running interactively will keep a node process alive. Usually this is spawned by OpenClaw/ACPX.\n');
}

const http = require('http');

// Allow overriding the API base via environment variable when running under OpenClaw/ACPX.
// Example: ROADMAP_API_BASE=http://localhost:3000
const API_BASE = process.env.ROADMAP_API_BASE || 'http://localhost:3000';

// ============================================================
// HTTP HELPER
// ============================================================

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================
// WORK MARKING (deterministic "glow" in the browser UI)
// ============================================================

async function markWorking(activeRefs, activeFiles) {
  try {
    const refs = Array.isArray(activeRefs) ? activeRefs.filter(Boolean) : [];
    const files = Array.isArray(activeFiles) ? activeFiles.filter(Boolean) : [];
    if (!refs.length && !files.length) return;
    await apiCall('POST', '/api/agent/mark-working', { activeRefs: refs, activeFiles: files });
  } catch {
    // Best-effort only; never fail the main tool because the UI marker endpoint is unavailable.
  }
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

async function markWorkingForNodeRef(refId) {
  if (!refId) return;
  // We try to also light up the sourceFile if present.
  try {
    const r = await apiCall('GET', `/api/nodes/${encodeURIComponent(refId)}`);
    const n = r?.data;
    await markWorking([refId], n?.sourceFile ? [n.sourceFile] : []);
  } catch {
    await markWorking([refId], []);
  }
}

async function markWorkingForStorybeatId(id) {
  if (!id) return;
  // Try to find its sourceFile via list endpoint (no dedicated GET by id exists).
  try {
    const r = await apiCall('GET', '/api/storybeats');
    const beat = (r?.data || []).find(b => b.id === id);
    await markWorking([id], beat?.sourceFile ? [beat.sourceFile] : []);
  } catch {
    await markWorking([id], []);
  }
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================

const TOOLS = [
  {
    name: 'roadmap_get_db_summary',
    description: 'Get a summary of the roadmap database: node/storybeat/connection counts per category, status distribution.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'roadmap_list_categories',
    description: 'List configured categories (id, name, prefix, color, description).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'roadmap_update_categories',
    description: 'Replace the full category config. Provide categories array in the same format as returned by roadmap_list_categories.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              prefix: { type: 'string' },
              color: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['id']
          }
        }
      },
      required: ['categories']
    }
  },
  {
    name: 'roadmap_get_meta',
    description: 'Get server meta information (e.g. projectName).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'roadmap_set_project_name',
    description: 'Set the roadmap/server display name (projectName).',
    inputSchema: {
      type: 'object',
      properties: { projectName: { type: 'string' } },
      required: ['projectName']
    }
  },
  {
    name: 'roadmap_get_node',
    description: 'Get a single node by refId or id. Returns full node with dependencies, provides, emits, flags, workState.',
    inputSchema: {
      type: 'object',
      properties: { refId: { type: 'string', description: 'Node refId (e.g. SRV-010) or internal id' } },
      required: ['refId']
    }
  },
  {
    name: 'roadmap_list_nodes',
    description: 'List all nodes. Optional filters: categoryId, status, flag.',
    inputSchema: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: 'Filter by category prefix (VIS, ARCH, SRV, CLI, GAM, WLD, ART, METH, XREF)' },
        status: { type: 'string', description: 'Filter by status (OFFEN, ENTSCHIEDEN, PRE-FORMULIERUNG)' },
        flag: { type: 'string', description: 'Filter by flag (e.g. is_core, is_server)' }
      }
    }
  },
  {
    name: 'roadmap_create_node',
    description: 'Create a new node. Required: categoryId, refId, title, status. Optional: description, dependsOn, provides, emits, listensTo, flags.',
    inputSchema: {
      type: 'object',
      properties: {
        categoryId: { type: 'string' }, refId: { type: 'string' }, title: { type: 'string' },
        status: { type: 'string' }, description: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' } },
        provides: { type: 'array', items: { type: 'string' } },
        emits: { type: 'array', items: { type: 'string' } },
        listensTo: { type: 'array', items: { type: 'string' } },
        flags: { type: 'array', items: { type: 'string' } }
      },
      required: ['categoryId', 'refId', 'title', 'status']
    }
  },
  {
    name: 'roadmap_update_node',
    description: 'Update an existing node. Provide refId and any fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        refId: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
        description: { type: 'string' },
        dependsOn: { type: 'array', items: { type: 'string' } },
        provides: { type: 'array', items: { type: 'string' } },
        emits: { type: 'array', items: { type: 'string' } },
        listensTo: { type: 'array', items: { type: 'string' } },
        flags: { type: 'array', items: { type: 'string' } },
        codeSolution: { type: 'string' }
      },
      required: ['refId']
    }
  },
  {
    name: 'roadmap_delete_node',
    description: 'Delete a node by refId.',
    inputSchema: {
      type: 'object',
      properties: { refId: { type: 'string' } },
      required: ['refId']
    }
  },
  {
    name: 'roadmap_move_node',
    description: 'Move a node: change sortKey (list order) and/or layout position (graph x/y).',
    inputSchema: {
      type: 'object',
      properties: {
        refId: { type: 'string' },
        sortKey: { type: 'number' },
        layout: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, pinned: { type: 'boolean' } } }
      },
      required: ['refId']
    }
  },
  {
    name: 'roadmap_list_storybeats',
    description: 'List all storybeats, sorted by act and order.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'roadmap_create_storybeat',
    description: 'Create a new storybeat. Required: title, order, type (scene/cut). Optional: act, description, gameRefs, notes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, order: { type: 'number' }, type: { type: 'string' },
        act: { type: 'number' }, description: { type: 'string' },
        gameRefs: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }
      },
      required: ['title', 'order', 'type']
    }
  },
  {
    name: 'roadmap_update_storybeat',
    description: 'Update a storybeat by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, order: { type: 'number' },
        type: { type: 'string' }, act: { type: 'number' }, description: { type: 'string' },
        gameRefs: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'roadmap_delete_storybeat',
    description: 'Delete a storybeat by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'roadmap_move_storybeat',
    description: 'Move a storybeat: change order and/or act.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, order: { type: 'number' }, act: { type: 'number' } },
      required: ['id']
    }
  },
  {
    name: 'roadmap_list_connections',
    description: 'List all connections. Optional filter by refId (shows all connections involving that refId).',
    inputSchema: {
      type: 'object',
      properties: { refId: { type: 'string', description: 'Filter connections involving this refId' } }
    }
  },
  {
    name: 'roadmap_add_connection',
    description: 'Add a connection between two nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' }, toId: { type: 'string' },
        type: { type: 'string', description: 'depends | provides | emits | listens | story | custom' },
        label: { type: 'string' }
      },
      required: ['fromId', 'toId', 'type']
    }
  },
  {
    name: 'roadmap_remove_connection',
    description: 'Remove a connection.',
    inputSchema: {
      type: 'object',
      properties: { fromId: { type: 'string' }, toId: { type: 'string' }, type: { type: 'string' } },
      required: ['fromId', 'toId', 'type']
    }
  },
  {
    name: 'roadmap_mark_working',
    description: 'Mark which refIds and files the agent is currently working on. This lights them up in the browser UI.',
    inputSchema: {
      type: 'object',
      properties: {
        activeRefs: { type: 'array', items: { type: 'string' }, description: 'RefIds being worked on (e.g. ["SRV-003C", "ARCH-001"])' },
        activeFiles: { type: 'array', items: { type: 'string' }, description: 'Source files being worked on (e.g. ["03_server_module.srd.json"])' }
      },
      required: ['activeRefs']
    }
  },
  {
    name: 'roadmap_validate_refs',
    description: 'Validate all references: checks dependsOn, provides, listensTo, and connection fromId/toId against existing refIds.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'roadmap_scan',
    description: 'Trigger a manual scan of all .srd.json files in the /scan directory.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ============================================================
// TOOL HANDLERS
// ============================================================

async function handleTool(name, args) {
  switch (name) {

    case 'roadmap_get_db_summary': {
      const r = await apiCall('GET', '/api/db');
      const d = r.data;
      const byCat = {};
      for (const n of d.nodes || []) {
        byCat[n.categoryId] = (byCat[n.categoryId] || 0) + 1;
      }
      const byStatus = {};
      for (const n of d.nodes || []) {
        byStatus[n.status] = (byStatus[n.status] || 0) + 1;
      }
      return {
        totalNodes: (d.nodes || []).length,
        totalStorybeats: (d.storybeats || []).length,
        totalConnections: (d.connections || []).length,
        totalFlags: (d.flags || []).length,
        totalCategories: (d.categories || []).length,
        nodesByCategory: byCat,
        nodesByStatus: byStatus
      };
    }

    case 'roadmap_list_categories': {
      const r = await apiCall('GET', '/api/categories');
      return r.data || [];
    }

    case 'roadmap_update_categories': {
      const cats = Array.isArray(args.categories) ? args.categories : [];
      const r = await apiCall('PUT', '/api/categories', cats);
      return r.data;
    }

    case 'roadmap_get_meta': {
      const r = await apiCall('GET', '/api/meta');
      return r.data || {};
    }

    case 'roadmap_set_project_name': {
      await markWorking(['meta'], []);
      const r = await apiCall('PUT', '/api/meta', { projectName: args.projectName });
      return r.data;
    }

    case 'roadmap_get_node': {
      const r = await apiCall('GET', `/api/nodes/${encodeURIComponent(args.refId)}`);
      if (r.status === 404) return { error: `Node '${args.refId}' not found` };
      return r.data;
    }

    case 'roadmap_list_nodes': {
      const r = await apiCall('GET', '/api/nodes');
      let nodes = r.data || [];
      if (args.categoryId) nodes = nodes.filter(n => n.categoryId === args.categoryId);
      if (args.status) nodes = nodes.filter(n => n.status === args.status);
      if (args.flag) nodes = nodes.filter(n => (n.flags || []).includes(args.flag));
      return nodes.map(n => ({
        refId: n.refId, title: n.title, status: n.status, categoryId: n.categoryId,
        workState: n.workState, flags: n.flags
      }));
    }

    case 'roadmap_create_node': {
      // Mark before we mutate so the browser shows activity immediately.
      await markWorkingForNodeRef(args.refId);
      const r = await apiCall('POST', '/api/nodes', args);
      return r.data;
    }

    case 'roadmap_update_node': {
      const { refId, ...updates } = args;
      updates.lastTouchedBy = 'openclaw';
      await markWorkingForNodeRef(refId);
      const r = await apiCall('PUT', `/api/nodes/${encodeURIComponent(refId)}`, updates);
      return r.data;
    }

    case 'roadmap_delete_node': {
      await markWorkingForNodeRef(args.refId);
      const r = await apiCall('DELETE', `/api/nodes/${encodeURIComponent(args.refId)}`);
      return r.data;
    }

    case 'roadmap_move_node': {
      const { refId, ...moveData } = args;
      await markWorkingForNodeRef(refId);
      const r = await apiCall('PATCH', `/api/nodes/${encodeURIComponent(refId)}/move`, moveData);
      return r.data;
    }

    case 'roadmap_list_storybeats': {
      const r = await apiCall('GET', '/api/storybeats');
      const beats = (r.data || []).sort((a, b) => (a.act || 0) - (b.act || 0) || a.order - b.order);
      return beats;
    }

    case 'roadmap_create_storybeat': {
      // We don't have an id yet; mark the storyboard area by marking a pseudo-ref.
      // The server will ignore unknown refs; this is just for the agent ticker files/refs.
      await markWorking(['storybeats'], []);
      const r = await apiCall('POST', '/api/storybeats', args);
      return r.data;
    }

    case 'roadmap_update_storybeat': {
      const { id, ...updates } = args;
      updates.lastTouchedBy = 'openclaw';
      await markWorkingForStorybeatId(id);
      const r = await apiCall('PUT', `/api/storybeats/${encodeURIComponent(id)}`, updates);
      return r.data;
    }

    case 'roadmap_delete_storybeat': {
      await markWorkingForStorybeatId(args.id);
      const r = await apiCall('DELETE', `/api/storybeats/${encodeURIComponent(args.id)}`);
      return r.data;
    }

    case 'roadmap_move_storybeat': {
      const { id, ...moveData } = args;
      await markWorkingForStorybeatId(id);
      const r = await apiCall('PATCH', `/api/storybeats/${encodeURIComponent(id)}/move`, moveData);
      return r.data;
    }

    case 'roadmap_list_connections': {
      const r = await apiCall('GET', '/api/connections');
      let conns = r.data || [];
      if (args.refId) conns = conns.filter(c => c.fromId === args.refId || c.toId === args.refId);
      return conns;
    }

    case 'roadmap_add_connection': {
      await markWorking(uniq([args.fromId, args.toId]), []);
      const r = await apiCall('POST', '/api/connections', args);
      return r.data;
    }

    case 'roadmap_remove_connection': {
      await markWorking(uniq([args.fromId, args.toId]), []);
      const r = await apiCall('DELETE', '/api/connections', args);
      return r.data;
    }

    case 'roadmap_mark_working': {
      const r = await apiCall('POST', '/api/agent/mark-working', args);
      return r.data;
    }

    case 'roadmap_validate_refs': {
      const r = await apiCall('GET', '/api/validate');
      return r.data;
    }

    case 'roadmap_scan': {
      await markWorking(['scan'], []);
      const r = await apiCall('POST', '/api/scan');
      return r.data;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
// MCP STDIO PROTOCOL
// ============================================================

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try {
      const msg = JSON.parse(body);
      handleMessage(msg);
    } catch (e) {
      sendError(null, -32700, 'Parse error');
    }
  }
});

function send(obj) {
  const body = JSON.stringify(obj);
  const msg = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  process.stdout.write(msg);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    return sendResult(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'OpenRoadmap-roadmap-mcp', version: '1.0.0' }
    });
  }

  if (msg.method === 'notifications/initialized') {
    return; // no response needed
  }

  if (msg.method === 'tools/list') {
    return sendResult(msg.id, { tools: TOOLS });
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    try {
      const result = await handleTool(name, args || {});
      sendResult(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      });
    } catch (e) {
      sendResult(msg.id, {
        content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
        isError: true
      });
    }
    return;
  }

  if (msg.id) {
    sendError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

process.stderr.write('[roadmap-mcp] MCP server started (stdio)\n');

