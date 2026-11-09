import { useState } from 'react';
import { Icon } from '@minca/app-shared/Icon';
import styles from './Sheets.module.css';

/** "+ New": pressed, it takes a title, and Enter adds the record and leaves room for the next */
export function NewRow({
  onAdd,
  label = 'New',
}: {
  onAdd: (title: string) => Promise<unknown>;
  label?: string;
}) {
  const [typing, setTyping] = useState(false);
  if (!typing)
    return (
      <button className={styles.newRow} onClick={() => setTyping(true)}>
        <Icon name="plus" size={14} />
        {label}
      </button>
    );
  return (
    <form
      className={styles.newRow}
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('title');
        if (!(input instanceof HTMLInputElement) || !input.value.trim()) return;
        const title = input.value.trim();
        input.value = '';
        void onAdd(title);
      }}
    >
      <Icon name="plus" size={14} />
      <input
        name="title"
        autoFocus
        placeholder="Type a name, then Enter"
        aria-label="Name of the new one"
        onBlur={(e) => !e.currentTarget.value && setTyping(false)}
        onKeyDown={(e) => e.key === 'Escape' && setTyping(false)}
      />
    </form>
  );
}
