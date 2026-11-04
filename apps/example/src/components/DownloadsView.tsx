import { Modal } from '@minca/app-shared/Modal';
import { useDownloads, type Ahead, type Keep } from '../downloads';
import { Options, type Option } from './Options';

const AHEAD: ReadonlyArray<Option<Ahead>> = [
  {
    value: 'thumbnails',
    shape: 'grid',
    title: 'Thumbnails',
    detail: 'Only small previews come ahead. Photos, documents and videos download when you open them.',
  },
  {
    value: 'photos',
    shape: 'stack',
    title: 'Photos and documents',
    detail: 'Files up to 5 MB come ahead, so they open at once. Videos download when you play them.',
  },
  {
    value: 'everything',
    shape: 'squircle',
    title: 'Everything',
    detail: 'Every file comes ahead, videos too, so all of it is here when you are offline.',
  },
];

const KEEP: ReadonlyArray<Option<Keep>> = [
  {
    value: '256',
    shape: 'dots',
    title: '256 MB',
    detail: 'Per space. The files opened longest ago go first.',
  },
  { value: '1024', shape: 'bars', title: '1 GB', detail: 'Per space.' },
  { value: '4096', shape: 'coin', title: '4 GB', detail: 'Per space.' },
];

/** What this device downloads ahead and keeps of others' files: per device, never synced */
export function DownloadsView({ onClose }: { onClose: () => void }) {
  const [downloads, setDownloads] = useDownloads();
  return (
    <Modal title="Downloads on this device" onClose={onClose} width={480}>
      <p>Files you add are always kept here. This is for what others share.</p>
      <h3>Download before you open</h3>
      <Options
        label="Download before you open"
        options={AHEAD}
        picked={downloads.ahead}
        onPick={(ahead) => setDownloads({ ...downloads, ahead })}
      />
      <h3>Keep at most</h3>
      <Options
        label="Keep at most"
        options={KEEP}
        picked={downloads.keep}
        onPick={(keep) => setDownloads({ ...downloads, keep })}
      />
      <small>A file that was dropped downloads again when you open it.</small>
    </Modal>
  );
}
