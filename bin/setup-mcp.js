#!/usr/bin/env node

// MCP auto-setup CLI — registers ai-brain server in Claude Code, Cursor, and Windsurf configs
import fs from 'fs';
import path from 'path';
import os from 'os';

const SERVER_NAME = 'ai-brain';
const SERVER_ENTRY = {
  command: 'npx',
  args: ['ai-productivity-dashboard', '--mcp'],
};

const HOME = os.homedir();

// All known MCP config locations, in priority order per tool
const CONFIG_LOCATIONS = [
  { tool: 'Claude Code', paths: [path.join(HOME, '.claude', '.mcp.json'), path.join(HOME, '.claude', 'mcp.json')] },
  { tool: 'Cursor',      paths: [path.join(HOME, '.cursor', 'mcp.json')] },
  { tool: 'Windsurf',    paths: [path.join(HOME, '.windsurf', 'mcp.json'), path.join(HOME, '.codeium', 'windsurf', 'mcp.json')] },
];

// --------------- Helpers ---------------

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    project: args.includes('--project'),
    remove: args.includes('--remove'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printUsage() {
  console.log(`
Usage: setup-mcp [options]

Options:
  --project   Write .mcp.json to current working directory instead of global configs
  --remove    Remove the ${SERVER_NAME} entry from all detected configs
  -h, --help  Show this help message

Without flags, adds the ${SERVER_NAME} MCP server to all detected tool configs.
`);
}

/**
 * Safely read and parse a JSON file. Returns null if the file does not exist
 * or is not valid JSON.
 */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      console.warn(`  Warning: ${filePath} contains invalid JSON, skipping.`);
      return undefined; // sentinel: file exists but is broken
    }
    throw err;
  }
}

/**
 * Write JSON to a file, creating parent directories as needed.
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Resolve which config file to use for a tool. Picks the first path that
 * already exists on disk; otherwise returns the first path as the default
 * location for a new file.
 */
function resolveConfigPath(candidatePaths) {
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return candidatePaths[0];
}

// --------------- Core operations ---------------

function addServer(filePath, toolName) {
  const existing = readJson(filePath);
  if (existing === undefined) return; // broken JSON, already warned

  const config = existing || {};
  if (!config.mcpServers) config.mcpServers = {};

  if (config.mcpServers[SERVER_NAME]) {
    console.log(`  [${toolName}] ${SERVER_NAME} already present in ${filePath} — updated.`);
  } else {
    console.log(`  [${toolName}] Added ${SERVER_NAME} to ${filePath}`);
  }

  config.mcpServers[SERVER_NAME] = { ...SERVER_ENTRY };

  try {
    writeJson(filePath, config);
  } catch (err) {
    console.error(`  [${toolName}] Error writing ${filePath}: ${err.message}`);
  }
}

function removeServer(filePath, toolName) {
  const existing = readJson(filePath);
  if (existing == null) return false; // file doesn't exist or null
  if (existing === undefined) return false; // broken JSON

  if (!existing.mcpServers || !existing.mcpServers[SERVER_NAME]) {
    return false;
  }

  delete existing.mcpServers[SERVER_NAME];
  // Clean up empty mcpServers object
  if (Object.keys(existing.mcpServers).length === 0) {
    delete existing.mcpServers;
  }

  try {
    writeJson(filePath, existing);
    console.log(`  [${toolName}] Removed ${SERVER_NAME} from ${filePath}`);
    return true;
  } catch (err) {
    console.error(`  [${toolName}] Error writing ${filePath}: ${err.message}`);
    return false;
  }
}

// --------------- Main ---------------

function main() {
  const flags = parseArgs();

  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  // --project mode: write to cwd
  if (flags.project) {
    const target = path.join(process.cwd(), '.mcp.json');

    if (flags.remove) {
      console.log('Removing project MCP config...');
      if (removeServer(target, 'Project')) {
        console.log('Done.');
      } else {
        console.log(`  No ${SERVER_NAME} entry found in ${target}`);
      }
      return;
    }

    console.log('Setting up project MCP config...');
    addServer(target, 'Project');
    console.log('Done.');
    return;
  }

  // Global mode: iterate all known config locations
  if (flags.remove) {
    console.log(`Removing ${SERVER_NAME} from all detected MCP configs...\n`);
    let removedAny = false;
    for (const { tool, paths: candidates } of CONFIG_LOCATIONS) {
      for (const candidate of candidates) {
        if (removeServer(candidate, tool)) {
          removedAny = true;
        }
      }
    }
    if (!removedAny) {
      console.log(`  No ${SERVER_NAME} entries found in any config.`);
    }
    console.log('\nDone.');
    return;
  }

  console.log(`Setting up ${SERVER_NAME} MCP server...\n`);
  let configuredAny = false;

  for (const { tool, paths: candidates } of CONFIG_LOCATIONS) {
    const configPath = resolveConfigPath(candidates);
    // Only configure if the parent directory exists (tool is installed)
    const parentDir = path.dirname(configPath);
    if (!fs.existsSync(parentDir)) {
      console.log(`  [${tool}] Skipped — ${parentDir} not found.`);
      continue;
    }
    addServer(configPath, tool);
    configuredAny = true;
  }

  if (!configuredAny) {
    console.log('  No supported tool configs detected. Use --project to write to current directory.');
  }

  console.log('\nDone.');
}

main();
