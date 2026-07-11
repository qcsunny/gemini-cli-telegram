import sqlite from 'node:sqlite';

const dbPath = '/home/user/.gemini/antigravity-cli/conversations/e5354637-66fb-49e7-998b-41d03f2e9d71.db';
const db = new sqlite.DatabaseSync(dbPath);

console.log('--- TABLES ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables);

for (const row of tables) {
  const tableName = row.name;
  console.log(`\n--- TABLE: ${tableName} ---`);
  try {
    const rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 50`).all();
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(`Error reading ${tableName}:`, err);
  }
}
