# OpenRoadmap Planner v1.0.0

This is the first public release of **OpenRoadmap Planner**.

## Screenshot
![OpenRoadmap Planner UI](openroadmap-planner-ui.png)

## Highlights
- Web UI with **Systems graph** + **Storyboard** views
- Integrated **Agent/Chat panel** (with **Cancel**)
- Category editor in UI (**Edit Categories**)
- Roadmap name editor in UI (**Change Roadmap Name**)
- Connections with **arrow flags** (To / From / Both / Unspecified)
- Import/merge workflow via **Scan** (`scan/*.srd.json`)

## Run modes (3 start options)
- Gateway mode: `start-roadmap-gateway.bat`
- ACP mode: `start-roadmap-acp.bat`
- Direct mode: `start-roadmap-direct.bat`

## Data location
- Persistent DB: `data/roadmap.json`
- Optional import sources: `scan/*.srd.json`

## Notes
- Local-first tool; not security-hardened. Do not expose to the public internet.

## Credits
- Author: Rick Kühnreich (Embolex)
- Special thanks: OpenClaw Agent (gpt-5.2-codex) — implementation/integration assistance
- Credits: OpenAI ChatGPT 5.2-codex, Anthropic Claude (assistance)
