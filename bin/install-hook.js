#!/usr/bin/env node

/**
 * Shell hook installer for OCD IDE interception.
 *
 * Appends a PROMPT_COMMAND (bash) or precmd (zsh) hook to the user's shell RC
 * that pipes stderr from the previous command to OCD's watched log file.
 * This enables proactive error detection without manual setup.
 *
 * Usage:
 *   npx ai-productivity-dashboard install-hook
 *   node bin/install-hook.js [--remove] [--shell bash|zsh]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.ocd');
const LOG_FILE = path.join(LOG_DIR, 'terminal.log');

const HOOK_MARKER_START = '# >>> OCD IDE Interception Hook >>>';
const HOOK_MARKER_END = '# <<< OCD IDE Interception Hook <<<';

const BASH_HOOK = `
${HOOK_MARKER_START}
# Captures stderr from the last command to OCD's terminal log for proactive error detection.
# See: https://github.com/Riko5652/OCD
__ocd_log="${LOG_FILE}"
mkdir -p "$(dirname "$__ocd_log")"
__ocd_prompt_command() {
  local exit_code=$?
  if [ $exit_code -ne 0 ] && [ -f /tmp/__ocd_stderr_$$ ]; then
    cat /tmp/__ocd_stderr_$$ >> "$__ocd_log" 2>/dev/null
  fi
  rm -f /tmp/__ocd_stderr_$$
}
PROMPT_COMMAND="__ocd_prompt_command;\${PROMPT_COMMAND}"
# Wrap command execution to capture stderr
__ocd_preexec() {
  exec 2> >(tee -a /tmp/__ocd_stderr_$$ >&2)
}
trap '__ocd_preexec' DEBUG
${HOOK_MARKER_END}
`;

const ZSH_HOOK = `
${HOOK_MARKER_START}
# Captures stderr from the last command to OCD's terminal log for proactive error detection.
# See: https://github.com/Riko5652/OCD
__ocd_log="${LOG_FILE}"
mkdir -p "$(dirname "$__ocd_log")"
__ocd_preexec() {
  exec 2> >(tee -a /tmp/__ocd_stderr_$$ >&2)
}
__ocd_precmd() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]] && [[ -f /tmp/__ocd_stderr_$$ ]]; then
    cat /tmp/__ocd_stderr_$$ >> "$__ocd_log" 2>/dev/null
  fi
  rm -f /tmp/__ocd_stderr_$$
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __ocd_preexec
add-zsh-hook precmd __ocd_precmd
${HOOK_MARKER_END}
`;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    remove: args.includes('--remove'),
    shell: args.includes('--shell') ? args[args.indexOf('--shell') + 1] : null,
    help: args.includes('--help') || args.includes('-h'),
  };
}

function detectShell() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  // Check if RC files exist
  if (fs.existsSync(path.join(HOME, '.zshrc'))) return 'zsh';
  if (fs.existsSync(path.join(HOME, '.bashrc'))) return 'bash';
  return 'bash'; // default
}

function getRcPath(shell) {
  if (shell === 'zsh') return path.join(HOME, '.zshrc');
  return path.join(HOME, '.bashrc');
}

function hasHook(rcContent) {
  return rcContent.includes(HOOK_MARKER_START);
}

function removeHook(rcContent) {
  const startIdx = rcContent.indexOf(HOOK_MARKER_START);
  const endIdx = rcContent.indexOf(HOOK_MARKER_END);
  if (startIdx === -1 || endIdx === -1) return rcContent;
  // Remove from the newline before the marker to the newline after
  const before = rcContent.slice(0, Math.max(0, rcContent.lastIndexOf('\n', startIdx)));
  const after = rcContent.slice(endIdx + HOOK_MARKER_END.length);
  return before + after;
}

function main() {
  const flags = parseArgs();

  if (flags.help) {
    console.log(`
Usage: install-hook [options]

Installs a shell hook that captures terminal errors for OCD's
proactive IDE interception. Errors are logged to:
  ${LOG_FILE}

Options:
  --shell <bash|zsh>  Force shell type (auto-detected by default)
  --remove            Remove the OCD hook from your shell RC
  -h, --help          Show this help message
`);
    process.exit(0);
  }

  const shell = flags.shell || detectShell();
  const rcPath = getRcPath(shell);
  const hookContent = shell === 'zsh' ? ZSH_HOOK : BASH_HOOK;

  // Ensure log directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });

  // Read existing RC (or empty string if file doesn't exist)
  let rc = '';
  try { rc = fs.readFileSync(rcPath, 'utf-8'); } catch { /* new file */ }

  if (flags.remove) {
    if (!hasHook(rc)) {
      console.log(`No OCD hook found in ${rcPath}.`);
      return;
    }
    const updated = removeHook(rc);
    fs.writeFileSync(rcPath, updated, 'utf-8');
    console.log(`Removed OCD hook from ${rcPath}.`);
    console.log('Restart your terminal or run: source ' + rcPath);
    return;
  }

  if (hasHook(rc)) {
    console.log(`OCD hook already installed in ${rcPath}.`);
    console.log(`Log file: ${LOG_FILE}`);
    console.log('Use --remove to uninstall.');
    return;
  }

  fs.writeFileSync(rcPath, rc + '\n' + hookContent, 'utf-8');
  console.log(`OCD shell hook installed in ${rcPath} (${shell})`);
  console.log(`Terminal errors will be captured to: ${LOG_FILE}`);
  console.log('');
  console.log('Restart your terminal or run:');
  console.log(`  source ${rcPath}`);
}

main();
