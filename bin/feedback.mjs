#!/usr/bin/env node
import { execFile } from 'child_process';
import os from 'os';

const repoUrl = 'https://github.com/Riko5652/OCD/issues/new';

const title = encodeURIComponent('[Feedback] Dashboard user thoughts');
const body = encodeURIComponent(
`**What is working well for you?**
(Type here...)

**What friction are you hitting / what is missing?**
(Type here...)

---
*Auto-generated: ${os.platform()} ${os.arch()} | Node ${process.version} | RAM ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(0)}GB*`
);

const issueUrl = `${repoUrl}?title=${title}&body=${body}&labels=feedback`;

console.log('\n💬 Opening GitHub Feedback Form in your browser...\n');

const command = os.platform() === 'win32' ? 'cmd'
  : os.platform() === 'darwin' ? 'open'
  : 'xdg-open';
const cmdArgs = os.platform() === 'win32' ? ['/c', 'start', '', issueUrl] : [issueUrl];
execFile(command, cmdArgs, () => {});
