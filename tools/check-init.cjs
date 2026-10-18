const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'orange-clone.db'));
console.log('team:', JSON.stringify(db.prepare('SELECT * FROM team').all()));
console.log('user:', JSON.stringify(db.prepare('SELECT id,teamId,name,role,substr(password,1,20) AS pwd FROM "user"').all()));
console.log('warehouse:', JSON.stringify(db.prepare('SELECT * FROM warehouse').all()));
console.log('account:', JSON.stringify(db.prepare('SELECT * FROM account').all()));
console.log('cat:', JSON.stringify(db.prepare('SELECT * FROM cat').all()));
db.close();
