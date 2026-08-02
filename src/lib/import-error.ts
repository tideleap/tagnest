// src/lib/import-error.ts
//
// Maps backend import error codes (returned by /api/import/preview and
// /api/import/commit) to actionable Chinese guidance. Instead of the generic
// "解析失败"，the user gets a specific cause and a corrective step, and we can
// distinguish a file-format problem from a genuine server condition.

import type { HttpError } from './api';

export type ImportErrorKind =
  | 'empty' // 空文件
  | 'empty_parse' // 有内容但解析出 0 条
  | 'parse' // 解析异常
  | 'unreadable' // 服务器读取/未知失败
  | 'too_large' // 超过大小/条数上限
  | 'form' // 表单错误
  | 'timeout' // 网络/超时
  | 'common'; // 其它

export interface ImportErrorInfo {
  kind: ImportErrorKind;
  title: string;
  /** Short corrective step. */
  hint: string;
  /** Optional secondary text shown under the hint. */
  detail?: string;
}

function classify(httpError: HttpError): ImportErrorInfo {
  const code = httpError.code;
  if (code === 'import_empty') return { kind: 'empty', title: '文件为空', hint: '请选择包含书签的导出文件后重试', detail: httpError.message };
  if (code === 'import_empty_parse') {
    return { kind: 'empty_parse', title: '未解析到书签', hint: '请确认是浏览器导出的书签 HTML / JSON / CSV 文件', detail: httpError.message };
  }
  if (code === 'import_parse') {
    return { kind: 'parse', title: '文件解析失败', hint: '请重新导出书签后再导入（Chrome / Edge / Firefox / Safari 均可）', detail: httpError.message };
  }
  if (code === 'import_unreadable') {
    return { kind: 'unreadable', title: '无法读取文件', hint: '请确认文件未损坏，必要时重新导出。若仍有问题可截图报错反馈', detail: httpError.message };
  }
  if (code === 'payload_too_large' || httpError.status === 413) {
    return { kind: 'too_large', title: '文件过大', hint: '请分多次导入，或先移除部分书签再导出', detail: httpError.message };
  }
  if (code === 'import_form' || code === 'import_no_file') {
    return { kind: 'form', title: '请求异常', hint: '请重试；若持续出现请反馈', detail: httpError.message };
  }
  if (code === 'timeout' || code === 'network_error') {
    return { kind: 'timeout', title: '网络或超时', hint: '请检查网络后重试，大文件导入可能需要稍等片刻', detail: httpError.message };
  }
  // Fallback: a 4xx validation we didn't foresee, or an unrelated error.
  if (httpError.status >= 500) {
    return { kind: 'unreadable', title: '服务器暂时不可用', hint: '请稍后重试；若反复失败，建议重新导出书签文件后再次上传', detail: httpError.message };
  }
  return { kind: 'common', title: '导入失败', hint: '请检查文件内容后重试', detail: httpError.message };
}

/** Prettifies any error from the import endpoints into a title + hint. */
export function describeImportError(error: unknown): ImportErrorInfo {
  if (error instanceof Object && (error as { name?: string }).name === 'HttpError') {
    return classify(error as HttpError);
  }
  const msg = (error as Error)?.message ?? '未知错误';
  return { kind: 'common', title: '导入失败', hint: '请重试或稍后再试', detail: msg };
}
