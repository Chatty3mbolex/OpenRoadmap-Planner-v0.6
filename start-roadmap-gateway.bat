@echo off
setlocal
REM OpenRoadmap Planner
REM SPDX-License-Identifier: GPL-3.0-or-later
REM Copyright (C) 2026 Rick Kühnreich (Embolex)
REM Repo: https://github.com/Chatty3mbolex/OpenRoadmap-Planner-v0.6
REM Credits: OpenAI ChatGPT 5.2-codex, Anthropic Claude (assistance)
REM
REM Start OpenRoadmap Roadmap Server using Gateway backend (default)
set ROADMAP_CHAT_BACKEND=gateway
set ROADMAP_API_BASE=http://localhost:3000
node server.js
pause

