#!/usr/bin/env node
/**
 * PCL 主页「近期版本更新」生成器
 *
 * 数据来源（都是公开接口，无需 key）：
 *   1. Mojang 官方启动器内容接口
 *      https://launchercontent.mojang.com/v2/javaPatchNotes.json
 *      → 版本号、版本类型（release / snapshot）、发布日期
 *      https://launchercontent.mojang.com/v2/javaPatchNotes/<id>.json
 *      → 该版本的官方说明正文（HTML）
 *   2. Minecraft 中文 Wiki MediaWiki API（TextExtracts 扩展）
 *      https://zh.minecraft.wiki/api.php?action=query&prop=extracts&exintro=1&explaintext=1
 *      → 该版本的中文摘要（Mojang 接口只有英文，故用 Wiki 补中文）
 *
 * 用法：
 *   node homepage/build.mjs                 默认：抓 4 个最新正式版，同时写本地 Custom.xaml 和 dist
 *   node homepage/build.mjs --limit=6       抓 6 个
 *   node homepage/build.mjs --no-local      只写 dist/Custom.xaml（联网主页用），不动本地主页
 *   node homepage/build.mjs --no-wiki       不调 Wiki，纯英文摘要（更快，少一个依赖）
 *   node homepage/build.mjs --snapshots     额外把快照也算进列表
 *   node homepage/build.mjs --out=x.xaml    自定义输出路径
 *
 * 产物：
 *   homepage/dist/Custom.xaml   上传到任意静态托管 → PCL 设置里填「联网主页」地址
 *   ../Custom.xaml              PCL 本地主页，直接生效
 *
 * 要求 Node 18+（用到内置 fetch）。本项目在 Node 22 下验证通过。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ENDPOINT = {
  manifest: 'https://launchercontent.mojang.com/v2/javaPatchNotes.json',
  patchBase: 'https://launchercontent.mojang.com/v2/',
  wiki: 'https://zh.minecraft.wiki/api.php',
};

const UA = 'PCL-CustomHomepage-Builder/1.0 (local script)';

/* ------------------------------------------------------------------ 参数 */

const opt = {
  limit: 4,
  local: true,
  wiki: true,
  snapshots: false,
  out: resolve(HERE, 'dist/Custom.xaml'),
};

for (const arg of process.argv.slice(2)) {
  if (arg === '--no-local') opt.local = false;
  else if (arg === '--no-wiki') opt.wiki = false;
  else if (arg === '--snapshots') opt.snapshots = true;
  else if (arg.startsWith('--limit=')) opt.limit = Math.max(1, Math.min(12, parseInt(arg.slice(8), 10) || 4));
  else if (arg.startsWith('--out=')) opt.out = resolve(arg.slice(6));
  else if (arg === '-h' || arg === '--help') {
    console.log(await readFile(new URL(import.meta.url), 'utf8').then(s => s.split('*/')[0]));
    process.exit(0);
  } else {
    console.warn(`[warn] 忽略未知参数：${arg}`);
  }
}

/* ------------------------------------------------------------ 网络请求 */

async function fetchJson(url, { tries = 3, timeout = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`${lastErr.message}  ←  ${url}`);
}

/* -------------------------------------------------------- 文本处理 */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 官方正文的 <p> 是不闭合的，得靠后面的块级标签截断 */
function firstParagraph(html) {
  const m = String(html).match(/<p[^>]*>([\s\S]*?)(?=<p[^>]*>|<h[1-6][^>]*>|<ul|<div|$)/i);
  return m ? stripTags(m[1]) : '';
}

/** 截断到 n 个字符，尽量停在句末，别把句子砍半 */
function clip(text, n = 110) {
  const s = String(text).trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const zh = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'));
  if (zh > n * 0.45) return head.slice(0, zh + 1);
  const en = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  if (en > n * 0.45) return head.slice(0, en + 1);
  return head.replace(/[\s,，、]+$/, '') + '…';
}

/** 中文 Wiki 的摘要形如「26.3是奔赴荒野的正式版，也是……」，从中取出中文代号 */
function zhCodename(extract) {
  const m = String(extract).match(/是(.{2,16}?)的(正式版|快照|实验性快照)/);
  return m ? m[1] : '';
}

/**
 * Wiki 摘要开头总是重复一遍版本号（「26.3是奔赴荒野的正式版……」），
 * 而卡片左边已经用大字号显示了版本号，所以这里把它剥掉，避免读起来啰嗦。
 */
function stripVersionLead(text, version) {
  return String(text)
    .replace(new RegExp(`^Java版\\s*${version.replace(/\./g, '\\.')}\\s*是\\s*`), '')
    .replace(new RegExp(`^${version.replace(/\./g, '\\.')}\\s*是\\s*`), '')
    .trim();
}

/** 没有中文代号时（热修复版本通常没有），按摘要内容给个更准确的标签 */
function fallbackLabel(summary, type) {
  if (type === 'snapshot') return '快照';
  if (/热修复/.test(summary)) return '热修复';
  if (/实验性/.test(summary)) return '实验性版本';
  return '正式版';
}

