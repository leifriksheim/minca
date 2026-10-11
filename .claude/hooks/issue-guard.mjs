// PreToolUse hook for Bash: holds `gh issue create` to the bar in
// .claude/skills/file-issue/SKILL.md. Every other command passes untouched.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CAP = 40;
const SECTIONS = ['## Failure', '## Where', '## Why before v1', '## Checked'];
const PRIORITY = /P[0-2]: (critical|high|medium)/;

const input = JSON.parse(readFileSync(0, 'utf8'));
// Only a gh invocation counts, not the words inside a commit message, and
// flags are read from that invocation on.
const full = String(input.tool_input?.command ?? '');
const start = full.search(/(?:^|[;&|(\n])\s*gh\s+issue\s+create\b/);
if (start < 0) process.exit(0);
const command = full.slice(start);

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${reason} Follow .claude/skills/file-issue/SKILL.md.`,
      },
    }),
  );
  process.exit(0);
};

// The body is inline (--body/-b) or in a file (--body-file/-F).
let body = command;
const file = command.match(/(?:--body-file|-F)[=\s]+(?:"([^"]+)"|'([^']+)'|([^\s"';|&]+))/);
if (file) {
  const path = resolve(input.cwd ?? process.cwd(), file[1] ?? file[2] ?? file[3] ?? '');
  try {
    body += readFileSync(path, 'utf8');
  } catch {
    deny(`Couldn't read the body file ${path}. Pass a literal path, not a shell variable.`);
  }
}

const missing = SECTIONS.filter((s) => !body.includes(s));
if (missing.length > 0) deny(`The issue body is missing: ${missing.join(', ')}.`);

const parked = /--label[=\s]+["']?[^"'\s]*\bidea\b/.test(command);
if (parked) process.exit(0);

const priority = command.match(PRIORITY);
if (!priority) deny('An open issue needs a priority label: P0: critical, P1: high or P2: medium.');

if (priority[1] === 'medium') {
  let open = 0;
  try {
    open = Number(
      execFileSync(
        'gh',
        ['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number', '--jq', 'length'],
        {
          encoding: 'utf8',
          timeout: 15000,
        },
      ).trim(),
    );
  } catch {
    // Can't count offline; let gh itself fail or succeed.
  }
  if (open >= CAP)
    deny(
      `${open} issues are open, at or over the cap of ${CAP}. Only P0 and P1 can be filed now: fold this into an existing issue, or make room first.`,
    );
}
