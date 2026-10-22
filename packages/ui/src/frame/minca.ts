/**
 * `window.minca` as the kit reads it: what the page around a screen gives it
 * (`SCREEN_CLIENT` in the example app's `screens.ts`), declared once so every
 * part of the kit calls it the same way.
 */

/** A record as a screen sees it */
export interface ScreenRecord<T = Record<string, unknown>> {
  readonly key: string;
  readonly collection: string;
  readonly body: T;
  readonly links: ReadonlyArray<{ readonly rel: string; readonly to: string }>;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly seq: number;
  readonly verified: boolean;
  readonly mine: boolean;
}

/** Someone in the space who said their name */
export interface Someone {
  readonly did: string;
  readonly name: string;
}

/** A place as a search finds it */
export interface FoundPlace {
  readonly name: string;
  readonly detail: string;
  readonly street?: string;
  readonly locality?: string;
  readonly area?: string;
  readonly postcode?: string;
  readonly country?: string;
  readonly lat: number;
  readonly lon: number;
}

export interface Minca {
  readonly me: { readonly did: string; readonly name: string };
  list<T = Record<string, unknown>>(
    collection: string,
    options?: { where?: unknown },
  ): Promise<ScreenRecord<T>[]>;
  put(
    collection: string,
    body: unknown,
    options?: { links?: ReadonlyArray<{ rel: string; to: string }> },
  ): Promise<ScreenRecord>;
  people(): Promise<Someone[]>;
  can(action: string, collection: string): Promise<boolean>;
  picture(did: string): Promise<string | null>;
  open(target: { person: string } | { record: string; link?: string }): Promise<null>;
  file(key: string, ref: string): Promise<string | null>;
  blob(key: string, ref: string): Promise<Blob>;
  addFile(
    bytes: Uint8Array,
    about: { name?: string; mime?: string },
  ): Promise<{ hash: string; size: number; mime: string }>;
  download(key: string, ref: string): Promise<null>;
  readonly places: {
    search(text: string, near?: { lat: number; lon: number }): Promise<FoundPlace[]>;
    here(): Promise<FoundPlace | null>;
  };
  link(url: string): Promise<null>;
  recall(key: string): Promise<unknown>;
  remember(key: string, value: unknown): Promise<null>;
  onChange(listener: () => void): () => void;
  shown(): string | null;
  onShow(listener: (key: string) => void): () => void;
  readonly live: {
    send(data: unknown, options?: { to?: string }): Promise<boolean>;
    on(listener: (heard: Heard) => void): () => void;
  };
}

/** A live message from another device with this app open */
export interface Heard {
  /** Who sent it */
  readonly from: string;
  /** The device that sent it, to answer that device alone */
  readonly device: string;
  readonly data: unknown;
  readonly viaAgent: boolean;
}

declare global {
  /** Set up by the page around the screen before the kit runs */
  var minca: Minca;
}
