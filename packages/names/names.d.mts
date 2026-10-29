/** Types for `names.mjs`. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const NAMES_PATH: string;

/** The service's limits (see `names.mjs`) */
export interface NamesLimits {
  readonly maxNames: number;
  readonly newNamesPerNetwork: number;
  readonly workBits: number;
  readonly lifetimeMs: number;
  readonly clockSkewMs: number;
}

export declare const NAMES_LIMITS: NamesLimits;

export interface NamesSettings {
  /** The domain it answers for: names are `<name>@<domain>` */
  readonly domain: string;
  /** Where claims go, named in every answer */
  readonly claim: string;
  /** Where names are kept, a file each */
  readonly dir: string;
  readonly limits?: Partial<NamesLimits>;
}

export declare function namesFromEnv(env: Record<string, string | undefined>): NamesSettings;

export interface Names {
  /** Answers `/.well-known/minca.json`; false for any other path */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  close(): void;
}

export declare function createNames(settings: NamesSettings): Names;
