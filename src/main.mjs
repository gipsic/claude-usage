import { main } from './cli.mjs';
main(process.argv.slice(2)).catch((e) => {
  console.error(`claude-usage: ${e.message || e}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
