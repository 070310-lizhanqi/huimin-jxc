#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadDotEnv, resolveStoragePaths } = require(path.join(__dirname, '..', 'dist', 'server', 'config', 'env.js'));
const { openDb, migrate, listAppliedMigrations, tryCheckpoint } = require(path.join(__dirname, '..', 'dist', 'server', 'db.js'));

loadDotEnv();
const { dbPath } = resolveStoragePaths(process.env);
const db = openDb(dbPath);
try {
  migrate(db);
  tryCheckpoint(db);
  const applied = listAppliedMigrations(db);
  console.log(
    `[db:migrate] 数据库 ${dbPath} 迁移完成，已应用版本 (${applied.length}): ${applied.map((m) => `V${m.version}:${m.name}`).join(', ')}`,
  );
} finally {
  db.close();
}
