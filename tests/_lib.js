/* Neon Void 测试基建共享库（无第三方依赖）
   - 从 index.html 源码里按名字提取真实的 const 声明 / function 定义（字符串与注释感知的花括号配对），
     单测跑的就是游戏本体的纯逻辑，不是手抄复刻。
   - buildSandbox() 把提取出的编解码器 / 随机流 / 留存清洗 / 画质档位装进一个可注入
     G / toast / location / Date 的沙箱，供 unit.test.js 与 e2e.test.js 共用。
   - 迷你测试框架 createSuite()/assert：零依赖，node 直跑。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let _src = null;
function getSource() {
  if (_src === null) _src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return _src;
}

/* ---- 源码提取：跳过字符串、注释与正则字面量，做括号深度配对 ----
   正则字面量（如 b64uDec 的 .replace(/\//g,'_')）里的转义斜杠会被误当注释，
   需按「前一有效 token」启发式区分除号与正则：操作符/开括号/关键字后是正则，标识符/数字/闭括号后是除号。 */
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && ' \t\r\n'.indexOf(src[j]) >= 0) j--;
  if (j < 0) return true;
  const ch = src[j];
  if (/[)\]'\"0-9a-zA-Z_$]/.test(ch)) {
    if (/[a-zA-Z_$]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[a-zA-Z_$0-9]/.test(src[k])) k--;
      if (REGEX_KEYWORDS.has(src.slice(k + 1, j + 1))) return true;
    }
    return false; // 标识符/数字/`)`/`]`/字符串结尾之后 → 除号
  }
  return true; // 操作符或开括号之后 → 正则
}
function skipRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') { j++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '/') return j;
    if (ch === '\n') return -1; // 正则不跨行 → 判定失误，按除号处理
  }
  return -1;
}
function scanFrom(src, i, stopAtSemi) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) throw new Error('unterminated comment'); i = n + 1; continue; }
    if (c === '/') {
      const r = isRegexStart(src, i) ? skipRegex(src, i) : -1;
      if (r >= 0) { i = r; continue; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (!stopAtSemi && depth <= 0) return i; // 函数模式：花括号闭合即止（声明模式还要等到顶层 `;`）
    }
    else if (stopAtSemi && c === ';' && depth <= 0) return i;
  }
  return i;
}

/* const/let NAME = ...; （单行或跨行数组/对象，遇顶层 `;` 收尾） */
function extractDecl(src, name) {
  const m = src.match(new RegExp('(const|let|var)\\s+' + name + '\\s*='));
  if (!m) throw new Error('declaration not found in index.html: ' + name);
  const end = scanFrom(src, m.index + m[0].length, true);
  return src.slice(m.index, end + 1);
}

