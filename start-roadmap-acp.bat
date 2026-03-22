@echo off
setlocal
REM OpenRoadmap Planner
REM SPDX-License-Identifier: GPL-3.0-or-later
REM Copyright (C) 2026 Rick Kühnreich (Embolex)
REM Repo: https://github.com/Chatty3mbolex/OpenRoadmap-Planner-v0.6
REM Credits: OpenAI ChatGPT 5.2-codex, Anthropic Claude (assistance)
REM
REM Start OpenRoadmap Roadmap Server using ACP backend (so MCP tools are available)
set ROADMAP_CHAT_BACKEND=acp

REM Optional: ACPX command path
REM If ACPX is on PATH, you don't need to set anything.
REM Default global npm bin path on Windows is typically: %APPDATA%\npm\acpx.cmd
if not defined ROADMAP_ACPX_CMD (
  if exist "%APPDATA%\npm\acpx.cmd" set "ROADMAP_ACPX_CMD=%APPDATA%\npm\acpx.cmd"
)

REM Optional: persistent ACP session key for the Roadmap agent
REM set ROADMAP_ACP_SESSION_KEY=agent:roadmap:main

REM Optional: API base for MCP server
set ROADMAP_API_BASE=http://localhost:3000

node server.js
pause

