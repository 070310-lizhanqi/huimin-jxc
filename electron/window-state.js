'use strict';
/**
 * 展惠进销存 —— 窗口尺寸/位置/最大化记忆（第一阶段）。
 *
 * 存 <userData>/window-state.json；启动时读回并恢复，关闭时保存当前状态。
 * 保存的位置若不在任何一台显示器内（比如拔掉了外接屏），视为失效、用默认尺寸居中，
 * 避免窗口跑出屏幕外找不回来。校验失败（文件损坏、手改坏了）也回默认，不阻断启动。
 */
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'window-state.json';
const DEFAULT_STATE = { width: 1280, height: 800, x: null, y: null, isMaximized: false };
const MIN_WIDTH = 900;
const MIN_HEIGHT = 560;

function isIntIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/** 读回已保存的状态；无效返回默认。 */
function loadWindowState(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, STATE_FILE), 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    return {
      width: isIntIn(raw.width, MIN_WIDTH, 10000) ? raw.width : DEFAULT_STATE.width,
      height: isIntIn(raw.height, MIN_HEIGHT, 10000) ? raw.height : DEFAULT_STATE.height,
      x: isIntIn(raw.x, -100000, 100000) ? raw.x : null,
      y: isIntIn(raw.y, -100000, 100000) ? raw.y : null,
      isMaximized: raw.isMaximized === true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** 保存当前窗口状态（先写临时文件再 rename，避免写一半损坏）。 */
function saveWindowState(userDataDir, bounds) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: bounds.isMaximized === true,
    };
    const file = path.join(userDataDir, STATE_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 已保存的位置是否在任意一台显示器的工作区内。
 * @param {{x: number|null, y: number|null, width: number, height: number}} state
 * @param {Array<{x: number, y: number, width: number, height: number}>} displays
 * 无位置信息时返回 true（调用方用默认尺寸居中）。
 */
function isStateVisible(state, displays) {
  if (state.x === null || state.y === null) return true;
  if (!Array.isArray(displays) || displays.length === 0) return true;
  const r = { x: state.x, y: state.y, width: state.width, height: state.height };
  return displays.some(
    (d) => r.x < d.x + d.width && r.x + r.width > d.x && r.y < d.y + d.height && r.y + r.height > d.y,
  );
}

module.exports = { loadWindowState, saveWindowState, isStateVisible, DEFAULT_STATE };
