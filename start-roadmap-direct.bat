@echo off
setlocal

REM OpenRoadmap Planner
REM SPDX-License-Identifier: GPL-3.0-or-later
REM Copyright (C) 2026 Rick Kühnreich (Embolex)
REM Repo: https://github.com/Chatty3mbolex/OpenRoadmap-Planner-v0.6
REM Credits: OpenAI ChatGPT 5.2-codex, Anthropic Claude (assistance)
REM
REM Start OpenRoadmap Roadmap Server using the DIRECT (OpenAI) backend.
REM Requires a server-side OpenAI API key in the environment.
REM Example (PowerShell):
REM   $env:OPENAI_API_KEY = "..."; .\start-roadmap-direct.bat

set ROADMAP_CHAT_BACKEND=direct

REM Optional: pick a model (defaults to gpt-4.1-mini)
REM set ROADMAP_OPENAI_MODEL=gpt-4.1-mini

node server.js

