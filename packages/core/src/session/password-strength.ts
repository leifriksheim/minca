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
  'summer',
  'winter',
  'spring',
  'autumn',
  'hello',
  'freedom',
  'shadow',
  'superman',
  'batman',
  'trustno',
]);

/** Letters people write as digits or symbols (p@ssw0rd), read back as letters */
const LEET: Readonly<Record<string, string>> = {
  '@': 'a',
  '4': 'a',
  '3': 'e',
  '0': 'o',
  $: 's',
  '5': 's',
  '7': 't',
  '1': 'l',
  '!': 'i',
};

const HINTS: Readonly<Record<PasswordStrength, string>> = {
  weak: 'Weak: anyone who gets a copy of your account could guess it. Longer is better.',
  fair: 'Fair. A few more characters, or another word, make it much harder to guess.',
  strong: 'Strong.',
};

/**
 * A guess at how hard `password` is to guess, and a line saying so. It reads
 * the password as the vault does, NFKC-normalised (01 §11.3), so a fullwidth
 * "ｐａｓｓｗｏｒｄ" is judged as the "password" that opens it.
 */
export function passwordStrength(password: string): PasswordCheck {
  const bits = Math.round(estimateBits(password.normalize('NFKC')));
  const strength = bits < FAIR_BITS ? 'weak' : bits < STRONG_BITS ? 'fair' : 'strong';
  return { strength, bits, hint: password ? HINTS[strength] : '' };
}

/** Each kind of character a password uses widens what a guesser must try */
const POOLS: ReadonlyArray<readonly [(c: string) => boolean, number]> = [
  [(c) => c >= 'a' && c <= 'z', 26],
  [(c) => c >= 'A' && c <= 'Z', 26],
  [(c) => c >= '0' && c <= '9', 10],
  [(c) => c < '\u0080' && !/[a-zA-Z0-9]/.test(c), 33],
  [(c) => c >= '\u0080', 100],
];

function estimateBits(password: string): number {
  const chars = [...password];
  const repeated = repeatedBits(password);
  if (repeated !== null) return repeated;

  const pool = POOLS.filter(([uses]) => chars.some(uses)).reduce((sum, [, size]) => sum + size, 0);
  if (pool === 0) return 0;
  const cap = COMMON.has(commonCore(password)) ? FAIR_BITS - 1 : Infinity;
  return Math.min(sequenceBits(chars, Math.log2(pool)), cap);
}

/** The same chunk over and over (abcabc) is the chunk and a count; null when it isn't one */
function repeatedBits(password: string): number | null {
  const lower = password.toLowerCase();
  const chars = [...password];
  for (let size = 1; size <= chars.length / 2; size++) {
    if (chars.length % size !== 0) continue;
    const chunk = [...lower].slice(0, size).join('');
    if (chunk.repeat(chars.length / size) !== lower) continue;
    const once = estimateBits(chars.slice(0, size).join(''));
    // Saying a weak password twice keeps it weak.
    return Math.min(once + Math.log2(chars.length / size), once < FAIR_BITS ? FAIR_BITS - 1 : Infinity);
  }
  return null;
}

/** The word under digits, symbols and leetspeak (p@ssw0rd1! is password) */
function commonCore(password: string): string {
  const letters = password.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return [...letters].map((c) => LEET[c] ?? c).join('');
}

/** A character that repeats the last one, or carries on a run (abc, 321), adds next to nothing */
function sequenceBits(chars: ReadonlyArray<string>, each: number): number {
  let bits = 0;
  let before: number | null = null;
  let step: number | null = null;
  for (const here of chars.map((c) => c.codePointAt(0) ?? 0)) {
    const diff = before === null ? null : here - before;
    const run = diff === 1 || diff === -1;
    bits += diff === 0 || (run && (step === null || step === diff)) ? 1 : each;
    step = run ? diff : null;
    before = here;
  }
  return bits;
}
