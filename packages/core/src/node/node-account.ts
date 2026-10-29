/**
 * @module node-account
 * The account's profile: its name and picture, kept in its registry, and
 * told to each space it uses as that space opens.
 */
import { cached } from '../utils/map.js';
import {
  isAvatarRef,
  PROFILE_COLLECTION,
  PROFILE_KEY,
  type AccountProfile,
  type AvatarRef,
} from '../space/account-registry.js';
import type { SpaceRuntime } from './space-runtime.js';
import type { AccountProfileView, NodeAccount } from './types.js';
import { inBackground, type NodeContext } from './node-context.js';

export function createNodeAccount(ctx: NodeContext) {
  const { config, accountSpaceId, contactKeys } = ctx;

  /**
   * The account's profile, from its registry — null without an account key,
   * or before one is set. One record: its current version is the name, by the
   * ordering rule, the same on every device whatever their clocks say.
   */
  async function ownProfile(): Promise<AccountProfileView | null> {
    if (!accountSpaceId) return null;
    const profile = await (await ctx.runtime(accountSpaceId)).get<AccountProfile>(PROFILE_KEY);
    if (!profile?.verified || profile.root !== config.signer.did || typeof profile.body?.name !== 'string')
      return null;
    const avatar = profile.body.avatar;
    return {
      name: profile.body.name,
      updatedAt: profile.updatedAt,
      ...(isAvatarRef(avatar) ? { avatar } : {}),
    };
  }
  const ownName = async () => (await ownProfile())?.name ?? null;

  /**
   * Tells a space who this account is. Done when the space opens and when the
   * name changes — not by opening every space, which would start syncing them
   * all; a space not open now hears on its next open.
   */
  async function publishProfile(spaceId: string, open: SpaceRuntime): Promise<void> {
    if (ctx.narrowNote || (await ctx.kindOf(spaceId))) return;
    const own = await ownProfile();
    if (!own) return;
    const base = { name: own.name, ...(contactKeys ? { contactKey: contactKeys.publicKey } : {}) };
    const held = await heldAvatar(open);
    const copied = held?.source === own.avatar?.hash ? held : undefined;
    // The name goes out now with the picture the space has; a new picture follows once copied,
    // which may wait on its bytes reaching this device.
    const shown = own.avatar ? (copied ?? held) : undefined;
    await open.publishProfile({ ...base, ...(shown ? { avatar: shown } : {}) });
    if (own.avatar && !copied)
      inBackground(
        avatarIn(spaceId, open, own.avatar).then((avatar) => open.publishProfile({ ...base, avatar })),
      );
  }

  /** The account's picture as this space shows it */
  async function heldAvatar(open: SpaceRuntime): Promise<AvatarRef | undefined> {
    const avatar = (await open.profiles()).find((profile) => profile.did === config.signer.did)?.avatar;
    return isAvatarRef(avatar) ? avatar : undefined;
  }

  const avatarCopies = new Map<string, Promise<AvatarRef>>();
  /**
   * The account's picture as a file of this space: members can't read the
   * registry, so each space holds its own copy, made once per picture.
   */
  function avatarIn(spaceId: string, open: SpaceRuntime, avatar: AvatarRef): Promise<AvatarRef> {
    return cached(avatarCopies, `${spaceId}:${avatar.hash}`, async () => {
      const held = await heldAvatar(open);
      if (held?.source === avatar.hash) return held;
      const registryRt = await ctx.requireAccount('Copying the picture');
      const copy = await open.addFile(await registryRt.readFile(avatar));
      return { ...copy, mime: avatar.mime, source: avatar.hash };
    });
  }

  async function publishProfileToOpenSpaces(): Promise<void> {
    for (const [spaceId, open] of ctx.runtimes) {
      await open.then((rt) => publishProfile(spaceId, rt)).catch(() => {});
    }
  }

  /** Writes the account's profile, and tells every open space */
  async function writeProfile(registryRt: SpaceRuntime, profile: AccountProfile) {
    const written = await registryRt.upsertSystem<AccountProfile>(PROFILE_COLLECTION, PROFILE_KEY, profile);
    ctx.emit({ type: 'account' });
    await publishProfileToOpenSpaces();
    return { ...profile, updatedAt: written.updatedAt };
  }

  const account = Object.freeze<NodeAccount>({
    profile: ownProfile,
    async setName(name) {
      const registryRt = await ctx.requireAccount('Renaming across devices');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('A name cannot be empty');
      const avatar = (await ownProfile())?.avatar;
      return writeProfile(registryRt, { name: trimmed, ...(avatar ? { avatar } : {}) });
    },
    async setAvatar(image, options = {}) {
      const registryRt = await ctx.requireAccount('Changing the picture across devices');
      const name = (await ownName()) ?? options.name?.trim();
      if (!name) throw new Error('Give the account a name first');
      if (image && !image.mime.startsWith('image/')) throw new Error('A picture is an image');
      const avatar = image ? { ...(await registryRt.addFile(image.bytes)), mime: image.mime } : null;
      return writeProfile(registryRt, { name, ...(avatar ? { avatar } : {}) });
    },
    async picture() {
      const avatar = (await ownProfile())?.avatar;
      if (!avatar || !accountSpaceId) return null;
      return { bytes: await (await ctx.runtime(accountSpaceId)).readFile(avatar), mime: avatar.mime };
    },
    revoke: async (key, options) =>
      (await ctx.requireAccount('Revoking in the account registry')).revoke(key, options),
  });

  return Object.freeze({ account, ownName, publishProfile, publishProfileToOpenSpaces });
}
