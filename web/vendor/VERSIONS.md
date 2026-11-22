# vendor 离线库版本

`web/vendor/` 下的第三方库均为手动下载的官方发布包，无包管理器记录。
本文件是唯一的版本出处；升级时同步更新此处版本号与 SHA256，并跑全量回归。

| 库 | 版本 | 本地文件 | SHA256 |
|---|---|---|---|
| Vue | 3.5.13 | `vue.global.prod.js` | `c459ba7cc8db65c982589fa5d64c7ff478877e8e5b0fd75683207cec6a4e89e8` |
| Element Plus（完整版 full build） | 2.9.3 | `element-plus.full.min.js` | `722c85065276f25eed6bc93f5d5f423c61349cbce98dd741820549103e9c210c` |
| Element Plus（完整版 full build） | 2.9.3 | `element-plus.css` | `e1913cca9e65d8292f7136dcd1d331f28b8e2ebbd2623174ca4b0948c53b03de` |
| Element Plus（完整版 full build） | 2.9.3 | `element-plus.zh-cn.js` | `5576c7132ed144111c454491f5ccfe400c68fc71e73a2c5199dfffdad944a83d` |
| Element Plus Icons Vue | 2.3.1 | `element-plus-icons.iife.min.js` | `0b65b24e39ab2252aefde02a93870200ce992004ce0cec43df095e4720cc4405` |
| ECharts | 5.6.0 | `echarts.min.js` | `bf4a223524e40b77c304bec67e1222cf551f14880cf42c69dc046558e11c07b1` |
| zrender（ECharts 内嵌依赖，无单独文件） | 5.6.1 | 打包在 `echarts.min.js` 内 | — |

注意：ECharts 本身是 **5.6.0**，5.6.1 是其内嵌 zrender 的版本（`echarts.version` 实测为 `5.6.0`，`dependencies.zrender` 为 `5.6.1`），不要写反。

## 下载来源（官方发布包，unpkg 镜像）

- Vue 3.5.13：`https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js`
- Element Plus 2.9.3：`https://unpkg.com/element-plus@2.9.3/dist/index.full.min.js`（本地改名 `element-plus.full.min.js`）、`https://unpkg.com/element-plus@2.9.3/dist/index.css`（本地改名 `element-plus.css`）、`https://unpkg.com/element-plus@2.9.3/dist/locale/zh-cn.js`（本地改名 `element-plus.zh-cn.js`）
- Element Plus Icons Vue 2.3.1：`https://unpkg.com/@element-plus/icons-vue@2.3.1/dist/index.iife.min.js`（本地改名 `element-plus-icons.iife.min.js`）
- ECharts 5.6.0：`https://unpkg.com/echarts@5.6.0/dist/echarts.min.js`

下载后用 `sha256sum` 核对上表，哈希对不上不要替换。

## 漏洞核查（2026-11-21）

- ECharts 5.6.0 不受 CVE-2021-39227（原型污染）影响，该漏洞已在 5.2.1 修复。
- Vue 3.5.13、Element Plus 2.9.3、Icons 2.3.1 均无已知高危 CVE。
- Element Plus 2.9.3 是完整版（full build），前端实际一个 `el-table` 都没用，所有表格都是手写原生 `<table>`；未来升级时可评估按需引入。

## 升级步骤

1. 从上面来源下载对应版本的文件，`sha256sum` 核对无误。
2. 替换 `web/vendor/` 下的文件，同步更新本文件的版本号与 SHA256。
3. 跑 `pnpm build` 与全量回归（`node tools/run-tests.cjs --with-rounds`），确认通过。
4. 先读新版本的 CHANGELOG，确认无破坏性变更；Vue / Element Plus 大版本升级需另立项，不要顺手做。
