/**
 * 一键聚合测试：重建干净账套 → 顺序运行全部 API 测试脚本 → 汇总退出码。
 *
 * 用法：
 *   node tools/run-tests.cjs              # 默认：重建账套 + 跑全部；需服务已在 7741 运行
 *   node tools/run-tests.cjs --no-rebuild # 不重建账套
 *   OC_BASE=http://127.0.0.1:7741/api node tools/run-tests.cjs  # 自定义基址
 *
 * 前置：服务需已启动（pnpm build && node dist/server/index.js）。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const REBUILD = !process.argv.includes('--no-rebuild');

async function serverUp() {
  try {
    const root = BASE.replace(/\/api\/?$/, '');
    const r = await fetch(root + '/api/auth/status');
    return r.ok;
  } catch {
    return false;
  }
}

(async () => {
  if (!(await serverUp())) {
    console.error(`[run-tests] 服务未在 ${BASE} 响应。`);
    console.error('请先启动服务：pnpm build && node dist/server/index.js');
    process.exit(2);
  }

  if (REBUILD) {
    console.log('\n========== 1/2 重建干净账套 ==========');
    const rb = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'rebuild-clean.cjs')], {
      stdio: 'inherit',
      env: process.env,
    });
    if (rb.status !== 0) {
      console.error('[run-tests] 重建账套失败，终止。');
      process.exit(2);
    }
  }

  const tests = fs
    .readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => f.startsWith('test-') && f.endsWith('.cjs') && f !== 'test-helpers.cjs')
    .sort();
  tests.unshift('regression.cjs');
  // 专项验证套件（第 1~3 轮 bug 测试）会留下演示性档案/单据，与后续按名字建档的
  // 回归脚本（如 test-doctypes 的「物料A」在唯一索引下）相互冲突：
  // 默认排除，单独用 `node tools/run-tests.cjs --with-rounds` 纳入。
  const withRounds = process.argv.includes('--with-rounds');
  const filtered = tests.filter((t) => withRounds || !/^test-round\d/.test(t));
  filtered.length && (tests.length = 0), tests.push(...filtered);

  console.log(`\n========== ${REBUILD ? '2/2' : '1/1'} 运行 ${tests.length} 个测试脚本 ==========`);

  let passed = 0;
  let skipped = 0;
  const failed = [];
  // 因浏览器起不来而跳过的 UI 脚本（汇总时单独说明，避免被误读为「跑过且通过」）
  const skippedUi = [];

  const requiresPlaywright = (file) =>
    /\brequire\(['"]playwright['"]\)/.test(fs.readFileSync(path.join(ROOT, 'tools', file), 'utf8'));
  const hasPlaywright = () =>
    spawnSync(process.execPath, ['-e', "require('playwright')"], { stdio: 'ignore' }).status === 0;
  /**
   * 能 require 到 playwright 不等于能起浏览器：
   * 受限环境（无桌面/沙箱禁用管道）下 launch 会 `spawn EPERM`，
   * 此时 UI 测试必然全红，应计为跳过而不是失败。探测一次浏览器能否真正启动。
   */
  const browserLaunchable = () =>
    spawnSync(
      process.execPath,
      [
        '-e',
        "const {chromium}=require('playwright');chromium.launch({headless:true}).then(b=>b.close()).then(()=>process.exit(0)).catch(e=>{console.error(String(e).split('\\n')[0]);process.exit(3)})",
      ],
      { stdio: 'ignore', timeout: 60000 },
    ).status === 0;
  // 有 UI 脚本要跑时才探测，避免无谓地起一次浏览器
  const canLaunchBrowser = tests.some(requiresPlaywright) && hasPlaywright() ? browserLaunchable() : false;

  for (const t of tests) {
    // 可选 E2E：脚本依赖 playwright，未安装则跳过（不计入失败）
    if (requiresPlaywright(t)) {
      if (!hasPlaywright()) {
        skipped++;
        console.log(`\n########## ${t} ##########`);
        console.log('[skip] 未安装 playwright（可选 E2E，需 node_modules 具备 playwright 依赖）');
        continue;
      }
      // 已安装但浏览器起不来（受限环境）也跳过，并在汇总里说明原因
      if (!canLaunchBrowser) {
        skipped++;
        skippedUi.push(t);
        console.log(`\n########## ${t} ##########`);
        console.log('[skip] 当前环境无法启动 Chromium（如沙箱禁用子进程管道），UI E2E 无法执行');
        continue;
      }
    }
    console.log(`\n########## ${t} ##########`);
    const start = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', t)], {
      stdio: 'inherit',
      env: { ...process.env, BASE, OC_BASE: BASE },
    });
    const ms = Date.now() - start;
    if (r.status === 0) {
      passed++;
      console.log(`[ok] ${t} (${ms}ms)`);
    } else if (r.status === null) {
      failed.push(`${t}（被信号终止）`);
      console.log(`[FAIL] ${t} 被信号终止 (${ms}ms)`);
    } else {
      failed.push(`${t}（exit ${r.status}）`);
      console.log(`[FAIL] ${t} exit=${r.status} (${ms}ms)`);
    }
  }

  console.log('\n=============================================');
  console.log(
    `聚合结果：通过 ${passed} / ${tests.length}` +
      (skipped ? `，跳过 ${skipped}` : '') +
      (failed.length ? `，失败 ${failed.length}：\n  - ${failed.join('\n  - ')}` : '，全部通过'),
  );
  if (skippedUi.length) {
    console.log(`跳过的是 UI E2E（浏览器无法启动，非代码失败）：${skippedUi.join('、')}`);
    console.log('如需跑 UI E2E：在允许启动子进程的环境执行 `node tools/run-tests.cjs`（例如本机终端而非受限沙箱）。');
  }
  process.exit(failed.length ? 1 : 0);
})();