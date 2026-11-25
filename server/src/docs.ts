/**
 * 单据模块兼容出口：领域逻辑已拆分至 services/doc-service.ts 与 services/stock-service.ts，
 * 路由层已拆分至 routes/docs.ts；此处保留稳定导出契约。
 */
export { DOC_META } from './services/doc-service';
export { mountDocs } from './routes/docs';
