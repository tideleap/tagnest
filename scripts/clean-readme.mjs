#!/usr/bin/env node
/**
 * clean-readme.mjs — 清理 Markdown 文档中所有 tmarks 相关内容的命令行工具
 *
 * 设计目标：
 *  - 明确识别并移除「tmarks 相关的标记、代码块或注释内容」
 *  - 保留其余文档结构（标题层级、其他章节、列表、表格等）完整
 *  - 支持常见 Markdown 格式（围栏代码块、HTML 注释、标题/章节、段落、列表、引用、表格）
 *
 * 移除策略（均可单独开关）：
 *  1. 章节：标题文本命中关键词时，整节（标题 + 正文）删除，直到同级或更高级标题出现
 *  2. 代码块：围栏代码块（``` 或 ~~~）内任意行命中关键词，整块删除
 *  3. 注释：HTML 注释（<!-- ... -->，支持多行）内命中关键词，整段删除
 *  4. 行内：普通正文行（段落/列表/引用/表格行）命中关键词时，删除整行；
 *           开启 --scrub-inline 则改为擦除行内关键词令牌，尽量保留句子
 *
 * 后处理：折叠 >=3 个连续空行为 2 个、清理行尾空白、统一结尾单个换行。
 *
 * 用法：
 *  node scripts/clean-readme.mjs [options] [input]
 *
 * 选项：
 *  -i, --input <file>     输入文件（默认 README.md；也可用位置参数）
 *  -o, --output <file>    导出清理后的内容到该文件（不写回原文件）
 *      --in-place         直接覆盖输入文件
 *  -k, --keyword <regex>  关键词（大小写不敏感），默认 "tmarks"
 *      --no-sections      不按标题移除整节
 *      --no-codeblocks    不移除围栏代码块
 *      --no-comments      不移除 HTML 注释
 *      --scrub-inline     不删除整行，而是擦除行内关键词令牌
 *  -d, --dry-run          只输出将要删除的内容，不写任何文件
 *  -v, --verbose          输出统计信息
 *  -h, --help             显示帮助
 *
 * 退出码：0 成功；2 参数错误；1 文件不存在/读取失败。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function printHelp() {
  console.log(`clean-readme.mjs — 清理 Markdown 中的 tmarks 相关内容

用法:
  node scripts/clean-readme.mjs [options] [input]

选项:
  -i, --input <file>     输入文件（默认 README.md；也可作为位置参数）
  -o, --output <file>    导出清理结果到新文件（不覆盖原文件）
      --in-place         直接覆盖输入文件
  -k, --keyword <regex>  关键词（大小写不敏感），默认 "tmarks"
      --no-sections      不按标题移除整节
      --no-codeblocks    不移除围栏代码块
      --no-comments      不移除 HTML 注释
      --scrub-inline     不删整行，而是擦除行内关键词令牌（保留句子）
  -d, --dry-run          只预览将要删除的内容，不写文件
  -v, --verbose          输出统计信息
  -h, --help             显示本帮助
`);
}

function parseArgs(argv) {
  const opts = {
    input: 'README.md',
    output: null,
    inPlace: false,
    keyword: 'tmarks',
    sections: true,
    codeblocks: true,
    comments: true,
    scrubInline: false,
    dryRun: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '--input') opts.input = argv[++i];
    else if (a === '-o' || a === '--output') opts.output = argv[++i];
    else if (a === '--in-place') opts.inPlace = true;
    else if (a === '-k' || a === '--keyword') opts.keyword = argv[++i];
    else if (a === '--no-sections') opts.sections = false;
    else if (a === '--no-codeblocks') opts.codeblocks = false;
    else if (a === '--no-comments') opts.comments = false;
    else if (a === '--scrub-inline') opts.scrubInline = true;
    else if (a === '-d' || a === '--dry-run') opts.dryRun = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`未知选项: ${a}`); process.exit(2); }
    else opts.input = a; // 位置参数作为 input
  }
  return opts;
}

function isHeading(s) {
  return /^#{1,6}\s/.test(s);
}
function headingLevel(s) {
  return (s.match(/^#+/) || [''])[0].length;
}
function headingText(s) {
  return s.replace(/^#{1,6}\s*/, '').replace(/\s*#*\s*$/, '');
}

/** 行内擦除：移除关键词及其一层 Markdown 强调/反引号，并尽量清理残留标点。 */
function scrubLine(line, pattern) {
  const re = new RegExp(`(?:\\*|_|\`){0,2}(?:${pattern})(?:\\*|_|\`){0,2}`, 'gi');
  let s = line.replace(re, '');
  s = s.replace(/[ \t]{2,}/g, ' '); // 折叠多余空格
  s = s.replace(/\s+([的之与和及、，。：:])\s*$/, '$1'); // 清理行尾悬空连接词
  s = s.replace(/^\s*([，、：:])\s*/, ''); // 清理行首悬空标点
  return s.trim();
}

/**
 * 核心清理逻辑。返回 { result, removed }。
 * removed 包含统计信息与被删除内容的预览。
 */
