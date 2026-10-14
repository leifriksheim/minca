import type { CodeAsking, ConnectOptions } from '@minca/core/session';

/**
 * What this app asks the account home for, for a program that asked over a
 * connect code: records in the whole account, for `days`, or nothing. What
 * the program asked for is only a request; the terms are this app's. One
 * that asks for more than records is denied: its proof binds what it asked,
 * so the home would refuse it records only anyway.
 */
export function programRequest(asking: CodeAsking, days: number): ConnectOptions['request'] | null {
  if (!asking.recordsOnly) return null;
  return {
    name: asking.name,
    access: 'write',
    scope: 'account',
    chooseSpaces: false,
    recordsOnly: true,
    days,
  };
}
