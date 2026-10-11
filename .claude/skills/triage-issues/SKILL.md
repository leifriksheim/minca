---
name: triage-issues
description: Sweep the open GitHub issues and bring the backlog back under its cap of 40. Folds related issues into umbrellas, parks ideas, records accepted limitations in the spec, closes what is done or stale. Use when asked to clean up or triage issues, monthly, and before a release.
---

# Triaging the backlog

The bar for an open issue is in `.claude/skills/file-issue/SKILL.md`: we
intend to do it before v1, it has a concrete failure, and no other issue
covers it. This sweep applies that bar to everything already open. The target
is **no more than 40 open issues**, every one P0, P1 or P2.

## 1. Gather

```bash
gh issue list --state open --limit 1000 \
  --json number,title,body,labels,createdAt,updatedAt,comments > <scratchpad>/open.json
grep -rnoE "issues/[0-9]+" spec packages/core/docs
git log --oneline -60
```

The grep shows which issues the spec and docs link. Closing or folding one of
those means updating the link in the same change.

## 2. Decide, one issue at a time

Give each issue exactly one verdict:

| Verdict    | When                                                                      | Action                                                                             |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **done**   | A merged commit or PR already fixed it.                                   | Close as completed, naming the commit or PR.                                       |
| **fold**   | Same root cause, same fix, or same area as others.                        | Fold into an umbrella (new or existing), close as not planned: "Folded into #U."   |
| **accept** | A real limitation we won't fix before v1.                                 | Make sure the threat model or a Known defect says it; close with label `accepted`. |
| **park**   | An idea or feature for after v1, or a P3.                                 | Label `idea`, close as not planned. Still searchable.                              |
| **drop**   | Not a real failure, can't be reproduced, or overtaken by a design change. | Close as not planned, with one sentence saying why.                                |
| **keep**   | Passes the bar.                                                           | Fix its priority. Rewrite the title or body if it doesn't say the failure plainly. |

Prefer fold over keep when in doubt: one well-written umbrella is worth more
than five fragments. Flaky tests share one umbrella. Spec-wording issues share
one umbrella.

Don't decide on age alone. An old P1 that is still true is kept.

## 3. Show the plan before changing anything

Write the plan as a table: issue, title, verdict, target (umbrella or spec
section), and a one-line reason. Put umbrellas first, with the issues each
absorbs. End with the counts: open before and after, and how many of each
verdict.

Closing issues is visible to everyone watching the repo. Show the plan to the
user and wait for their approval, or for their edits, before running any `gh`
command that changes something. On a scheduled run with no one present, stop
at the plan.

## 4. Apply

In this order, so no link points nowhere:

1. Create any missing labels (`idea`, `accepted`) and the umbrella issues,
   with the `file-issue` body format. Each umbrella lists its cases as a
   checklist with the original numbers.
2. Update the links in `spec/` and `packages/core/docs/` from folded issues to
   their umbrella, and add the threat model or Known defect text for
   accepted issues. That is a change to `spec/`: it goes on a branch and
   through a PR, like any other.
3. Close the issues, each with its comment.
4. Edit the titles, bodies and labels of kept issues.

Report the final counts, and anything you weren't sure enough to change.
