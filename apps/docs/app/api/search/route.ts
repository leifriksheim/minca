import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Written once at build, as a file the search dialog loads.
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