/* function NAME(...) { ... }（花括号配对） */
function extractFn(src, name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\s*\\('));
  if (!m) throw new Error('function not found in index.html: ' + name);
  const open = src.indexOf('{', m.index);
  if (open < 0) throw new Error('no body for function ' + name);
  const end = scanFrom(src, open, false);
  return src.slice(m.index, end + 1); // scanFrom 停在闭合 } 上，含尾取到 end+1
}

/* index.html 里的内联逻辑块（两处：画质治理器 if/else 链、recordScore 的 dstat 连续天数段）
   endInclusive=true：含 endMarker 本体；false：切到 endMarker 之前（去掉尾部空白） */
function extractBlock(src, startMarker, endMarker, endInclusive) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('block start marker not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('block end marker not found: ' + endMarker);
  return endInclusive ? src.slice(a, b + endMarker.length) : src.slice(a, b).replace(/\s+$/, '');
}

/* ---- 沙箱：提取出的真实代码 + 可注入环境 ---- */
const SANDBOX_DECLS = ['CL', 'B64U', 'BOUNTY_VER', 'BOUNTY_LEGACY', 'DUEL_VER', 'DUEL_CAPS', 'RKN',
  'UPGRADES', 'SHADOW_DAYS', 'SHADOW_MAXSamples', 'EB_CAP', 'RG', 'RGI', 'pad', 'RSTATE'];
const SANDBOX_FNS = ['b64uEnc', 'b64uDec', 'bountyPack', 'bountyUnpack', 'rushPack', 'rushUnpack', 'rushValid',
  'duelPack', 'duelUnpack', 'duelScorePack', 'duelScoreUnpack', 'duelSeedText',
  'parseHashBounty', 'parseHashRush', 'parseHashDuel', 'parseHashDuelRes',
  'srand', 'rnd', 'dailySeed', 'dateStr', 'overTitle', 'setTier', 'ghostStats',
  'sanitizeDstat', 'sanitizeShadow', 'sanitizeDuels'];

function buildSandbox(env) {
  const src = getSource();
  env = env || {};
  const decls = SANDBOX_DECLS.map(n => extractDecl(src, n)).join('\n');
  const fns = SANDBOX_FNS.map(n => extractFn(src, n)).join('\n');
  const body = '"use strict";\n' + decls + '\n' + fns + '\n' +
    'return { b64uEnc, b64uDec, bountyPack, bountyUnpack, rushPack, rushUnpack, rushValid,\n' +
    '  duelPack, duelUnpack, duelScorePack, duelScoreUnpack, duelSeedText,\n' +
    '  parseHashBounty, parseHashRush, parseHashDuel, parseHashDuelRes,\n' +
    '  srand, rnd, RG, RGI, dailySeed, dateStr, pad, overTitle, setTier, ghostStats,\n' +
    '  sanitizeDstat, sanitizeShadow, sanitizeDuels, ebCap: () => EB_CAP, upgrades: UPGRADES };\n';
  const factory = new Function('G', 'toast', 'location', 'Date', 'localStorage', body);
  const G = env.G || {};
  const toasts = [];
  return {
    api: factory(G, env.toast || ((msg, c) => toasts.push([msg, c])),
      env.location || { hash: '' }, env.Date || Date, env.localStorage || null),
    G, toasts
  };
}

/* recordScore [DAILY2] 连续挑战天数段（真实源码切片，含 G.dstat = ds 落盘）：依赖 G/sanitizeDstat/dateStr/pad/Date/rec2
   [FIX-TEST-DATE] 切片里的 today 来自游戏源码 dateStr()（内部 new Date()）——只给切片注入 DateImpl 不够，
   必须把同一日期同时喂进 buildSandbox 的 Date 绑定，否则 dateStr() 永远走真实日历日：
   测试只在「跑测试的日历日 == 固定时刻日期」时碰巧绿（日期轮转即 5 例全红的事故根因）。
   unlock 同理进沙箱（切片尾部的 unlock('daily7') 不再是 strict 下的 ReferenceError 地雷）。 */
function buildDstatStreak(env) {
  const src = getSource();
  const block = extractBlock(src,
    'const ds = sanitizeDstat(JSON.stringify(G.dstat || {}));',
    'G.dstat = ds;', true);
  const factory = new Function('G', 'sanitizeDstat', 'dateStr', 'pad', 'Date', 'rec2', 'unlock',
    '"use strict";\nreturn function streakTick() {\n' + block + '\n};');
  const sbEnv = env || {};
  return {
    api: buildSandbox(sbEnv).api,
    tick(G, DateImpl, rec2) {
      const D = DateImpl || sbEnv.Date || Date;
      const api = buildSandbox({ ...sbEnv, Date: D }).api;
      const fn = factory(G, api.sanitizeDstat, api.dateStr, api.pad, D,
        rec2 || { s: 0, w: 0, t: 0 }, sbEnv.unlock || (() => {}));
      fn();
      return G.dstat;
    }
  };
}

/* 主循环 [PERF-L] 画质治理器 if/else 链（真实源码切片）：依赖 CFG/G/setTier/RDT。
   「if (CFG.fx === 1) setTier(0);」在 index.html 出现两次（启动应用 CFG 的 :406 与主循环治理器的 :5698），
   治理器是最后一处 → 用 lastIndexOf 锚定。 */
function buildGovernor(env) {
  const src = getSource();
  const startMarker = 'if (CFG.fx === 1) setTier(0);';
  const a = src.lastIndexOf(startMarker);
  if (a < 0) throw new Error('governor start marker not found');
  const b = src.indexOf('if (G.qToast)', a);
  if (b < 0) throw new Error('governor end marker not found');
  const block = src.slice(a, b).replace(/\s+$/, '');
  const factory = new Function('CFG', 'G', 'setTier', 'RDT',
    '"use strict";\nreturn function govTick() {\n' + block + '\n};');
  const sb = buildSandbox(env);
  // 与游戏 G 初始化对齐（index.html G 定义处 tier:0/q:2/tLow:0/tHigh:0/state:'title'）
  Object.assign(sb.G, { tier: 0, q: 2, tLow: 0, tHigh: 0, state: 'title' });
  return { api: sb.api, G: sb.G, toasts: sb.toasts, makeTick(CFG, RDT) { const f = factory(CFG, sb.G, sb.api.setTier, RDT); return () => f(); } };
}

/* ---- 迷你测试框架 ----
   NV_E2E_ONLY=子串：只跑名字含该子串的用例（调试新用例用，不影响 run-all 全量口径） */
function createSuite(name) {
  const cases = [];
  return {
    test(n, fn) { cases.push([n, fn]); },
    async run() {
      const only = process.env.NV_E2E_ONLY;
      const runCases = only ? cases.filter(([n]) => n.indexOf(only) >= 0) : cases;
      let pass = 0;
      const fails = [];
      const t0 = Date.now();
      for (const [n, fn] of runCases) {
        try { await fn(); pass++; console.log('  \u2713 ' + n); }
        catch (e) {
          fails.push([n, e]);
          console.log('  \u2717 ' + n + '\n      ' + (e && e.message).split('\n').join('\n      '));
          if (e && e.stack) console.log('      at ' + e.stack.split('\n').filter(l => l.indexOf('e2e.test.js') >= 0 || l.indexOf('unit.test.js') >= 0).slice(0, 2).join('\n      at '));
        }
      }
      console.log(`\n[${name}] ${pass} passed, ${fails.length} failed, ${runCases.length} total${only ? ' (NV_E2E_ONLY=\'' + only + '\', 全量 ' + cases.length + ')' : ''} (${Date.now() - t0}ms)\n`);
      return { pass, fails, total: runCases.length };
    }
  };
}

/* 键序不敏感的稳定序列化（深比较用） */
function stableJson(x) {
  if (Array.isArray(x)) return '[' + x.map(stableJson).join(',') + ']';
  if (x && typeof x === 'object') {
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableJson(x[k])).join(',') + '}';
  }
  return JSON.stringify(x);
}
const assert = {
  ok(v, msg) { if (!v) throw new Error((msg || 'assert.ok') + ' — got ' + JSON.stringify(v)); },
  eq(a, b, msg) { if (a !== b) throw new Error((msg || 'assert.eq') + ` — actual ${JSON.stringify(a)} !== expected ${JSON.stringify(b)}`); },
  deep(a, b, msg) {
    const ja = stableJson(a), jb = stableJson(b);
    if (ja !== jb) throw new Error((msg || 'assert.deep') + ` — ${ja} !== ${jb}`);
  },
  isNull(v, msg) { if (v !== null) throw new Error((msg || 'assert.isNull') + ' — got ' + JSON.stringify(v)); }
};

/* 可控日期：new FakeDate() 返回固定时刻，静态 now() 同步；带参构造照常（setDate 等可用） */
function fakeDateCtor(fixedMs) {
  return class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  };
}

module.exports = { ROOT, getSource, extractDecl, extractFn, extractBlock, buildSandbox, buildDstatStreak, buildGovernor, createSuite, assert, fakeDateCtor };
