/** Short sounds made on the spot from a few notes, so there is no file to fetch. */
import { accountSetting, fieldOf } from '@minca/app-shared/setting';

/** Someone calling: played again every two seconds while it rings */
export const RING = [660, 880];
/** Something you asked to hear about arrived */
export const PING = [988, 1319];

let context: AudioContext | null = null;

/** Plays the notes one after another, softly. Silent where the browser has no audio, or won't play yet. */
export function play(notes: ReadonlyArray<number>): void {
  if (typeof AudioContext === 'undefined') return;
  try {
    context ??= new AudioContext();
  } catch {
    return;
  }
  const audio = context;
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
  notes.forEach((hz, i) => {
    const at = audio.currentTime + i * 0.18;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    tone.connect(gain).connect(audio.destination);
    tone.start(at);
    tone.stop(at + 0.4);
  });
}

/** Whether notifications make a sound: chosen for the account, on until turned off */
export const notificationSound = accountSetting({
  name: 'minca.notification-sound',
  title: 'Notification sound',
  schema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
  valid: (body): body is { readonly on: boolean } => typeof fieldOf(body, 'on') === 'boolean',
  fallback: { on: true },
});
