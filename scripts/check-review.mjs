// Fails a pull request that changes the protocol without saying what the
// adversarial review found (see CLAUDE.md). Reads the PR body from PR_BODY
// and the changed files, one per line, from stdin.
import { readFileSync } from 'node:fs';

// The spec, and the code its Source lines cite.
const PROTOCOL = [
  /^spec\//,
  /^packages\/core\/src\//,
  /^packages\/relay\/src\//,
  /^packages\/cli\/src\//,
  /^apps\/home\/src\//,
];

const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
const touched = changed.filter((file) => PROTOCOL.some((pattern) => pattern.test(file)));
if (touched.length === 0) process.exit(0);

/** A section's text, without HTML comments, up to the next heading */
function section(body, title) {
  const match = body.match(new RegExp(`^##\\s+${title}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return match ? match[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
}

const body = (process.env.PR_BODY ?? '').replace(/\r\n/g, '\n');
const problems = [];
const review = section(body, 'Adversarial review');
if (!review) problems.push('the **Adversarial review** section is missing or empty');
if (!section(body, 'Threat model')) problems.push('the **Threat model** section is missing or empty');
if (touched.some((file) => file.startsWith('spec/')) && /^not a protocol change\.?$/i.test(review))
  problems.push('it changes spec/, so it is a protocol change');

if (problems.length > 0) {
  console.error(`This PR changes protocol files:\n${touched.map((file) => `  ${file}`).join('\n')}`);
  console.error(`\nbut ${problems.join(', and ')}.`);
  console.error(
    'Run the protocol-reviewer agent (.claude/agents/protocol-reviewer.md) and fill both sections; see CLAUDE.md.',
  );
  process.exit(1);
}
