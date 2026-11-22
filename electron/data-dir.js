'use strict';
/**
 * 展惠进销存 —— 数据目录解析 + 旧目录迁移（第一阶段完整版）。
 *
 * 规则（设计文档 §2.4）：
 * 1) 用户显式设了 ORANGE_DATA_DIR → 照用，不插手；
 * 2) 便携版（appRoot 下有 portable.flag）→ <appRoot>/data；
 * 3) %APPDATA%\huimin-yun 已有数据 → 继续用它（老用户无缝升级，数据一动不动）；
 * 4) 否则 → app.getPath('userData')（Windows 下是 %APPDATA%\展惠进销存）。
 *
 * 迁移：%APPDATA%\orange-jxc → 目标目录（仅当目标为默认 userData 时），
 * 照搬 launcher.cjs 的“先 WAL checkpoint → 复制 → 校验大小 → 删旧目录，
 * 失败回退旧目录，绝不覆盖已有数据”。库文件名随品牌改名：
 * orange-clone.db → huimin-clone.db，-wal/-shm 副产物跟着改名。
 *
 * ORANGE_* 环境变量名是兼容性锚点（C 档结论），不要改名。
 * 纯函数（resolveDataDirTarget / migrateLegacyDataDir）接受显式路径对象，
 * 不依赖 Electron，可直接用 node 单测；initDataDir 是给主进程用的异步入口。
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR_NAME = 'huimin-yun';
const LEGACY_DATA_DIR_NAME = 'orange-jxc';
const DB_FILE_NAME = 'huimin-clone.db';
const LEGACY_DB_FILE_NAME = 'orange-clone.db';
const PORTABLE_FLAG = 'portable.flag';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目录里有没有“有意义”的数据（launcher.pid / port.txt / server.lock 不算）。 */
function hasMeaningfulData(dir) {
  try {
    const names = fs.readdirSync(dir);
    return names.some((f) => f !== 'launcher.pid' && f !== 'port.txt' && f !== 'server.lock');
  } catch {
    return false;
  }
}

/**
 * 纯函数：按规则算目标目录。
 * @param {{appData: string, userData: string, appRoot: string}} paths
 * @returns {{dataDir: string, kind: 'env'|'portable'|'legacy-huimin-yun'|'userData'}}
 */
function resolveDataDirTarget(paths) {
  if (process.env.ORANGE_DATA_DIR) {
    return { dataDir: process.env.ORANGE_DATA_DIR, kind: 'env' };
  }
  if (fs.existsSync(path.join(paths.appRoot, PORTABLE_FLAG))) {
    return { dataDir: path.join(paths.appRoot, 'data'), kind: 'portable' };
  }
  const legacyNew = path.join(paths.appData, DATA_DIR_NAME);
  if (hasMeaningfulData(legacyNew)) {
    return { dataDir: legacyNew, kind: 'legacy-huimin-yun' };
  }
  return { dataDir: paths.userData, kind: 'userData' };
}

/** 从 Electron app 对象拼出 resolveDataDirTarget 要的路径（打包后 appRoot 取 exe 所在目录）。 */
function pathsForApp(app) {
  const appRoot = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : path.join(__dirname, '..');
  return {
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    appRoot,
  };
}

/**
 * 旧数据目录迁移：<appData>\orange-jxc → target（照搬 launcher.cjs）。
 * @returns {Promise<{outcome: 'none'|'migrated'|'fallback', fallback: string|null}>}
 *   none → 本来就没什么可迁的，用 target 继续；
 *   migrated → 迁成功，用 target 继续；
 *   fallback → 迁移失败，调用方应回退到 fallback 目录继续（数据还在那，不会丢）。
 */
