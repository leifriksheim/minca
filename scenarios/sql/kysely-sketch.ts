/**
 * The hall-of-fame contract written with Kysely, typed from the collections'
 * bodies, compiled to SQL and its parameters. A definition would store
 * both, or the literals inlined. Compile-only: no driver, nothing runs here.
 */
import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

/** Bodies, as a collection's JSON Schema would give them */
interface Reaction {
  emoji: string;
}
interface Fame {
  reactions: string[];
}

interface Version<B> {
  id: string;
  collection: string;
  key: string;
  seq: number;
  author: string;
  deleted: number;
  prev: string | null;
  body: B;
}
interface ContractTables {
  this: Version<Fame> & { creator: string; line_key: string };
  cited: Version<Reaction> & { field: string; ord: number };
  link: { id: string; ord: number; rel: string; target: string };
}

const db = new Kysely<ContractTables>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new SqliteIntrospector(k),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** Five different people's 🙂 on the comment the claim is on */
export const fameContract = db
  .selectFrom('cited as c')
  .select((eb) => eb(eb.fn.count('c.author').distinct(), '>=', 5).as('ok'))
  .where('c.field', '=', 'reactions')
  .where('c.collection', '=', 'app.reaction')
  .where('c.deleted', '=', 0)
  .where((eb) => eb(eb.ref('c.body', '->>$').key('emoji'), '=', '🙂'))
  .where((eb) =>
    eb(
      eb
        .selectFrom('link')
        .select('target')
        .whereRef('link.id', '=', 'c.id')
        .where('rel', '=', 'on')
        .orderBy('ord')
        .limit(1),
      '=',
      eb
        .selectFrom(['this', 'link'])
        .select('link.target')
        .whereRef('link.id', '=', 'this.id')
        .where('rel', '=', 'on')
        .orderBy('link.ord')
        .limit(1),
    ),
  )
  .compile();
