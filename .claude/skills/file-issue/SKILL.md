---
name: file-issue
description: Decide whether a finding, bug or idea becomes a GitHub issue, and file it well. Use before every `gh issue create` in this repo, for review and audit findings, bugs found while coding, and planned work. It usually ends in a comment on an existing issue, a line in the threat model, or no issue at all.
---

# Filing an issue

An open issue means **we intend to do this before v1, and someone could start
on it today**. Everything else has a better home. The backlog is capped at
40 open issues, and a hook refuses `gh issue create` without the sections
below.

Work through these steps in order. Stop at the first one that answers it.

## 1. Is it real and concrete?

Write the failure in one or two sentences: who holds what, what they do, and
what goes wrong for whom. If you can't, it is not an issue yet. Mention it in
your report or the PR and stop.

"X could be better" or "consider Y" is not a failure.

## 2. Does an issue already cover it?

Search open and closed issues, with two or three phrasings:

```bash
gh issue list --state all --limit 30 --search "<words>" --json number,title,state,labels
```

- If an open issue covers it, or covers the same area, **comment on that
  issue** with the new case. Add a checklist item if it's an umbrella. Stop.
- If a closed issue covers it, read why it was closed. If it was parked
  (`idea`) or accepted (`accepted`), comment there only if this changes the
  reasoning. Stop. If it was fixed and has come back, reopen it with the new
  evidence.

Merge generously. Two findings with the same root cause, or the same fix, are
one issue.

## 3. Should it be fixed now?

If the fix is small and inside the change you're making, fix it, with a test.
Don't file an issue for work you could finish in this PR.

## 4. Do we intend to fix it before v1?

- **No, it is a limitation we accept.** Record it where readers look: a
  bullet in `spec/threat-model.md`, or a `> **Known defect:**` note in the
  spec part. Don't file an issue. Mention in the PR that it was recorded
  there.
- **No, it is an idea for later** (a new feature, a kind of relay, a nicer
  API). File it closed, so that it can be found but doesn't count against
  the backlog. Use the same body as below:
  `gh issue create --label idea ...`, then `gh issue close N --reason "not planned"`.
- **Yes.** Go on.

## 5. File it

Give it a priority:

| Label          | Means                                                |
| -------------- | ---------------------------------------------------- |
| `P0: critical` | Exploitable or broken now, in something released.    |
| `P1: high`     | Blocks v1, or a threat model "Holds" claim is false. |
| `P2: medium`   | Will be done before v1.                              |

There is no P3. Something lower isn't an open issue: see step 4.

Check the cap:

```bash
gh issue list --state open --limit 1000 --json number --jq length
```

At 40 or more, only P0 and P1 can be filed. For P2, first make room: fold
your finding into an umbrella (step 2), or close or park an issue you're
sure of, and say which in your report.

Write the title as the failure, not the fix, in plain words: "A removed
member keeps reading after a concurrent key change", not "Fix key rotation".
Add `bug`, `security`, `enhancement` or `documentation` as fits.

The body has exactly these sections. The hook checks for the headings.

```markdown
## Failure

Who holds what, what they do, what goes wrong. Concrete steps.

## Where

The spec sections and code involved, by full path and function name.
A probe test's path, if one shows it.

## Why before v1

One or two sentences: what it costs if v1 ships with it.

## Checked

Searched: "<phrasing 1>", "<phrasing 2>". Related: #N, #M (or "none").
```

If the spec or the threat model should link the issue (a Planned section or
a Known defect), add the link in the same change and link back from the
issue, as `CLAUDE.md` requires.

## Umbrellas

When an area has three or more open issues, or keeps producing findings,
make one umbrella issue for it ("Removed members: what they can still do").
Its Failure section lists the cases as a checklist. Fold the others into it:
copy each one's Failure into a checklist item, then close it with
`gh issue close N --reason "not planned" --comment "Folded into #U."`.
Update any links in `spec/` or `packages/core/docs/` to point at the
umbrella.

## Reporting back

Say what you did with each finding, in one line each: fixed (test), joined
#N, recorded in a spec section, parked as #N, filed as #N, or dropped and why.
The PR's **Adversarial review** section takes the same list.
