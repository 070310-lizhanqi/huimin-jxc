/**
 * 数据目录迁移测试：%APPDATA%\orange-jxc → %APPDATA%\huimin-yun（品牌改名）。
 *
 * 覆盖迁移函数的各条分支：
 *   1. 旧目录不存在 → 不动
 *   2. 正常迁移 → 新目录有库、旧目录被删、文件大小一致
 *   3. 新目录已有数据 → 不覆盖、不迁移（旧目录保留）
 *   4. WAL 里的未落盘数据 → 迁移后 checkpoint 进主库，不丢账
 *
 * 测的是 launcher.cjs 里的 migrateLegacyDataDir —— 启动器在服务之前跑，
 * 由它决定数据目录并注入 ORANGE_DATA_DIR。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
};

/**
 * 从 launcher.cjs 抽出迁移逻辑做单元测试。
 * 这里复制同一段实现——launcher.cjs 是脚本不是模块，直接 require 会执行它。
 * 两处实现必须同步修改（下面有断言校验二者行为一致的关键点）。
 */
function makeMigrator(appDataDir) {
  const DATA_DIR_NAME = 'huimin-yun';
  const LEGACY_DATA_DIR_NAME = 'orange-jxc';
  const DB_FILE_NAME = 'huimin-clone.db';
  const LEGACY_DB_FILE_NAME = 'orange-clone.db';
  return function migrateLegacyDataDir(target) {
    const legacy = path.join(appDataDir, LEGACY_DATA_DIR_NAME);
    if (legacy === target) return null;
    if (!fs.existsSync(legacy)) return null;
    try {
      const existing = fs.readdirSync(target);
      const meaningful = existing.filter((f) => f !== 'launcher.pid' && f !== 'port.txt' && f !== 'server.lock');
      if (meaningful.length > 0) {
        console.log(`[启动器] 检测到旧数据目录 ${legacy}，但新目录已有数据，跳过迁移（不覆盖）。`);
        return null;
      }
    } catch { /* 目标目录读不到：当作空，继续 */ }
    try {
      const oldDb = path.join(legacy, LEGACY_DB_FILE_NAME);
      if (fs.existsSync(oldDb)) {
        try {
          const db = new DatabaseSync(oldDb);
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          db.close();
        } catch (e) {
          console.warn('[启动器] 旧库 checkpoint 失败（继续尝试搬运）：' + e.message);
        }
      }
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(legacy)) {
        const src = path.join(legacy, name);
        const dstName = name === LEGACY_DB_FILE_NAME ? DB_FILE_NAME : name;
        const dst = path.join(target, dstName);
        if (fs.existsSync(dst)) continue;
        fs.cpSync(src, dst, { recursive: true });
      }
      for (const suffix of ['-wal', '-shm']) {
        const oldSide = path.join(target, LEGACY_DB_FILE_NAME + suffix);
        if (fs.existsSync(oldSide)) {
          try { fs.renameSync(oldSide, path.join(target, DB_FILE_NAME + suffix)); } catch { }
        }
      }
      if (fs.existsSync(oldDb)) {
        const newDb = path.join(target, DB_FILE_NAME);
        if (!fs.existsSync(newDb)) throw new Error('迁移后主库缺失');
        const a = fs.statSync(oldDb).size;
        const b = fs.statSync(newDb).size;
        if (a !== b) throw new Error(`迁移后大小不一致（${a} vs ${b}）`);
      }
      fs.rmSync(legacy, { recursive: true, force: true });
      console.log(`[启动器] 数据目录已从 ${LEGACY_DATA_DIR_NAME} 迁移到 ${DATA_DIR_NAME}。`);
      return null; // 成功：用新目录继续
    } catch (e) {
      console.error('[启动器] 数据目录迁移失败：' + e.message);
      console.error('           为避免丢数据，仍使用旧目录 ' + legacy + '（可手动改名后重试）。');
      return legacy;
    }
  };
}

/** 建一个带数据的旧目录 */
function makeLegacyDir(root) {
  const legacy = path.join(root, 'orange-jxc');
  fs.mkdirSync(legacy, { recursive: true });
  const db = new DatabaseSync(path.join(legacy, 'orange-clone.db'));
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('账套数据');
  db.close();
  fs.writeFileSync(path.join(legacy, 'port.txt'), '7741');
  fs.writeFileSync(path.join(legacy, 'server.log'), '日志\n');
  return legacy;
}

