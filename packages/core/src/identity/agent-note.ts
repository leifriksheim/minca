/**
 * @module identity/agent-note
 * A note that says its key is an agent's.
 *
 * An agent isn't an identity of its own: it writes for a person, under a note
 * from their account, like any app. The account can sign one fact into that
 * note so apps can show a record was written "via agent". It is a label, and
 * no peer acts on it: what a key may do is what its note grants
 * (`identity/abilities.ts`), and an agent's note grants records only.
 *
 * The fact is the account's word, carried in a note it signed. A note without
 * it is an ordinary app's; nothing about the key itself says "agent".
 */
import { isRecord } from '../utils/guards.js';
import { parseUCAN, type Fact } from './ucan.js';

/** The fact an agent's note carries */
export const AGENT_FACT: Fact = Object.freeze({ weave: 'agent' });

/** Whether a note (an encoded UCAN) was made out to an agent. False for anything unreadable. */
export function isAgentNote(encoded: string | null | undefined): boolean {
  if (!encoded) return false;
  try {
    const facts = parseUCAN(encoded).payload.fct;
    return (
      Array.isArray(facts) && facts.some((fact: unknown) => isRecord(fact) && fact.weave === AGENT_FACT.weave)
    );
  } catch {
    return false;
  }
}
