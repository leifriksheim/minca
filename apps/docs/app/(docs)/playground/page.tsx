import type { Metadata } from 'next';
import { ClientPlayground } from '@/components/playground/ClientPlayground';
import './playground.css';

export const metadata: Metadata = {
  title: 'Playground',
  description:
    'Build a Minca app a step at a time, on your own account: connect, pick a space, add a collection, write records, and give it a screen.',
};

export default function Page() {
  return (
    <main className="playground-page">
      <header>
        <h1>Playground</h1>
        <p>
          Build a small Minca app a step at a time, on your own account. Each step runs for real, beside the
          React that does it.
        </p>
      </header>
      <ClientPlayground />
    </main>
  );
}
