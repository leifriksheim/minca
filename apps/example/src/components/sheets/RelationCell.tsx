import type { NodeCollection, QueryRecord } from '@minca/core';
import { Icon } from '@minca/app-shared/Icon';
import { recordLabel } from '../../derive/schema-ui';
import { RecordFinder } from '../RecordFinder';
import { usePopover } from '../usePopover';
import { RelatedRecords } from './Cell';
import { Panel } from './Popover';
import { linksWith, linksWithout, relatedRecords, type Column } from './relations';
import styles from './Sheets.module.css';

/**
 * A grid cell of a relation column: the linked records as pills that open them.
 * Where the row's own links make the column, a click beside the pills opens a
 * panel to unlink one or find another record to link.
 */
export function RelationCell({
  spaceId,
  record,
  column,
  collections,
  mayEdit,
  onOpen,
  onRelink,
}: {
  spaceId: string;
  record: QueryRecord;
  column: Column;
  collections: ReadonlyArray<NodeCollection>;
  mayEdit: boolean;
  onOpen: (record: QueryRecord) => void;
  onRelink: (record: QueryRecord, links: QueryRecord['links']) => void;
}) {
  const { open, setOpen, close, root } = usePopover();
  const linked = relatedRecords(record, column);
  const ownLink = mayEdit ? column.ownLink : undefined;
  const pills = <RelatedRecords records={linked} collections={collections} onOpen={onOpen} />;
  if (!ownLink) return <div className={styles.cell}>{pills}</div>;

  const titleOf = (one: QueryRecord) =>
    recordLabel(one, collections.find((c) => c.name === one.collection)?.schema ?? null);
  const isAlreadyLinked = (key: string) => record.links.some((l) => l.rel === ownLink.rel && l.to === key);
  return (
    <div ref={root}>
      <div
        className={styles.cell}
        data-linkable
        aria-label={`Change ${column.label.toLowerCase()}`}
        onClick={() => setOpen(true)}
      >
        {pills}
      </div>
      {open && (
        <Panel anchor={root} align="start" className={styles.form}>
          {linked.map((one) => (
            <div key={one.key} className={styles.linkedRow}>
              <span>{titleOf(one)}</span>
              <button
                className={styles.tool}
                aria-label={`Unlink ${titleOf(one)}`}
                onClick={() => onRelink(record, linksWithout(record.links, ownLink.rel, one.key))}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <RecordFinder
            spaceId={spaceId}
            collections={collections}
            accepts={(candidate) =>
              candidate.key !== record.key &&
              !isAlreadyLinked(candidate.key) &&
              (ownLink.to === '*' || ownLink.to.includes(candidate.collection))
            }
            onPick={(picked) => {
              close();
              onRelink(record, linksWith(record.links, ownLink, picked.key));
            }}
            placeholder={`Find ${column.label.toLowerCase()}`}
          />
        </Panel>
      )}
    </div>
  );
}
