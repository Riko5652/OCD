
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '.data', 'ai-productivity.db'));
// Delete stale Cursor turns so the re-sync rebuilds them with labels
const del = db.prepare("DELETE FROM turns WHERE session_id LIKE 'cur-%'").run();
console.log('Deleted stale cursor turns:', del.changes);
// Also wipe sessions so getSessions re-derives titles/project names  
const delSess = db.prepare("UPDATE sessions SET title = NULL WHERE tool_id = 'cursor'").run();
console.log('Reset cursor session titles:', delSess.changes);
db.close();
