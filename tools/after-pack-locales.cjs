'use strict';
/**
 * electron-builder afterPack 钩子：精简 Chromium 自带的语言包。
 *
 * 实测：win-unpacked 里 locales/ 约 49MB（55 个 .pak），应用界面只有中文，
 * 保留 en-US（Chromium 回退语言）+ zh-CN + zh-TW，其余删除，可省约 45MB。
 * （P0 报告曾以为体积大户是 node_modules 全量解包，实测解包部分只有 2.5MB；
 * 真正的大头是 Electron 本体约 239MB（固定成本）+ locales，收窄 asarUnpack
 * 省不到 1MB 且有丢依赖的风险，故保持 P0 的 asarUnpack 不变，只砍 locales。）
 *
 * 只删 <appOutDir>/locales/*.pak，不碰其他文件；删除失败只记日志，不阻断打包。
 */
const fs = require('node:fs');
const path = require('node:path');

const KEEP = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);

module.exports = async function afterPack(context) {
  const dir = path.join(context.appOutDir, 'locales');
  let removed = 0;
  let saved = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.pak') || KEEP.has(name)) continue;
      const p = path.join(dir, name);
      try {
        saved += fs.statSync(p).size;
        fs.rmSync(p, { force: true });
        removed += 1;
      } catch {
        /* 单个删不掉不阻断 */
      }
    }
  } catch (e) {
    console.log(`[afterPack] locales 精简跳过：${e.message}`);
    return;
  }
  console.log(`[afterPack] locales 精简：删除 ${removed} 个语言包，节省约 ${(saved / 1048576).toFixed(1)} MB`);
};
