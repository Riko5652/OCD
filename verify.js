const db = require('./apps/server/node_modules/better-sqlite3')('./apps/server/.data/ai-productivity.db');
console.log('Commits:', db.prepare('SELECT COUNT(*) as c FROM commit_scores').get().c);
console.log('Projects (not unknown):', db.prepare("SELECT COUNT(*) as c FROM project_index WHERE name != 'Unknown'").get().c);
console.log('Cursor Turns w/ Labels:', db.prepare("SELECT COUNT(*) as c FROM turns WHERE session_id LIKE 'cur-%' AND label IS NOT NULL AND label != ''").get().c);
