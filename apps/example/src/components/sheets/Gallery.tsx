import { Card } from './Board';
import { NewRow } from './NewRow';
import type { LayoutProps } from './layout';
import styles from './Sheets.module.css';

/** The records as cards side by side */
export function Gallery(props: LayoutProps) {
  return (
    <div className={styles.gallery}>
      {props.rows.map((record) => (
        <Card key={record.key} record={record} {...props} />
      ))}
      {props.mayEdit && <NewRow onAdd={(title) => props.onAdd({}, title)} />}
    </div>
  );
}
