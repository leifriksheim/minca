## What

<!-- What changes, and why. Link issues: Fixes #N, Refs #N. -->

## Spec and docs

<!-- Which sections of spec/ or packages/core/docs/ change. A protocol change changes the spec in the same PR. -->

## Adversarial review

<!--
Required for any change to spec/ or code a spec Source line cites; CI checks it (scripts/check-review.mjs).
Run the protocol-reviewer agent on the branch (.claude/agents/protocol-reviewer.md),
then list each finding and what was done about it, through the file-issue skill: fixed (with the test that shows it),
joined (#N), recorded (spec section), parked (#N), filed (#N), or why it isn't one.
Run it again after fixing a blocker. Write "Not a protocol change" for a change outside the protocol.
-->

## Threat model

<!-- Does any guarantee or gap in spec/threat-model.md change? Then that page changes here. "No change" otherwise. -->

## Tests

<!-- What shows it works, and what shows the attack fails: a test that fails without the change. -->
