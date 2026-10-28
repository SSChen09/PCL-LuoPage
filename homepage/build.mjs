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
 *   node homepage/build.mjs                 默认：3 个最新正式版 + 1 个最新快照
 *   node homepage/build.mjs --limit=5       正式版数量改成 5 个
 *   node homepage/build.mjs --no-snapshot   不要快照条目，只留正式版
 *   node homepage/build.mjs --no-local      只写 dist/Custom.xaml（联网主页用），不动本地主页
 *   node homepage/build.mjs --no-wiki       不调 Wiki，纯英文摘要（更快，少一个依赖）
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
  limit: 3,        // 正式版条数
  snapshot: true,  // 是否在正式版之后追加 1 个最新快照
  local: true,
  wiki: true,
  out: resolve(HERE, 'dist/Custom.xaml'),
};

for (const arg of process.argv.slice(2)) {
  if (arg === '--no-local') opt.local = false;
  else if (arg === '--no-wiki') opt.wiki = false;
  else if (arg === '--no-snapshot') opt.snapshot = false;
  else if (arg.startsWith('--limit=')) opt.limit = Math.max(1, Math.min(12, parseInt(arg.slice(8), 10) || 3));
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

async function fetchText(url, { tries = 2, timeout = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`${lastErr.message}  ←  ${url}`);
}

/** 按点分数字比较版本号，取最大。「26.3」要大于「1.21.11」 */
function maxVersion(list) {
  const parse = v => String(v).split(/[.-]/).map(n => (/^\d+$/.test(n) ? Number(n) : 0));
  return [...new Set(list.filter(Boolean))].sort((a, b) => {
    const pa = parse(a), pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return d;
    }
    return 0;
  }).pop();
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

/** 版本条目前面挂的方块图标，按顺序轮换，避免四条长得一模一样 */
const LOGOS = [
  'pack://application:,,,/images/Blocks/Grass.png',
  'pack://application:,,,/images/Blocks/CommandBlock.png',
  'pack://application:,,,/images/Blocks/GoldBlock.png',
  'pack://application:,,,/images/Blocks/Anvil.png',
  'pack://application:,,,/images/Blocks/RedstoneBlock.png',
  'pack://application:,,,/images/Blocks/Cobblestone.png',
];

/** 对应版本的中文 Wiki 词条，例：https://zh.minecraft.wiki/w/Java版26.3（已验证可达） */
function wikiUrl(version) {
  return `https://zh.minecraft.wiki/w/Java%E7%89%88${encodeURIComponent(version)}`;
}

async function buildEntry(entry, index = 0) {
  const version = entry.version;
  const date = String(entry.date ?? '').slice(0, 10);

  const [zh, patch] = await Promise.all([
    zhSummary(version),
    fetchJson(ENDPOINT.patchBase + entry.contentPath, { tries: 2 }).catch(() => null),
  ]);

  const enIntro = patch?.body ? firstParagraph(patch.body) : '';
  const rawZh = zh ? stripVersionLead(zh, version) : '';
  const summary = clip(rawZh || enIntro || entry.shortText || '暂无摘要', rawZh ? 105 : 130);
  // 快照没有「某某的正式版」这种代号，Wiki 里写的是「Java版26.4的第6个快照」，取「第6个快照」即可
  const codename = entry.type === 'snapshot'
    ? (zh.match(/第\s*\d+\s*个快照/) || ['快照'])[0]
    : (zhCodename(zh) || fallbackLabel(summary, entry.type));
  const url = wikiUrl(version);
  const logo = LOGOS[index % LOGOS.length];

  return {
    version,
    date,
    summary,
    codename,
    type: entry.type,
    url,
    source: zh ? 'wiki' : 'mojang',
    // 版本标题做成 MyListItem：PCL 里只有它（和按钮类）支持点击事件，
    // 摘要仍用 TextBlock 放在下面，保证长文本能自动换行不被截断。
    xaml: `        <!-- 版本 ${esc(version)}（${entry.type}，数据源 ${zh ? 'Mojang + Wiki' : 'Mojang'}） -->
        <StackPanel Margin="0,0,0,14">
            <local:MyListItem Margin="-5,0,-5,2" Type="Clickable"
                              Logo="${logo}"
                              Title="${esc(version)} · ${esc(codename)}"
                              Info="${esc(date)} · 点击打开 Wiki 词条"
                              ToolTip="在 Minecraft Wiki 上查看 ${esc(version)}"
                              EventType="打开网页" EventData="${esc(url)}" />
            <TextBlock TextWrapping="Wrap" Margin="0,3,0,0" FontSize="12"
                       Foreground="{DynamicResource ColorBrush3}"
                       Text="${esc(summary)}" />
        </StackPanel>`,
  };
}

/* ------------------------------------------------------- 运维专区数据 */

/** PaperMC 系（paper / velocity / folia）走 v3 接口，旧的 api.papermc.io/v2 已 410 下线 */
async function papermcLatest(slug) {
  const d = await fetchJson(`https://fill.papermc.io/v3/projects/${slug}`);
  const all = Object.values(d.versions ?? {}).flat()
    .filter(v => !/(snapshot|-rc|-pre)/i.test(v));
  return maxVersion(all);
}

const OPS_SOURCES = [
  {
    name: 'Fabric', group: 'loader', logo: 'Fabric.png', url: 'https://fabricmc.net/',
    async latest() {
      const list = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
      const stable = list.find(x => x.stable) ?? list[0];
      return stable.version;
    },
  },
  {
    name: 'Forge', group: 'loader', logo: 'Anvil.png', url: 'https://files.minecraftforge.net/',
    async latest() {
      const d = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const promos = d.promos ?? {};
      const mcList = [...new Set(Object.keys(promos).map(k => k.replace(/-(latest|recommended)$/, '')))];
      const mc = maxVersion(mcList);
      const forge = promos[`${mc}-latest`] ?? promos[`${mc}-recommended`];
      return forge ? `${mc}-${forge}` : mc;
    },
  },
  {
    name: 'NeoForge', group: 'loader', logo: 'NeoForge.png', url: 'https://neoforged.net/',
    async latest() {
      const d = await fetchJson('https://maven.neoforged.net/api/maven/latest/version/releases/net/neoforged/neoforge');
      return d.version;
    },
  },
  {
    name: 'Paper', group: 'server', logo: 'Egg.png', url: 'https://papermc.io/downloads/paper',
    latest: () => papermcLatest('paper'),
  },
  {
    name: 'Leaves', group: 'server', logo: 'Grass.png', url: 'https://leavesmc.org/',
    async latest() {
      const d = await fetchJson('https://api.leavesmc.org/v2/projects/leaves');
      return maxVersion(d.versions ?? []);
    },
  },
  {
    name: 'Velocity', group: 'server', logo: 'RedstoneLampOn.png', url: 'https://papermc.io/downloads/velocity',
    latest: () => papermcLatest('velocity'),
  },
  {
    name: 'Folia', group: 'server', logo: 'RedstoneBlock.png', url: 'https://papermc.io/downloads/folia',
    latest: () => papermcLatest('folia'),
  },
  {
    name: 'Spigot', group: 'server', logo: 'CommandBlock.png', url: 'https://www.spigotmc.org/',
    async latest() {
      // Spigot 没有公开 API，只能读 hub 的版本目录（每个受支持的 MC 版本一个 json 文件）
      const html = await fetchText('https://hub.spigotmc.org/versions/');
      const vers = [...html.matchAll(/href="([0-9][0-9.]*)\.json"/g)].map(m => m[1]);
      return maxVersion(vers);
    },
  },
];

/** 每行 3 个，排成 Grid；模板里已固定 3 列 2 行 */
function opsXaml(items) {
  return items.map((it, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    return `            <local:MyListItem Grid.Row="${row}" Grid.Column="${col}"
                              Margin="-5,0,-5,0" Type="Clickable"
                              Logo="pack://application:,,,/images/Blocks/${it.logo}"
                              Title="${esc(it.name)}" Info="${esc(it.version)}"
                              ToolTip="打开 ${esc(it.name)} 官网"
                              EventType="打开网页" EventData="${esc(it.url)}" />`;
  }).join('\n');
}

/* ------------------------------------------------------------ 主流程 */

/**
 * 「数据更新于」时间，固定按北京时间（UTC+8）输出。
 * 不能用本地时区：GitHub Actions 的 runner 是 UTC，本地跑是 +8，
 * 同一份代码会写出差 8 小时的结果，页脚标注的「北京时间」就成了假话。
 */
function stamp(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} `
    + `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

/**
 * 「下次自动更新」时间。
 * 必须和 .github/workflows/pages.yml 里的 cron 保持一致：
 * cron 走的是 UTC，`17 20 * * *` = UTC 20:17 = 北京时间次日 04:17。
 * 这里先按 UTC 算出下一次触发时刻，再折算成北京时间展示。
 */
const SCHEDULE = { utcHour: 20, utcMinute: 17 };

function nextRun(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    SCHEDULE.utcHour, SCHEDULE.utcMinute, 0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);

  const bj = new Date(next.getTime() + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} `
    + `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

async function main() {
  console.log('→ 拉取版本清单 …');
  const manifest = await fetchJson(ENDPOINT.manifest);
  const all = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!all.length) throw new Error('版本清单为空，接口结构可能变了');

  const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
  const picked = all.filter(e => e.type === 'release').sort(byDate).slice(0, opt.limit);

  // 快照单独追加在正式版后面，不参与 limit 的排序，避免把正式版挤掉
  if (opt.snapshot) {
    const latestSnapshot = all.filter(e => e.type === 'snapshot').sort(byDate)[0];
    if (latestSnapshot) picked.push(latestSnapshot);
  }
  if (!picked.length) throw new Error('没筛出可用版本，检查接口结构是否变化');

  console.log(`→ 抓取 ${picked.length} 个版本的摘要 …`);
  const entries = [];
  for (const item of picked) {
    const e = await buildEntry(item, entries.length);
    entries.push(e);
    console.log(`   ${e.version.padEnd(18)} ${e.date}  ${e.codename}  [${e.source}]`);
  }

  console.log('→ 抓取运维专区版本 …');
  const ops = await Promise.all(OPS_SOURCES.map(async s => {
    try {
      const version = await s.latest();
      console.log(`   ${s.name.padEnd(10)} ${version}`);
      return { ...s, version };
    } catch (err) {
      console.warn(`   ${s.name.padEnd(10)} 获取失败（${err.message}）`);
      return { ...s, version: '—' };
    }
  }));

  const template = await readFile(resolve(HERE, 'template.xaml'), 'utf8');
  const out = template
    .replace('@@CHANGELOG_ENTRIES@@', entries.map(e => e.xaml).join('\n\n'))
    .replace('@@OPS_LOADERS@@', opsXaml(ops.filter(o => o.group === 'loader')))
    .replace('@@OPS_SERVERS@@', opsXaml(ops.filter(o => o.group === 'server')))
    .replace(/@@UPDATED_AT@@/g, stamp())
    .replace(/@@NEXT_UPDATE@@/g, nextRun());

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
