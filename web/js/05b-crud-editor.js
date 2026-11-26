'use strict';
/* web/js/05b-crud-editor.js —— CRUD 编辑器公共 helper（B-前6）
 *
 * 选址：新文件，而非并入 02-tools.js / 05-helpers.js。理由：02-tools.js 已 233 行且含
 * UI 组件（CountUp/SkTable）与 exportCsv 实现；05-helpers.js 是 65 行纯数据小工具；
 * useCrudEditor 是带 Vue 响应式状态的组合式函数，与两者职责都不同。独立文件与
 * 13-doc-editor.js 的拆分先例一致，index.html 只需加一行（05-helpers.js 之后）。
 *
 * useCrudEditor(cfg)：抽取五页共有的「打开/保存/删除/防重/刷新」骨架。
 * 各页不同的东西留在各页，不进 helper：
 *   - 表单校验细节（商品四价禁负、账户余额可负、收付款金额必须 > 0 等）→ cfg.validate
 *   - 请求体拼装（含 toCents 转换、create 与 update 的不同体）→ cfg.buildBody
 *   - 请求地址（含 /settlement/create 与 /settlement/:id 的区别）→ cfg.url
 *   - 保存/删除后的局部刷新（refreshBase 集合、翻页、余额重拉）→ cfg.afterSave / afterDelete
 * cfg 字段：
 *   validate(form, id) → 校验失败文案（字符串）或 null；
 *   buildBody(form, id) → 请求体（缺省 { teamId: store.teamId, ...form }）；
 *   url(id, form) → 有 id 时 PUT 地址、无 id 时 POST 地址；
 *   deleteRequest(row) → 删除请求 Promise；
 *   confirmDelete(row) → 删除确认文案；
 *   afterSave(isNew, form, id) / afterDelete(row) → 成功后的局部刷新等。
 *   savedToast：成功提示（字符串或 (isNew) => 文案；缺省 '已保存'——15-finance 新建时原提示是 '已登记'）；
 *   confirmTitle：删除确认弹窗标题（缺省 confirmBox 默认标题——15-finance 原标题是 '删除确认'）。
 * 行为约定（与各页原实现对齐）：
 *   - 校验先于防重：与 11-base.js 原顺序一致；09-product 原顺序相反（先防重），
 *     但保存按钮在 busy 时已禁用，两者实际等价；
 *   - 保存成功先关弹窗再 toast 再跑 afterSave；失败只 toast、不关弹窗；
 *   - 删除用 busyDel 记正在删的行 id（模板 :disabled="busyDel === row.id" 不变）；
 *     11-base.js 原实现只拦同一行并发删，helper 改为拦全部并发删（更严、无回归风险）。
 */

/** 五页共用的 CRUD 编辑器骨架 */
function useCrudEditor(cfg) {
  const editor = reactive({ open: false, id: null, form: {} });
  const busy = ref(false);
  const busyDel = ref(null);

  function openNew(def) {
    editor.id = null;
    editor.form = typeof def === 'function' ? def() : { ...(def || {}) };
    editor.open = true;
  }
  function openEdit(row, toForm) {
    editor.id = row.id;
    editor.form = toForm(row);
    editor.open = true;
  }
  async function save() {
    const err = cfg.validate ? cfg.validate(editor.form, editor.id) : null;
    if (err) {
      toast(err, 'error');
      return false;
    }
    if (busy.value) return false;
    const isNew = !editor.id;
    const body = cfg.buildBody ? cfg.buildBody(editor.form, editor.id) : { teamId: store.teamId, ...editor.form };
    busy.value = true;
    try {
      if (editor.id) await api.put(cfg.url(editor.id, editor.form), body);
      else await api.post(cfg.url(null, editor.form), body);
      editor.open = false;
      toast(typeof cfg.savedToast === 'function' ? cfg.savedToast(isNew) : cfg.savedToast || '已保存');
      if (cfg.afterSave) await cfg.afterSave(isNew, editor.form, editor.id);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    } finally {
      busy.value = false;
    }
  }
  async function del(row) {
    if (busyDel.value) return false;
    if (!(await confirmBox(cfg.confirmDelete(row), cfg.confirmTitle))) return false;
    busyDel.value = row.id;
    try {
      await cfg.deleteRequest(row);
      toast('已删除');
      if (cfg.afterDelete) await cfg.afterDelete(row);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    } finally {
      busyDel.value = null;
    }
  }
  return { editor, busy, busyDel, openNew, openEdit, save, del };
}

/** 轻量删除：确认 → 请求 → toast → 回调。给 editor 形态不合 useCrudEditor 的页面用
 *  （如 PricePage 的 editor 是 { open, row, price }、SettingsPage 的用户删除），
 *  只抽确认/提示骨架，不碰各页的请求与刷新。title 缺省为 confirmBox 的默认标题。 */
async function confirmDeleteRow(text, request, after, title) {
  if (!(await confirmBox(text, title))) return false;
  try {
    await request();
    toast('已删除');
    if (after) await after();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/** 分 → 元字符串（两位小数）；null/undefined/'' → ''（余额可为负，负数正常转，如 -500 → '-5.00'） */
function yuan(cents) {
  if (cents == null || cents === '') return '';
  return (Number(cents) / 100).toFixed(2);
}

/** 导出行金额映射：复制 row，把 moneyKeys 列的分值换成元。
 *  fixed=true（默认）：元字符串，两位小数（13-doc/14-ledger/15-finance/23-price 的原口径）；
 *  fixed=false：元数值（09-product 商品导出的原口径：1.5 而非 '1.50'，(x||0)/100 含 null→0）。
 *  用法：moneyRow({ billNo: d.billNo, totalAmount: d.totalAmount }, ['totalAmount'])
 *  注意：fixed=true 时 null 分值转 ''（原 (null/100).toFixed(2) 会得 '0.00'）——
 *  仅影响分值本就为 null 的行，各导出源的金额列在落库时均非空，属边缘口径差异。 */
function moneyRow(row, moneyKeys, fixed = true) {
  const out = { ...row };
  for (const k of moneyKeys) {
    const v = row[k];
    out[k] = fixed ? yuan(v) : (Number(v) || 0) / 100;
  }
  return out;
}