/** 写进 XAML 属性值必须转义，否则 & < > 会直接让 PCL 解析失败 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ 取数据 */

async function zhSummary(version) {
  if (!opt.wiki) return '';
  try {
    const url = `${ENDPOINT.wiki}?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1`
      + `&titles=${encodeURIComponent('Java版' + version)}`;
    const data = await fetchJson(url, { tries: 2, timeout: 12000 });
    const pages = data?.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      if (page.extract) return stripTags(page.extract);
    }
    return '';
  } catch {
    return '';
  }
}

async function buildEntry(entry) {
  const version = entry.version;
  const date = String(entry.date ?? '').slice(0, 10);

  const [zh, patch] = await Promise.all([
    zhSummary(version),
    fetchJson(ENDPOINT.patchBase + entry.contentPath, { tries: 2 }).catch(() => null),
  ]);

  const enIntro = patch?.body ? firstParagraph(patch.body) : '';
  const rawZh = zh ? stripVersionLead(zh, version) : '';
  const summary = clip(rawZh || enIntro || entry.shortText || '暂无摘要', rawZh ? 105 : 130);
  const codename = zhCodename(zh) || fallbackLabel(summary, entry.type);
  const tagColor = entry.type === 'snapshot' ? 'ColorBrush4' : 'ColorBrush2';

  return {
    version,
    date,
    summary,
    codename,
    type: entry.type,
    source: zh ? 'wiki' : 'mojang',
    xaml: `        <!-- 版本 ${esc(version)}（${entry.type}，数据源 ${zh ? 'Mojang + Wiki' : 'Mojang'}） -->
        <StackPanel Margin="0,0,0,14">
            <StackPanel Orientation="Horizontal">
                <TextBlock FontWeight="Bold" FontSize="13" Foreground="{DynamicResource ColorBrush1}"
                           Text="${esc(version)}" />
                <TextBlock Margin="8,0,0,0" FontSize="12" VerticalAlignment="Center"
                           Foreground="{DynamicResource ${tagColor}}" Text="${esc(codename)}" />
                <TextBlock Margin="8,0,0,0" FontSize="11" VerticalAlignment="Center"
                           Foreground="{DynamicResource ColorBrush4}" Text="${esc(date)}" />
            </StackPanel>
            <TextBlock TextWrapping="Wrap" Margin="0,3,0,0" FontSize="12"
                       Foreground="{DynamicResource ColorBrush3}"
                       Text="${esc(summary)}" />
        </StackPanel>`,
  };
}

/* ------------------------------------------------------------ 主流程 */

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function main() {
  console.log('→ 拉取版本清单 …');
  const manifest = await fetchJson(ENDPOINT.manifest);
  const all = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!all.length) throw new Error('版本清单为空，接口结构可能变了');

  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  const wanted = opt.snapshots ? all : all.filter(e => e.type === 'release');
  const picked = wanted.sort(byDate).slice(0, opt.limit);
  if (!picked.length) throw new Error('没筛出可用版本，试试加 --snapshots');

  const latestSnapshot = all.filter(e => e.type === 'snapshot').sort(byDate)[0];

  console.log(`→ 抓取 ${picked.length} 个版本的摘要 …`);
  const entries = [];
  for (const item of picked) {
    const e = await buildEntry(item);
    entries.push(e);
    console.log(`   ${e.version.padEnd(18)} ${e.date}  ${e.codename}  [${e.source}]`);
  }

  const snapshotNote = latestSnapshot
    ? `        <local:MyHint Theme="Blue" Margin="0,0,0,12"
                      Text="最新快照 ${esc(latestSnapshot.version)} · ${esc(String(latestSnapshot.date).slice(0, 10))} · 想尝鲜可以在 PCL 的「下载 → 自动安装」里选择快照版本。" />`
    : '';

  const template = await readFile(resolve(HERE, 'template.xaml'), 'utf8');
  const out = template
    .replace('@@CHANGELOG_ENTRIES@@', entries.map(e => e.xaml).join('\n\n'))
    .replace('@@SNAPSHOT_NOTE@@', snapshotNote)
    .replace(/@@UPDATED_AT@@/g, stamp());

  const leftover = out.match(/@@[A-Z_]+@@/g);
  if (leftover) console.warn(`[warn] 模板里还有未替换的占位符：${[...new Set(leftover)].join(', ')}`);

  await mkdir(dirname(opt.out), { recursive: true });
  await writeFile(opt.out, out, 'utf8');
  console.log(`✓ 已写入 ${opt.out}`);

  if (opt.local) {
    const localPath = resolve(ROOT, 'Custom.xaml');
    await writeFile(localPath, out, 'utf8');
    console.log(`✓ 已写入 ${localPath}（PCL 里重进主页即可看到）`);
  }
}

main().catch(err => {
  console.error(`✗ 生成失败：${err.message}`);
  console.error('  已有文件未被修改。检查网络或稍后重试。');
  process.exit(1);
});
