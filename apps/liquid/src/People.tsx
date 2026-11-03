import { useState } from 'react';
import { useNode } from '@minca/react';
import { Modal } from '@minca/app-shared/Modal';
import { SpaceHosting } from '@minca/app-shared/SpaceHosting';
import { SpaceBots } from '@minca/app-shared/CommunitySetup';
import type { Assembly, PartyFull } from './model';
import {
  EVERYTHING,
  PARTY_RULES,
  delegation,
  membership,
  party as partyCollection,
  type PartyRule,
} from './schema';
import {
  Faces,
  PARTY_RULE_LABEL,
  PartyChip,
  PartyMark,
  Problem,
  SHADE_HUES,
  Who,
  colourOf,
  decidesText,
  partyMarkOf,
} from './ui';
import { useAction } from '@minca/app-shared/action';
import { Shape } from '@minca/app-shared/shapes';
import { SHAPE_CYCLE } from '@minca/ui/tokens';
import styles from './People.module.css';
import { ask } from '@minca/app-shared/Ask';

/** A party picks one of the shapes' colours; its record keeps it as a hue */
const shadeAt = (i: number) => SHADE_HUES[SHAPE_CYCLE[i % SHAPE_CYCLE.length] ?? 'cobalt'];

export function People({ a, writable }: { a: Assembly; writable: boolean }) {
  const [founding, setFounding] = useState(false);
  const [editing, setEditing] = useState<PartyFull | null>(null);

  return (
    <div className="stack" data-gap="loose">
      <section>
        <header>
          <div className="stack" data-gap="tight">
            <h2>Parties</h2>
            <p>
              People who vote together. Trust a party, and once it takes a position, by its members or its
              representative, your device casts that vote for you.
            </p>
          </div>
          {writable && <button onClick={() => setFounding(true)}>Start a party</button>}
        </header>
        {a.parties.length === 0 ? (
          <small>No parties yet. Everyone here stands for themselves.</small>
        ) : (
          <div className={styles.grid}>
            {a.parties.map((p) => (
              <PartyCard key={p.key} a={a} p={p} writable={writable} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="stack" data-gap="tight">
          <h2>Members</h2>
          <p>Everyone who can vote. Trust someone with everything here, or topic by topic under Your vote.</p>
        </div>
        <ul role="list">
          {[...a.members]
            .sort((x, y) =>
              x.did === a.me ? -1 : y.did === a.me ? 1 : a.name(x.did).localeCompare(a.name(y.did)),
            )
            .map((m) => (
              <MemberRow key={m.did} a={a} did={m.did} role={m.role} writable={writable} />
            ))}
        </ul>
      </section>

      <SpaceHosting spaceId={a.spaceId} writable={writable} />
      <SpaceBots spaceId={a.spaceId} writable={writable} />

      {founding && <PartyForm a={a} onClose={() => setFounding(false)} />}
      {editing && <PartyForm a={a} editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MemberRow({
  a,
  did,
  role,
  writable,
}: {
  a: Assembly;
  did: string;
  role: string;
  writable: boolean;
}) {
  const node = useNode();
  const action = useAction();
  const trusted = a.delegations.filter((d) => d.kind === 'person' && d.to === did).length;
  const parties = a.parties.filter((p) => p.members.has(did));
  const mine = a.mine.find((d) => d.topic === EVERYTHING);
  const trustsThem = mine?.kind === 'person' && mine.to === did;
  const roleTitle = a.roles.find((r) => r.name === role)?.title ?? role;

  return (
    <li className="row">
      <Who did={did} a={a} size={32} />
      {role !== 'member' && <span className="tag">{roleTitle}</span>}
      {parties.map((p) => (
        <PartyChip key={p.key} party={p} />
      ))}
      <span className={`row ${styles.end}`}>
        {trusted > 0 && <small>trusted {trusted}×</small>}
        {writable && did !== a.me && (
          <button
            data-intent={trustsThem ? 'primary' : undefined}
            disabled={action.busy}
            title={
              trustsThem
                ? 'They vote for you on everything you haven’t given someone else. Click to stop.'
                : undefined
            }
            onClick={() =>
              void action.run(() =>
                trustsThem && mine
                  ? node.records.delete(a.spaceId, mine.key)
                  : node.records.put(a.spaceId, delegation, { kind: 'person', to: did, topic: EVERYTHING }),
              )
            }
          >
            {trustsThem ? 'Trusted with everything' : 'Trust with everything'}
          </button>
        )}
      </span>
      <Problem>{action.error}</Problem>
    </li>
  );
}

function PartyCard({
  a,
  p,
  writable,
  onEdit,
}: {
  a: Assembly;
  p: PartyFull;
  writable: boolean;
  onEdit: () => void;
}) {
  const node = useNode();
  const action = useAction();
  const [requests, setRequests] = useState(false);
  const steward = p.stewards.has(a.me);
  const myAsk = p.asked.get(a.me) ?? null;
  const inIt = p.members.has(a.me);
  const waiting = [...p.asked.keys()].filter(
    (did) => !p.members.has(did) && a.members.some((m) => m.did === did),
  );
  const trusted = a.delegations.filter((d) => d.kind === 'party' && d.to === p.key).length;

  const setMembers = (members: ReadonlyArray<string>) =>
    void action.run(() =>
      node.records.update(a.spaceId, p.key, {
        name: p.name,
        ...(p.platform ? { platform: p.platform } : {}),
        hue: p.hue,
        members: [...new Set([...p.stewards, ...members])],
        stewards: [...p.stewards],
        ...ruleBody(p.decides, p.representative),
      }),
    );

  return (
    <article>
      <div className={styles.head}>
        <PartyMark party={p} size={40} />
        <div>
          <h3>{p.name}</h3>
          <small>
            {p.members.size} {p.members.size === 1 ? 'member' : 'members'}
            {trusted ? ` · trusted by ${trusted}` : ''}
          </small>
          <small>Decides: {decidesText(a, p)}</small>
        </div>
        {steward && writable && (
          <button data-intent="ghost" onClick={onEdit}>
            Edit
          </button>
        )}
      </div>
      {p.platform && <p className={styles.platform}>{p.platform}</p>}
      <Faces dids={[...p.members].slice(0, 8)} />
      <div className={`row ${styles.foot}`} data-gap="tight">
        {writable &&
          (steward ? (
            <span className="tag">You’re a steward</span>
          ) : inIt || myAsk ? (
            // Leaving, or taking back the ask: either way, the ask goes.
            <button
              disabled={action.busy}
              title={inIt ? undefined : 'A steward lets members in'}
              onClick={() => myAsk && void action.run(() => node.records.delete(a.spaceId, myAsk))}
            >
              {inIt ? 'Leave' : 'Asked · Cancel'}
            </button>
          ) : (
            <button
              data-intent="primary"
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  node.records.put(a.spaceId, membership, {}, { links: [{ rel: 'about', to: p.key }] }),
                )
              }
            >
              Ask to join
            </button>
          ))}
        {steward && writable && waiting.length > 0 && (
          <button data-intent="primary" onClick={() => setRequests((was) => !was)}>
            {waiting.length} asking to join
          </button>
        )}
      </div>
      {requests && steward && waiting.length > 0 && (
        <div className={styles.requests}>
          {waiting.map((did) => (
            <div key={did} className="row" data-spread>
              <Who did={did} a={a} size={22} />
              <button
                data-intent="primary"
                disabled={action.busy}
                onClick={() => setMembers([...p.listed, did])}
              >
                Let in
              </button>
            </div>
          ))}
        </div>
      )}
      {p.decides === 'representative' && !(p.representative && p.members.has(p.representative)) && (
        <aside data-tone="warn">
          Its representative isn’t a member, so it can’t take a position on new proposals. A steward picks
          another under Edit.
        </aside>
      )}
      {steward && writable && p.stewards.size === 1 && (
        <aside data-tone="warn">
          You’re its only steward. If you stop using Liquid, nobody can let people in or freeze its members
          for new proposals, and it can’t take a position again. Add a second steward under Edit.
        </aside>
      )}
      <Problem>{action.error}</Problem>
    </article>
  );
}

function PartyForm({ a, editing, onClose }: { a: Assembly; editing?: PartyFull; onClose: () => void }) {
  const node = useNode();
  const [name, setName] = useState(editing?.name ?? '');
  const [platform, setPlatform] = useState(editing?.platform ?? '');
  const [shade, setShade] = useState(editing?.hue ?? shadeAt(a.parties.length));
  const [decides, setDecides] = useState<PartyRule>(editing?.decides ?? 'majority');
  const [representative, setRepresentative] = useState<string>(editing?.representative ?? a.me);
  const action = useAction();
  const members = editing ? [...editing.listed].filter((did) => did !== a.me) : [];
  const stewards = editing ? editing.stewards : new Set([a.me]);

  const save = (listed: ReadonlyArray<string>, keepers: ReadonlySet<string> = stewards) =>
    action.run(async () => {
      const body = {
        name: name.trim(),
        ...(platform.trim() ? { platform: platform.trim() } : {}),
        hue: shade,
        members: [...new Set([a.me, ...keepers, ...listed])],
        stewards: [...keepers],
        ...ruleBody(decides, representative),
      };
      if (editing) {
        await node.records.update(a.spaceId, editing.key, body);
      } else {
        const made = await node.records.put(a.spaceId, partyCollection, body);
        await node.records.put(a.spaceId, membership, {}, { links: [{ rel: 'about', to: made.key }] });
      }
      onClose();
    });
  const withSteward = (did: string, on: boolean) => {
    const next = new Set(stewards);
    if (on) next.add(did);
    else next.delete(did);
    return next;
  };

  return (
    <Modal title={editing ? `Edit ${editing.name}` : 'Start a party'} onClose={onClose} width={480}>
      <form
        className="stack"
        data-gap="loose"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void save(editing ? [...editing.listed] : []);
        }}
      >
        <div className={styles.name}>
          <PartyMark party={{ name: name || '?', hue: shade }} size={44} />
          <label>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="The Green Bench"
              maxLength={80}
              autoFocus
            />
          </label>
        </div>
        <div role="radiogroup" aria-label="Colour" className={`row ${styles.colours}`} data-gap="tight">
          {SHAPE_CYCLE.map((colour) => {
            const picked = colourOf(shade) === colour;
            return (
              <button
                key={colour}
                type="button"
                role="radio"
                data-icon
                data-intent="ghost"
                aria-checked={picked}
                aria-label={colour.charAt(0).toUpperCase() + colour.slice(1)}
                onClick={() => setShade(SHADE_HUES[colour])}
              >
                <Shape kind={partyMarkOf(name || '?', shade).kind} colour={colour} size={24} />
              </button>
            );
          })}
        </div>
        <label>
          What it stands for
          <textarea
            rows={4}
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
            placeholder="More green space, fewer car parks, and a budget everyone can read."
            maxLength={2000}
          />
        </label>
        <fieldset>
          <legend>How it takes a position</legend>
          <div className="row" data-gap="tight" role="group" aria-label="How it decides">
            {PARTY_RULES.map((rule) => (
              <button
                key={rule}
                type="button"
                aria-pressed={decides === rule}
                onClick={() => setDecides(rule)}
              >
                {PARTY_RULE_LABEL[rule]}
              </button>
            ))}
          </div>
          {decides === 'representative' ? (
            <>
              <select
                value={representative}
                onChange={(event) => setRepresentative(event.target.value)}
                aria-label="Representative"
              >
                {[a.me, ...members].map((did) => (
                  <option key={did} value={did}>
                    {did === a.me ? `${a.name(did)} (you)` : a.name(did)}
                  </option>
                ))}
              </select>
              <small>
                Their own vote on a proposal is the party’s, and everyone who trusts the party follows it. A
                vote they cast by following someone doesn’t count.
              </small>
            </>
          ) : (
            <small>
              It takes a position once{' '}
              {decides === 'everyone' ? 'all' : PARTY_RULE_LABEL[decides].toLowerCase()} of its members vote
              the same way themselves. Until then, nobody who trusts it votes by it.
            </small>
          )}
          <small>Changing this applies to proposals made from now on.</small>
        </fieldset>
        {editing && members.length > 0 && (
          <fieldset>
            <legend>Members</legend>
            {members.map((did) => (
              <div key={did} className="row">
                <Who did={did} a={a} size={22} />
                {stewards.has(did) && <span className="tag">Steward</span>}
                <button
                  type="button"
                  className={styles.end}
                  data-intent="ghost"
                  disabled={action.busy}
                  onClick={() => void save(members, withSteward(did, !stewards.has(did)))}
                >
                  {stewards.has(did) ? 'Not a steward' : 'Make steward'}
                </button>
                <button
                  type="button"
                  data-intent="ghost"
                  disabled={action.busy || (decides === 'representative' && representative === did)}
                  title={
                    decides === 'representative' && representative === did
                      ? 'They’re its representative. Pick another first.'
                      : undefined
                  }
                  onClick={() =>
                    void save(
                      members.filter((m) => m !== did),
                      withSteward(did, false),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </fieldset>
        )}
        {editing && stewards.size === 1 && (
          <small>Give it a second steward, so the party carries on if you stop using Liquid.</small>
        )}
        {!editing && (
          <small>
            You start it as its steward: you let people in, and your device freezes its members for each new
            proposal. Make other members stewards too, so it doesn’t depend on you alone.
          </small>
        )}
        <Problem>{action.error}</Problem>
        <div className={`row ${styles.actions}`}>
          {editing && (
            <button
              type="button"
              data-intent="danger"
              disabled={action.busy}
              onClick={() =>
                void ask('Everyone who trusts it will need to vote themselves, or trust someone else.', {
                  title: `Dissolve ${editing.name}?`,
                  yes: 'Dissolve',
                  danger: true,
                }).then(async (sure) => {
                  if (sure)
                    await action.run(async () => {
                      await node.records.delete(a.spaceId, editing.key);
                      onClose();
                    });
                })
              }
            >
              Dissolve
            </button>
          )}
          <button type="button" data-intent="ghost" onClick={onClose}>
            Cancel
          </button>
          <button data-intent="primary" disabled={!name.trim() || action.busy}>
            {action.busy ? 'Saving…' : editing ? 'Save' : 'Start party'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A party's rule, as its body says it: a representative only when it decides by one */
function ruleBody(decides: PartyRule, representative: string | null) {
  return decides === 'representative' && representative ? { decides, representative } : { decides };
}
