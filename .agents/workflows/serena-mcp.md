---
description: How to install and configure Serena MCP for this project
---

# Add Serena MCP to your Workflow

Serena is an open-source Model Context Protocol (MCP) server that provides advanced codebase reasoning capabilities. This workflow sets up Serena globally via `uvx` and configures it in your environment.

## 1. Prerequisites

You must have `uv` installed. If you don't have it, run:
```powershell
# For Windows
irm https://astral.sh/uv/install.ps1 | iex
```

## 2. Test Serena

To quickly run Serena without configuration, you can use `uvx` directly:

```powershell
uvx --from git+https://github.com/oraios/serena.git serena start-mcp-server
```

## 3. Cursor Configuration (Auto-enabled)

We have already configured Serena for you in your project! It is defined in `.cursor/mcp.json`.
Cursor should automatically pick up the Serena MCP server when you open the project. If it doesn't appear, you can manually add an MCP server in Cursor settings:
- Type: `command`
- Command: `uvx`
- Args: `--from git+https://github.com/oraios/serena.git serena start-mcp-server`
