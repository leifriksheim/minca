import Link from 'next/link';
import { icons, type LucideIcon } from 'lucide-react';
import nav from '@/nav.json';

const iconByName = new Map<string, LucideIcon>(Object.entries(icons));

// From spec/02-records.md §3.4: what a write puts in the space.
const version = `{
  "collection": "app.todo.item",
  "key": "akthxqofxox3iszhpi5j3zhl6a.mfrggzdfmztwq2lknnwg23tpoa",
  "author": "did:key:zDnaemCBstFw5hzNdNggFHZm6GpHoHqNGrwEtrVi9CxGH9V7E",
  "createdAt": "2026-09-26T12:00:00.000Z",
  "body": { "text": "Buy milk", "done": false },
  "signature": "6F_VmcmIYOMpViiFd3Wfn3j3MVll9hZ3GIP8si1sZrwz4Qrw…"
}`;

export default function Home() {
  return (
    <main className="home">
      <header className="hero">
        <h1>A backend that runs nowhere.</h1>
        <p>
          Your users’ devices keep the data, check the rules and sync with each other. No servers to run, and
          nothing in the middle that can read it.
        </p>
        <nav className="actions">
          <Link href="/playground/">Try it in the playground</Link>
          <Link href="/building-an-app/">Build an app</Link>
          <Link href="/understand/">Understand Minca</Link>
          <Link href="/spec/">The protocol</Link>
        </nav>
      </header>

      <section className="topics">
        {nav.topics.map((topic, i) => {
          const Icon = iconByName.get(topic.icon);
          return (
            <Link key={topic.slug} href={`/${topic.slug}/`} className="topic" data-hue={(i % 5) + 1}>
              <span className="topic-icon">{Icon && <Icon strokeWidth={1.25} />}</span>
              <span>
                <strong>{topic.title}</strong>
                <span>{topic.blurb}</span>
              </span>
            </Link>
          );
        })}
      </section>

      <section className="about">
        <h2>What is this?</h2>
        <p>
          Minca is an open protocol for shared spaces. People keep JSON records in spaces they share, each one
          signed by whoever wrote it. Every device in a space syncs them and checks them against the space’s
          rules, so an app needs no server of its own.
        </p>
        <p>
          An app asks for some of a person’s spaces, then reads and writes records there. Use the standard
          collections and it reads what other apps wrote, too.
        </p>
        <pre>{version}</pre>
        <p>
          Start with <Link href="/understand/">Understand Minca</Link>, or hand your agent{' '}
          <a href="/llms.txt">llms.txt</a>.
        </p>
      </section>
    </main>
  );
}

export const metadata = { title: { absolute: 'Minca for developers' } };
