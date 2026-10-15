/**
 * How hard a password is to guess, roughly, for a meter under the field.
 *
 * Any password is allowed: this only warns. It matters because a password
 * guards a copy of the seed in the vault, and whoever copies the vault can
 * guess at it offline, as fast as their hardware runs PBKDF2.
 */

export type PasswordStrength = 'weak' | 'fair' | 'strong';

export interface PasswordCheck {
  readonly strength: PasswordStrength;
  /** The guesses it would take, as bits: a rough estimate, not a measure */
  readonly bits: number;
  /** One line to show under the field; empty for an empty password */
  readonly hint: string;
}

/**
 * Below this many bits a password is weak, and below {@link STRONG_BITS} fair.
 * At 600 000 PBKDF2 rounds one GPU tries some 10 000 to 20 000 guesses a second:
 * 40 bits is a couple of years of that, 60 bits far beyond it.
 */
const FAIR_BITS = 40;
const STRONG_BITS = 60;

/** What people pick first, which a guesser tries first: a password made of one of these is weak */
const COMMON = new Set([
  'password',
  'passw0rd',
  'qwerty',
  'qwertz',
  'azerty',
  'asdf',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'secret',
  'master',
  'login',
  'abc',
  'minca',
]);

/** A guess at how hard `password` is to guess, and a line saying so */
export function passwordStrength(password: string): PasswordCheck {
  const bits = estimateBits(password);
  if (!password) return { strength: 'weak', bits, hint: '' };
  if (bits < FAIR_BITS) {
    return {
      strength: 'weak',
      bits,
      hint: 'Weak: anyone who gets a copy of your account could guess it. Longer is better.',
    };
  }
  if (bits < STRONG_BITS) {
    return {
      strength: 'fair',
      bits,
      hint: 'Fair. A few more characters, or another word, make it much harder to guess.',
    };
  }
  return { strength: 'strong', bits, hint: 'Strong.' };
}

function estimateBits(password: string): number {
  const chars = [...password];
  let pool = 0;
  if (chars.some((c) => c >= 'a' && c <= 'z')) pool += 26;
  if (chars.some((c) => c >= 'A' && c <= 'Z')) pool += 26;
  if (chars.some((c) => c >= '0' && c <= '9')) pool += 10;
  if (chars.some((c) => c < '\u0080' && !/[a-zA-Z0-9]/.test(c))) pool += 33;
  if (chars.some((c) => c >= '\u0080')) pool += 100;
  if (pool === 0) return 0;

  // A character that repeats the last one, or carries on a run (abc, 321), adds next to nothing.
  const each = Math.log2(pool);
  const points = chars.map((c) => c.codePointAt(0) ?? 0);
  let bits = 0;
  let before: number | null = null;
  let step: number | null = null;
  for (const here of points) {
    const diff = before === null ? null : here - before;
    const run = diff === 1 || diff === -1;
    bits += diff === 0 || (run && (step === null || step === diff)) ? 1 : each;
    step = run ? diff : null;
    before = here;
  }

  // A common word with digits or symbols around it is guessed early.
  const core = password.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (COMMON.has(core)) bits = Math.min(bits, FAIR_BITS - 1);
  return Math.round(bits);
}