function cleanMarkdown(src, opts) {
  const kw = new RegExp(opts.keyword, 'i');
  const lines = src.split(/\r?\n/);
  const out = [];
  const removed = { sections: [], codeblocks: 0, comments: 0, lines: [], scrubbed: 0 };

  let i = 0;
  let inFence = null; // 当前围栏字符（` 或 ~）
  let fenceBuf = [];
  let fenceHasKw = false;
  let skipSectionLevel = 0; // >0 表示正处于被移除的章节内

  while (i < lines.length) {
    const line = lines[i];

    // --- 围栏代码块 ---
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[2][0];
      if (!inFence) {
        inFence = fenceChar;
        fenceBuf = [line];
        fenceHasKw = kw.test(line);
        i++;
        continue;
      }
      if (fenceChar === inFence) {
        fenceBuf.push(line);
        if (opts.codeblocks && fenceHasKw) removed.codeblocks++;
        else out.push(...fenceBuf);
        inFence = null; fenceBuf = []; fenceHasKw = false;
        i++;
        continue;
      }
    }
    if (inFence) {
      fenceBuf.push(line);
      if (kw.test(line)) fenceHasKw = true;
      i++;
      continue;
    }

    // --- HTML 注释（支持多行） ---
    if (opts.comments && line.includes('<!--')) {
      const buf = [line];
      let j = i;
      let closed = line.includes('-->');
      while (!closed && j + 1 < lines.length) {
        j++;
        buf.push(lines[j]);
        if (lines[j].includes('-->')) closed = true;
      }
      const text = buf.join('\n');
      if (kw.test(text)) {
        removed.comments++;
        if (opts.verbose) removed.lines.push(`[HTML 注释] ${buf[0]}`);
      } else {
        out.push(...buf);
      }
      i = j + 1;
      continue;
    }

    // --- 章节（按标题移除整节） ---
    if (opts.sections && isHeading(line)) {
      const lvl = headingLevel(line);
      const txt = headingText(line);
      if (kw.test(txt)) {
        removed.sections.push(txt);
        skipSectionLevel = lvl;
        i++;
        continue;
      }
      if (skipSectionLevel && lvl <= skipSectionLevel) {
        // 遇到同级或更高级标题 -> 章节结束，从此正常处理
        skipSectionLevel = 0;
      }
    }
    if (skipSectionLevel) {
      i++;
      continue;
    }

    // --- 行内引用 ---
    if (kw.test(line)) {
      if (opts.scrubInline) {
        const scrubbed = scrubLine(line, opts.keyword);
        if (scrubbed && scrubbed.replace(/\s/g, '') !== '') {
          out.push(scrubbed);
          removed.scrubbed++;
        }
        // 擦除后若为空则丢弃该行
      } else {
        removed.lines.push(line); // 记录被删除的整行
      }
      i++;
      continue;
    }

    out.push(line);
    i++;
  }

  // 后处理：折叠多余空行、清理行尾空白、统一结尾换行
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n');
  result = result.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  result = result.replace(/\n+$/, '') + '\n';

  return { result, removed };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = resolve(process.cwd(), opts.input);

  if (!existsSync(inputPath)) {
    console.error(`错误：找不到输入文件 ${inputPath}`);
    process.exit(1);
  }
  let src;
  try {
    src = readFileSync(inputPath, 'utf8');
  } catch (e) {
    console.error(`错误：读取失败 ${e.message}`);
    process.exit(1);
  }

  const { result, removed } = cleanMarkdown(src, opts);

  if (opts.dryRun || opts.verbose) {
    console.error('=== 清理预览 / 统计 ===');
    if (removed.sections.length) {
      console.error(`移除章节 (${removed.sections.length}):`);
      removed.sections.forEach((s) => console.error(`  - ${s}`));
    }
    if (removed.codeblocks) console.error(`移除代码块: ${removed.codeblocks}`);
    if (removed.comments) console.error(`移除 HTML 注释: ${removed.comments}`);
    if (removed.lines.length) {
      console.error(`移除行内行 (${removed.lines.length}):`);
      removed.lines.forEach((l) => console.error(`  - ${l}`));
    }
    if (removed.scrubbed) console.error(`行内擦除: ${removed.scrubbed}`);
    if (
      !removed.sections.length &&
      !removed.codeblocks &&
      !removed.comments &&
      !removed.lines.length &&
      !removed.scrubbed
    ) {
      console.error('未发现任何命中关键词的内容，文档无需改动。');
    }
  }

  if (opts.dryRun) {
    console.error('=== dry-run 结束，未写入任何文件 ===');
    process.exit(0);
  }

  if (opts.inPlace && opts.output) {
    console.error('警告：同时指定了 --in-place 与 --output，已忽略 --output，原地写回输入文件。');
  }

  const target = opts.inPlace ? inputPath : opts.output ? resolve(process.cwd(), opts.output) : null;

  if (target) {
    writeFileSync(target, result, 'utf8');
    console.error(`已写入: ${target}`);
  } else {
    // 默认输出到 stdout
    process.stdout.write(result);
  }
}

main();