(async () => {
  // ---------- 1. 旧目录不存在 ----------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const migrate = makeMigrator(root);
    const target = path.join(root, 'huimin-yun');
    fs.mkdirSync(target, { recursive: true });
    const r = migrate(target);
    ok(r === null, '旧目录不存在时不迁移');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---------- 2. 正常迁移 ----------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const legacy = makeLegacyDir(root);
    const oldSize = fs.statSync(path.join(legacy, 'orange-clone.db')).size;
    const target = path.join(root, 'huimin-yun');
    const migrate = makeMigrator(root);
    const ret = migrate(target);
    ok(ret === null, '迁移成功返回 null（调用方继续用新目录，不会误回退到旧目录）', String(ret));
    ok(fs.existsSync(path.join(target, 'huimin-clone.db')), '迁移后新目录有主库（且已改新名）');
    ok(!fs.existsSync(path.join(target, 'orange-clone.db')), '旧库名未残留在新目录');
    ok(!fs.existsSync(legacy), '迁移成功后旧目录被删除');
    ok(fs.statSync(path.join(target, 'huimin-clone.db')).size === oldSize, '迁移后主库大小一致',
      `${oldSize} vs ${fs.statSync(path.join(target, 'huimin-clone.db')).size}`);
    ok(fs.existsSync(path.join(target, 'port.txt')), '其它文件一并迁移');
    // 数据可读
    const db = new DatabaseSync(path.join(target, 'huimin-clone.db'));
    const row = db.prepare('SELECT v FROM t LIMIT 1').get();
    db.close();
    ok(row && row.v === '账套数据', '迁移后账套数据可读且未损坏', JSON.stringify(row));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---------- 3. 新目录已有数据 → 不覆盖 ----------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const legacy = makeLegacyDir(root);
    const target = path.join(root, 'huimin-yun');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'huimin-clone.db'), '新目录已有的数据');
    const migrate = makeMigrator(root);
    const r = migrate(target);
    ok(r === null, '新目录已有数据时跳过迁移');
    ok(fs.existsSync(legacy), '跳过迁移时旧目录保留');
    ok(fs.readFileSync(path.join(target, 'huimin-clone.db'), 'utf8') === '新目录已有的数据',
      '新目录数据未被覆盖');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---------- 4. WAL 中未落盘的数据不丢 ----------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const legacy = makeLegacyDir(root);
    // 保持连接打开并写入 → 数据在 WAL 里，主库文件可能还没这些行
    const db = new DatabaseSync(path.join(legacy, 'orange-clone.db'));
    db.exec('PRAGMA journal_mode = WAL;');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('WAL里的数据');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('WAL里的数据2');
    const target = path.join(root, 'huimin-yun');
    const migrate = makeMigrator(root);
    migrate(target);
    db.close();
    const db2 = new DatabaseSync(path.join(target, 'huimin-clone.db'));
    const rows = db2.prepare('SELECT v FROM t').all();
    db2.close();
    const vals = rows.map((r) => r.v);
    ok(vals.includes('WAL里的数据') && vals.includes('WAL里的数据2'),
      'WAL 中未落盘的数据在迁移后仍在', JSON.stringify(vals));
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ---------- 5. launcher.cjs 里的实现与被测实现保持一致 ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'launcher.cjs'), 'utf8');
    ok(src.includes("const DATA_DIR_NAME = 'huimin-yun'"), 'launcher.cjs 使用新目录名');
    ok(src.includes("const LEGACY_DATA_DIR_NAME = 'orange-jxc'"), 'launcher.cjs 保留旧目录名用于迁移');
    ok(src.includes('migrateLegacyDataDir'), 'launcher.cjs 含迁移逻辑');
    ok(src.includes('wal_checkpoint(TRUNCATE)'), 'launcher.cjs 迁移前做 WAL checkpoint');
    ok(src.includes('不覆盖'), 'launcher.cjs 有「不覆盖已有数据」的保护');
    ok(src.includes("const DB_FILE_NAME = 'huimin-clone.db'"), 'launcher.cjs 库文件改用新名');
    ok(src.includes("const LEGACY_DB_FILE_NAME = 'orange-clone.db'"), 'launcher.cjs 保留旧库名用于迁移');
  }

  console.log(`\n===== 数据目录迁移: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });