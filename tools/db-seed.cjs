#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { initConfig } = require(path.join(__dirname, '..', 'dist', 'server', 'config', 'env.js'));
const { openDb, migrate, localDate, tryCheckpoint } = require(path.join(__dirname, '..', 'dist', 'server', 'db.js'));
const { hashPassword } = require(path.join(__dirname, '..', 'dist', 'server', 'auth.js'));

(async () => {
  const cfg = initConfig();
  const db = openDb(cfg.dbPath);
  try {
    migrate(db);
    const existing = db.prepare('SELECT COUNT(*) AS c FROM team').get();
    if (existing && existing.c > 0) {
      console.log(`[db:seed] 检测到已有 ${existing.c} 个账套，跳过幂等初始化。`);
      return;
    }

    const adminUser = String(process.env.SEED_ADMIN_USER || 'admin').trim();
    const envPass = String(process.env.SEED_ADMIN_PASS || '').trim();
    if (cfg.nodeEnv === 'production' && envPass.length < 8) {
      console.error('[db:seed] production 环境必须显式提供至少 8 位的 SEED_ADMIN_PASS');
      process.exitCode = 1;
      return;
    }
    const adminPass = envPass || `Zh-${crypto.randomBytes(6).toString('base64url')}9!`;
    const passHash = await hashPassword(adminPass);
    const today = localDate();

    db.exec('BEGIN IMMEDIATE');
    try {
      const teamInfo = db
        .prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)')
        .run(process.env.SEED_TEAM_NAME || '演示账套', today);
      const teamId = Number(teamInfo.lastInsertRowid);
      db.prepare('INSERT INTO "user" (teamId, name, role, password, createdAt, tokenVer) VALUES (?, ?, ?, ?, ?, 0)').run(
        teamId,
        adminUser,
        'admin',
        passHash,
        today,
      );
      db.prepare('INSERT INTO warehouse (teamId, name, remark) VALUES (?, ?, ?)').run(teamId, '主仓库', '默认仓库');
      db.prepare('INSERT INTO account (teamId, name, type, balance) VALUES (?, ?, ?, 0)').run(teamId, '现金账户', 'cash');
      db.prepare('INSERT INTO customer (teamId, name, priceLevel) VALUES (?, ?, ?)').run(teamId, '零售散客', 'salePrice');
      db.prepare('INSERT INTO vendor (teamId, name) VALUES (?, ?)').run(teamId, '默认供应商');
      db.exec('COMMIT');
      tryCheckpoint(db);
      console.log(`[db:seed] 初始化成功：teamId=${teamId}, username=${adminUser}`);
      if (!envPass) {
        console.log(`[db:seed] 一次性随机管理员密码（请及时保存并修改）：${adminPass}`);
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  } finally {
    db.close();
  }
})().catch((err) => {
  console.error('[db:seed] 初始化失败:', err);
  process.exit(1);
});