async function migrateLegacyDataDir(target, appData) {
  const legacy = path.join(appData, LEGACY_DATA_DIR_NAME);
  if (legacy === target) return { outcome: 'none', fallback: null };
  if (!fs.existsSync(legacy)) return { outcome: 'none', fallback: null };

  // 目标已有数据 → 不动（避免覆盖）
  if (hasMeaningfulData(target)) {
    console.log(`[data-dir] 检测到旧数据目录 ${legacy}，但新目录已有数据，跳过迁移（不覆盖）。`);
    return { outcome: 'none', fallback: null };
  }

  try {
    // 1) 先把旧库 WAL 合并进主库，得到完整快照
    const oldDb = path.join(legacy, LEGACY_DB_FILE_NAME);
    if (fs.existsSync(oldDb)) {
      try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(oldDb);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.close();
      } catch (e) {
        console.warn(`[data-dir] 旧库 checkpoint 失败（继续尝试搬运）：${e.message}`);
      }
    }

    // 2) 复制整个目录（不删旧的）；库文件要改新名，否则服务端找不到
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dstName = name === LEGACY_DB_FILE_NAME ? DB_FILE_NAME : name;
      const dst = path.join(target, dstName);
      if (fs.existsSync(dst)) continue; // 目标已有同名文件，不覆盖
      fs.cpSync(src, dst, { recursive: true });
    }
    // 库文件改名后，其 WAL/SHM 副产物也要跟着改名（服务端按新库名找副产物）
    for (const suffix of ['-wal', '-shm']) {
      const oldSide = path.join(target, LEGACY_DB_FILE_NAME + suffix);
      if (fs.existsSync(oldSide)) {
        try {
          fs.renameSync(oldSide, path.join(target, DB_FILE_NAME + suffix));
        } catch {
          /* ignore */
        }
      }
    }

    // 3) 校验：新库必须存在且大小一致
    if (fs.existsSync(oldDb)) {
      const newDb = path.join(target, DB_FILE_NAME);
      if (!fs.existsSync(newDb)) throw new Error('迁移后主库缺失');
      const a = fs.statSync(oldDb).size;
      const b = fs.statSync(newDb).size;
      if (a !== b) throw new Error(`迁移后大小不一致（${a} vs ${b}）`);
    }

    // 4) 校验通过才删旧目录（删不掉就保留旧目录，下次启动再判定一次）
    try {
      const { DatabaseSync } = require('node:sqlite');
      const oldDbHandle = new DatabaseSync(oldDb, { readOnly: true });
      oldDbHandle.close();
    } catch {
      /* 打不开就算了，删不掉就保留旧目录 */
    }
    fs.rmSync(path.join(legacy, LEGACY_DB_FILE_NAME + '-wal'), { force: true });
    fs.rmSync(path.join(legacy, LEGACY_DB_FILE_NAME + '-shm'), { force: true });
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        fs.rmSync(legacy, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed = !fs.existsSync(legacy);
      } catch {
        await sleep(300);
      }
    }
    if (!removed) {
      console.warn(`[data-dir] 旧数据目录未能删除（可能仍被占用），已保留：${legacy}`);
    }
    console.log(`[data-dir] 数据目录已从 ${LEGACY_DATA_DIR_NAME} 迁移到 ${path.basename(target)}。`);
    return { outcome: 'migrated', fallback: null };
  } catch (e) {
    console.error(`[data-dir] 数据目录迁移失败：${e.message}`);
    console.error(`           为避免丢数据，仍使用旧目录 ${legacy}（可手动改名后重试）。`);
    return { outcome: 'fallback', fallback: legacy };
  }
}

/**
 * 主进程入口：解析目标目录 → 建目录 → 需要时迁移旧目录。
 * @returns {Promise<{dataDir: string, kind: string, migrated: boolean, fellBack: boolean}>}
 */
async function initDataDir(app, opts = {}) {
  const paths = opts.paths || pathsForApp(app);
  const resolved = resolveDataDirTarget(paths);
  let dataDir = resolved.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  let migrated = false;
  let fellBack = false;
  // 迁移只在默认场景：不是 env、不是便携、目标是全新的 userData。
  // 目标已是 huimin-yun（有数据）时不用迁；env/便携时不插手。
  if (resolved.kind === 'userData') {
    const result = await migrateLegacyDataDir(dataDir, paths.appData);
    if (result.outcome === 'fallback' && result.fallback && result.fallback !== dataDir) {
      dataDir = result.fallback;
      fellBack = true;
      fs.mkdirSync(dataDir, { recursive: true });
    } else if (result.outcome === 'migrated') {
      migrated = true;
    }
  }
  return { dataDir, kind: resolved.kind, migrated, fellBack };
}

/** 同步版（P0 兼容）：只算目标目录，不做迁移。主进程请用 initDataDir。 */
function resolveDataDir(app, opts = {}) {
  const paths = opts.paths || pathsForApp(app);
  return resolveDataDirTarget(paths).dataDir;
}

module.exports = {
  resolveDataDir,
  resolveDataDirTarget,
  migrateLegacyDataDir,
  initDataDir,
  pathsForApp,
  hasMeaningfulData,
};
