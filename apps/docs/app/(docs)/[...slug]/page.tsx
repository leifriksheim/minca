import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { source } from '@/lib/source';
import nav from '@/nav.json';

type Props = { params: Promise<{ slug: string[] }> };

export default async function Page({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const Body = page.data.body;
  // A topic's overview says what it is for before anything else (scripts/sync.mjs writes the rest).
  const topic = nav.topics.find((t) => page.slugs.join('/') === t.slug);
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {topic ? <Enables pitch={topic.pitch} items={topic.enables} /> : null}
      <DocsBody>
        <Body components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    // The same page as Markdown, for agents (scripts/sync.mjs).
    alternates: { types: { 'text/markdown': `${page.url.replace(/\/$/, '')}.md` } },
  };
}

/** What a topic lets you build, first: the reason to read on. */
function Enables({ pitch, items }: { pitch: string; items: ReadonlyArray<string> }) {
  return (
    <>
      <DocsDescription className="topic-pitch">{pitch}</DocsDescription>
      <section className="enables" aria-label="What it enables">
        <h2>What it enables</h2>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
