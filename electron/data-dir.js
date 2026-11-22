'use strict';
/**
 * 展惠进销存 —— 数据目录解析（P0 最小骨架）。
 *
 * 规则（设计文档 §2.4）：
 * 1) 用户显式设了 ORANGE_DATA_DIR → 照用，不插手；
 * 2) 否则用 app.getPath('userData')（Windows 下是 %APPDATA%\展惠进销存）。
 *
 * 旧目录迁移（%APPDATA%\orange-jxc → 新目录，照搬 launcher.cjs 的
 * “复制 → 校验大小 → 删旧目录，失败回退”）在第一阶段移植到这里；P0 只做解析。
 * ORANGE_* 环境变量名是兼容性锚点，不要改名。
 */
function resolveDataDir(app) {
  if (process.env.ORANGE_DATA_DIR) return process.env.ORANGE_DATA_DIR;
  return app.getPath('userData');
}

module.exports = { resolveDataDir };
