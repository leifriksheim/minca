/** What the home makes of the automations an app proposes, once the person says yes */
import { canonicalize, checkOwnAutomation, type AutomationProposal, type OwnAutomation } from '@minca/core';
import type { AutomationApp, AutomationSpaces } from '@minca/core/schemas';

/**
 * The spaces a proposal looks at, given the ones the app may reach; null when
 * it names one outside them.
 */
export function proposalSpaces(
  proposal: AutomationProposal,
  reach: AutomationSpaces,
): AutomationSpaces | null {
  if (!proposal.spaces) return reach;
  if (reach !== 'all' && proposal.spaces.some((id) => !reach.includes(id))) return null;
  return [...new Set(proposal.spaces)];
}

/** The automation a proposal becomes, once the person says yes to it */
export function fromProposal(
  proposal: AutomationProposal,
  context: { readonly app: AutomationApp; readonly spaces: AutomationSpaces; readonly since?: string },
): OwnAutomation {
  const name = proposal.name.trim();
  const own: OwnAutomation = {
    name,
    when: { query: proposal.when.query, others: proposal.when.others ?? true },
    then: proposal.then ?? { kind: 'notify', text: name },
    spaces: context.spaces,
    open: proposal.open ?? `${context.app.origin}/`,
    since: context.since ?? new Date().toISOString(),
    app: context.app,
  };
  // An app on plain http elsewhere than this machine: a click goes to the home instead.
  if (checkOwnAutomation(own) === null || proposal.open !== undefined) return own;
  const { open: _open, ...rest } = own;
  return rest;
}

/** Whether two of the account's automations ask about the same thing: an app connecting again adds nothing twice */
export function sameAutomation(a: OwnAutomation, b: OwnAutomation): boolean {
  const spaces = (s: AutomationSpaces) => (s === 'all' ? 'all' : [...s].sort().join(','));
  return (
    canonicalize(a.when.query) === canonicalize(b.when.query) &&
    spaces(a.spaces) === spaces(b.spaces) &&
    (a.when.others ?? false) === (b.when.others ?? false) &&
    canonicalize(a.then) === canonicalize(b.then)
  );
}
