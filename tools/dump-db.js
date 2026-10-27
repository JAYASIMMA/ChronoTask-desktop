// Dumps the live SQLite database (or a copy) for inspection.
//   node tools/dump-db.js                       -> counts, alarms, history, settings
//   node tools/dump-db.js --sql "select ..."    -> one query
const { DatabaseSync } = require('node:sqlite');
const argv = process.argv.slice(2);
const sqlAt = argv.indexOf('--sql');
const sql = sqlAt >= 0 ? argv[sqlAt + 1] : null;
const positional = argv.find((a) => a !== '--sql' && a !== sql);
const path = positional || 'C:/Users/jayas/AppData/Roaming/app.djtaskmanager.desktop/djtaskmanager.db';
const db = new DatabaseSync(path, { readOnly: true });

if (sql) {
  console.table(db.prepare(sql).all());
  process.exit(0);
}

const tables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all()
  .map((r) => r.name);
const counts = tables.map((t) => ({
  table: t,
  rows: db.prepare(`select count(*) n from "${t}"`).get().n,
}));
console.table(counts);
console.log('--- alarms ---');
console.table(db.prepare('select * from alarms').all());
console.log('--- alarm_history ---');
console.table(db.prepare('select * from alarm_history order by id').all());
console.log('--- tasks ---');
console.table(db.prepare('select id, title, status, recurrence, due_at from tasks').all());
console.log('--- settings ---');
console.table(db.prepare('select * from settings').all());
