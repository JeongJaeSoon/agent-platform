import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

// migration-folder.ts compares schema.ts with the newest snapshot, which is
// written by drizzle-kit and never by hand, so a SQL file that drops or loses a
// statement still passes it (94S-300: deleting a CHECK from 0111 migrated
// cleanly). Diffing the snapshot's DDL against the SQL text cannot close that:
// a migration may split `ADD COLUMN … NOT NULL` into add, backfill and set not
// null, as 0003 and 0108 do. So the comparison is between two databases —
// one built by the migrations, one by the DDL schema.ts generates on its own —
// read back through the catalog, where PostgreSQL has already normalized both.

/** Runs one statement and returns its rows. */
export type Execute = (sql: string) => Promise<Record<string, unknown>[]>;

/** The DDL that creates schema.ts on an empty database. */
export async function schemaStatements(
  schema: Record<string, unknown>,
): Promise<string[]> {
  return generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema),
  );
}

// One line per object in `public`, each carrying its full definition as
// PostgreSQL prints it. Triggers and functions are read too: schema.ts cannot
// declare them, so they surface as the migration-only difference the caller
// names, and a migration that loses, disables or rewrites one — a function
// by its attributes and the hash of its body — no longer matches that list.
const CATALOG = `
  SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS line
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typnamespace = 'public'::regnamespace
  GROUP BY t.typname
UNION ALL
  SELECT 'relation ' || c.relname || ' kind=' || c.relkind::text
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
    || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
    || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
    || CASE a.attidentity WHEN 'a' THEN ' identity always' WHEN 'd' THEN ' identity by default' ELSE '' END
    || CASE a.attgenerated WHEN 's' THEN ' generated stored' ELSE '' END
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
  SELECT 'constraint ' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
  WHERE con.connamespace = 'public'::regnamespace
UNION ALL
  SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
  SELECT 'trigger ' || pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
UNION ALL
  SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
    || pg_get_function_result(p.oid) || ' language ' || l.lanname
    || ' volatility=' || p.provolatile::text || ' parallel=' || p.proparallel::text
    || CASE WHEN p.prosecdef THEN ' security definer' ELSE '' END
    || CASE WHEN p.proisstrict THEN ' strict' ELSE '' END
    || coalesce(' set ' || array_to_string(p.proconfig, ','), '')
    || ' body md5 ' || md5(p.prosrc)
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.pronamespace = 'public'::regnamespace
`;

export async function readCatalog(execute: Execute): Promise<string[]> {
  const rows = await execute(CATALOG);
  return rows.map(({ line }) => String(line)).sort();
}

export interface CatalogDiff {
  /** In the migrated database only. */
  readonly migrationsOnly: string[];
  /** What schema.ts creates that the migrations do not. */
  readonly schemaOnly: string[];
}

export function diffCatalogs(
  migrated: readonly string[],
  fromSchema: readonly string[],
): CatalogDiff {
  const inSchema = new Set(fromSchema);
  const inMigrated = new Set(migrated);
  return {
    migrationsOnly: migrated.filter((line) => !inSchema.has(line)),
    schemaOnly: fromSchema.filter((line) => !inMigrated.has(line)),
  };
}
