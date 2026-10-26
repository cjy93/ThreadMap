import { runMigrations } from '../server/migrate';

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
runMigrations(url)
  .then(() => {
    console.log('migrations applied');
  })
  .catch((err: unknown) => {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
