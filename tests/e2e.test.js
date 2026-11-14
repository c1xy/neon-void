#!/usr/bin/env node
/* Neon Void E2E — playwright headless（无第三方依赖，playwright 从本仓库 node_modules /
   全局 npm / @playwright/cli 内置 playwright-core 三路解析；浏览器优先内置 chromium，
   缺失时回落系统 Chrome / Edge channel）。
   覆盖：10 形态逐一 boot、四码加载路径、每日挑战同日确定性、画质三档切换、
   种子对决全链路（构建→码→开局→成绩码→对决史）、昨日之影采样与回放、
   ghost/brb 胜局实机（NV_CHEAT.hp1 辅助钩子，走真实受击死亡→winGame 路径）。
   截图输出：环境变量 NV_E2E_SHOTS 指定的目录（缺省 = 系统临时目录下的 neon-void-e2e-shots）。
   运行：node tests/e2e.test.js */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ROOT, createSuite, assert, buildSandbox } = require('./_lib');

const codec = buildSandbox().api;
const NC = codec.upgrades.length;
const SHOTS = process.env.NV_E2E_SHOTS || path.join(os.tmpdir(), 'neon-void-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const VIEW = { width: 844, height: 390 }; // 横屏手机基准视口（compact 分支）

/* ---------- 静态服务器（自带，no-store 防缓存串档） ---------- */
function serveStatic() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('#')[0].split('?')[0]);
    if (p === '/' || p === '//') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}

/* ---------- playwright 三路解析 + 浏览器回落 ---------- */
function requirePlaywright() {
  const tried = [];
  for (const m of ['playwright', 'playwright-core']) {
    try { return require(m); } catch (e) { tried.push(m); }
  }
  const cands = [];
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright-core'));
  cands.push('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core');
  cands.push('/usr/local/lib/node_modules/@playwright/cli/node_modules/playwright-core');
  for (const c of cands) {
    try { return require(c); } catch (e) { tried.push(c); }
  }
  throw new Error('找不到 playwright / playwright-core（尝试过: ' + tried.join(' , ') + '）。请 npm i -D playwright，或全局安装 @playwright/cli。');
}
async function launchBrowser(pw) {
  const errs = [];
  for (const opt of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await pw.chromium.launch({
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
        ...opt
      });
    } catch (e) { errs.push((opt.channel || 'bundled') + ': ' + String(e.message || e).split('\n')[0]); }
  }
  throw new Error('无法启动 Chromium（依次尝试 bundled/chrome/msedge channel）— ' + errs.join(' | '));
}

/* ---------- 页面工具 ---------- */
async function boot(browser, base, opts) {
  opts = opts || {};
  // hasTouch → Chromium 设备模拟把 pointer 标为 coarse → 命中游戏的移动端横屏媒体查询，
  // 画布铺满 844×390（桌面 pointer:fine 会退回 16:10 信箱式 599×374，不是真机形态）
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, hasTouch: true });
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }); } catch (e) {}
  if (opts.ls) {
    for (const [k, v] of Object.entries(opts.ls)) {
      await ctx.addInitScript(([k2, v2]) => { try { localStorage.setItem(k2, v2); } catch (e) {} }, [k, v]);
    }
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.goto(base + '/index.html' + (opts.hash || ''), { waitUntil: 'load' });
  await page.waitForFunction('typeof window.NV_SNAP === "function"', null, { timeout: 20000 });
  await page.waitForTimeout(350); // 首帧渲染稳定
  return {
    ctx, page, errors,
    snap: () => page.evaluate('window.NV_SNAP()'),
    waitState: (s, t) => page.waitForFunction('window.NV_SNAP().state === "' + s + '"', null, { timeout: t || 15000 }),
    waitStage: (s, t) => page.waitForFunction('window.NV_SNAP().tStage === "' + s + '"', null, { timeout: t || 8000 }),
    shot: n => page.screenshot({ path: path.join(SHOTS, n + '.png') })
  };
}
async function startModeByKey(page, digit) {
  await page.keyboard.press(digit);
  await page.waitForFunction('window.NV_SNAP().tStage === "players"', null, { timeout: 8000 });
  await page.keyboard.press('1'); // 单人出击
  await page.waitForFunction('window.NV_SNAP().state === "playing"', null, { timeout: 8000 });
}
/* NV_CHEAT.kill() 循环：镜面护盾词条会先碎盾，循环打到结算屏为止 */
async function forceOver(b) {
  for (let i = 0; i < 8; i++) {
    if ((await b.snap()).state === 'over') return;
    await b.page.evaluate('window.NV_CHEAT.kill()');
    await b.page.waitForTimeout(700);
  }
  throw new Error('NV_CHEAT.kill() 循环 8 次后仍未进入结算屏');
}
/* 等待对局结束（真实击杀路径），超时返回当前状态供断言 */
async function waitOver(b, ms) {
  try { await b.waitState('over', ms); } catch (e) {}
  return (await b.snap()).state;
}
function composition(snap) {
  // 波次构成 = 未出生队列 + 已在场敌人（类型多重集，帧序无关 → 无竞态）
  return snap.queue.slice().sort().concat(snap.enemies.map(e => e[0]).sort()).join(',');
}
/* 等剪贴板出现非空文本（copyText 异步落板） */
async function waitClipboard(page) {
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const t = await page.evaluate('navigator.clipboard.readText().catch(() => "")');
    if (t) return t;
  }
  return '';
}
/* [FIX-COS13] 结算底部亮像素剖面（活体 canvas，无需 OCR）：
   x∈[262,582) 覆盖 CTA/热键提示/悬赏提示三行文字水平范围，y∈[296,347) 在按钮带（y348）上缘之下。
   3 次采样取每行最大值——CTA 行呼吸脉冲（alpha 0.45~1.0，周期 ~2.1s）相位免疫。
   阈值 400（RGB 和）：文字墨色 ≥440（提示行 rgba(150,190,240,.75)）、CTA 峰值 ≥630；
   背景/星尘/暗隙 <250。 */
async function bottomRowsMax(page) {
  const read = `(() => {
    const cv = document.getElementById('nv-canvas');
    const c2 = cv.getContext('2d');
    const img = c2.getImageData(262, 296, 320, 51);
    const out = [];
    for (let y = 0; y < 51; y++) {
      let m = 0;
      for (let x = 0; x < 320; x++) {
        const i = (y * 320 + x) * 4;
        const s = img.data[i] + img.data[i + 1] + img.data[i + 2];
        if (s > m) m = s;
      }
      out.push(m);
    }
    return out;
  })()`;
  const samples = [await page.evaluate(read)];
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(300);
    samples.push(await page.evaluate(read));
  }
  return samples[0].map((v, y) => Math.max(v, samples[1][y], samples[2][y]));
}
function runsOf(rows) {
  const runs = [];
  rows.forEach((v, i) => {
    const yy = 296 + i, on = v > 400;
    if (on && (!runs.length || runs[runs.length - 1].end < yy - 1)) runs.push({ start: yy, end: yy });
    else if (on) runs[runs.length - 1].end = yy;
  });
  return runs;
}
/* 断言：底部文字行互不叠印——段间暗隙 ≥2px，最底行不进按钮带（y348）。
   [FIX-COS12] 回归（CTA 与提示行 1px 中心距完全叠印）即由「段间暗隙」抓出。 */
function assertRowsSeparated(runs, tag) {
  const s = JSON.stringify(runs);
  assert.ok(runs.length >= 2, tag + '：底部至少两行文字（CTA + 热键提示行），实测亮段 ' + s);
  for (let i = 1; i < runs.length; i++) {
    assert.ok(runs[i].start - runs[i - 1].end - 1 >= 2, tag + '：文字行间暗隙 ≥2px（段' + (i - 1) + '→' + i + '）实测 ' + s);
  }
  assert.ok(runs[runs.length - 1].end <= 347, tag + '：最底文字行在按钮带（y348）之上，实测 ' + s);
}
/* [A11Y-CB] 画布取色（整段在页面内执行）：以 (x,y) 为中心读 16×16，按饱和像素（max-min≥45 且
   max≥60，排除暗背景/白色弹核/灰字）主色归类：blue(B>R+40 且 B>G+20)/green(G 主导)/cbOrange
   (橙且 G≥130：色盲板 #ffa02e G=160)/orange(橙但 G<130：原生狙击弹 #ff6a3c G≈106)/pink(R>B>G：
   原生 #ff5577)。弹幕采样走「同一帧快照+取色」（单次 evaluate，弹在两次调用间会飞走）。 */
async function probeEB(page) {
  await waitFreshFrame(page);
  return page.evaluate(() => {
    const famOf = (c2, x, y, w, h) => {
      const img = c2.getImageData(x, y, w, h).data;
      const f = { blue: 0, green: 0, cbOrange: 0, orange: 0, pink: 0 };
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i], g = img[i + 1], b = img[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn < 45 || mx < 60) continue;
        if (b > r + 40 && b > g + 20) f.blue++;
        else if (g > r && g >= b) f.green++;
        else if (r > b && g > b && g >= 130) f.cbOrange++;
        else if (r > b && g > b) f.orange++;
        else if (r > b && b > g) f.pink++;
      }
      const best = Object.entries(f).sort((a, b) => b[1] - a[1])[0];
      return { fam: f, best: best[1] > 3 ? best[0] : 'none' };
    };
    const cv = document.getElementById('nv-canvas');
    const c2 = cv.getContext('2d');
    const s = window.NV_SNAP();
    // 只取离飞船 >36px（飞船青蓝辉光会污染取色）、离 BOSS >70px（弹自 BOSS 中心出膛，BOSS 本体色主导）的弹
    const far = (x, y) => {
      if (s.pp && (x - s.pp[0]) * (x - s.pp[0]) + (y - s.pp[1]) * (y - s.pp[1]) < 36 * 36) return false;
      if (s.boss && s.boss.length > 5 && (x - s.boss[4]) * (x - s.boss[4]) + (y - s.boss[5]) * (y - s.boss[5]) < 70 * 70) return false;
      return true;
    };
    return s.ebS.filter(b => far(b[2], b[3])).slice(-4).map(b => {
      const x = Math.max(0, Math.min(cv.width - 16, b[2] - 8));
      const y = Math.max(0, Math.min(cv.height - 16, b[3] - 8));
      const p = famOf(c2, x, y, 16, 16);
      return { bd: b[0], sh: b[5], c: b[6], x: b[2], y: b[3], fam: p.fam, best: p.best };
    });
  });
}
async function probePick(page, i) {
  await waitFreshFrame(page);
  return page.evaluate(idx => {
    const cv = document.getElementById('nv-canvas');
    const c2 = cv.getContext('2d');
    const s = window.NV_SNAP();
    const p = s.picks[idx];
    if (!p) return null;
    const x = Math.max(0, Math.min(cv.width - 16, p[1] - 8));
    const y = Math.max(0, Math.min(cv.height - 16, p[2] - 8));
    const img = c2.getImageData(x, y, 16, 16).data;
    const f = { blue: 0, green: 0, cbOrange: 0, orange: 0, pink: 0 };
    for (let i2 = 0; i2 < img.length; i2 += 4) {
      const r = img[i2], g = img[i2 + 1], b = img[i2 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 45 || mx < 60) continue;
      if (b > r + 40 && b > g + 20) f.blue++;
      else if (g > r && g >= b) f.green++;
      else if (r > b && g > b && g >= 130) f.cbOrange++;
      else if (r > b && g > b) f.orange++;
      else if (r > b && b > g) f.pink++;
    }
    const best = Object.entries(f).sort((a, b) => b[1] - a[1])[0];
    return { k: p[0], x: p[1], y: p[2], fam: f, best: best[1] > 3 ? best[0] : 'none' };
  }, i);
}
/* 等待 ≥2 跳 rAF：canvas 是 rAF 驱动的活体，无头环境 waitForTimeout 跨度内可能一帧都没渲染
   （实机取证：静态弹已入快照但 getImageData 读到的是生成前帧）。rAF 到来 ⇒ 主循环至少画了一帧。 */
async function waitFreshFrame(page) {
  await page.evaluate(() => new Promise(resolve => {
    let n = 0;
    const tick = () => { if (++n >= 3) resolve(true); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(false), 1500);
  }));
}
/* [A11Y-MONKEY] 可复现随机源（mulberry32）：固定 seed 让压力用例失败时可重放 */
function monkeyRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/* 退回标题页：按当前状态走真实键盘路径（levelup 先选卡 → 暂停 → T 回标题 → ESC 收拢子页） */
async function backToTitle(b, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) {
    const sn = await b.snap();
    if (sn.state === 'title' && sn.tStage === 'mode') return sn;
    if (sn.state === 'levelup') await b.page.keyboard.press('Digit1');
    else if (sn.state === 'playing') await b.page.keyboard.press('KeyP');
    else if (sn.state === 'paused') await b.page.keyboard.press('KeyT');
    else if (sn.state === 'over') { await b.page.waitForTimeout(900); await b.page.keyboard.press('KeyT'); }
    else if (sn.state === 'wgate') await b.page.keyboard.press('KeyT');
    else await b.page.keyboard.press('Escape'); // title 子页（set/ach/guide/…）逐层收拢
    await b.page.waitForTimeout(350);
  }
  throw new Error((ms || 20000) + 'ms 内未能退回标题页');
}

(async () => {
  const pw = requirePlaywright();
  const browser = await launchBrowser(pw);
  const { srv, base } = await serveStatic();
  const s = createSuite('e2e');

  /* ================= 10 形态逐一 boot ================= */
  const MODES7 = [['1', 'classic'], ['2', 'endless'], ['3', 'boss'], ['4', 'chaos'], ['5', 'daily'], ['6', 'versus'], ['7', 'graze']];
  for (const [digit, mode] of MODES7) {
    s.test('boot：模式「' + mode + '」（键盘 ' + digit + ' → 单人出击）', async () => {
      const b = await boot(browser, base);
      await startModeByKey(b.page, digit);
      const sn = await b.snap();
      assert.eq(sn.state, 'playing', '进入对局');
      assert.eq(sn.mode, mode, '模式正确');
      assert.deep(b.errors, [], '无未捕获异常');
      await b.shot('boot-mode-' + mode);
      await b.ctx.close();
    });
  }
  s.test('boot：残影悬赏页（#bounty= 载入 → 残影 BOSS 在场）', async () => {
    const code = codec.bountyPack({ lv: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wave: 7, score: 5000, grazes: 10, chain: 2 });
    const b = await boot(browser, base, { hash: '#bounty=' + code });
    const st0 = await b.snap();
    assert.eq(st0.tStage, 'ghost', '悬赏页形态');
    await b.shot('boot-stage-ghost');
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const sn = await b.snap();
    assert.eq(sn.mode, 'ghost', '迎战残影');
    assert.ok(sn.boss && sn.boss[3] > 0, '残影 BOSS 在场');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });
  s.test('boot：连战构建器页（B → Enter 出击自定义连战）', async () => {
    const b = await boot(browser, base, { ls: { neonvoid_rush: JSON.stringify({ order: [2, 0], tier: 1 }) } });
    await b.page.keyboard.press('b');
    await b.waitStage('brb');
    await b.shot('boot-stage-brb');
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const sn = await b.snap();
    assert.eq(sn.mode, 'brb', '进入连战构建');
    assert.ok(sn.boss && sn.boss[0] === 2, '首场 BOSS = 出场序列第 1 位（湮灭核心 ki=2）');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });
  s.test('boot：种子对决构建页（主界面 chip 点击进入）', async () => {
    const b = await boot(browser, base);
    await b.page.mouse.click(647, 64); // ⚔ 种子对决 chip（W-256..W-138, y 48..80）
    await b.waitStage('duel');
    await b.shot('boot-stage-duel');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });
  s.test('boot：对决结果页（#duelres= 载入 → 待你开卷）', async () => {
    const code = codec.duelScorePack({ seed: 0x00ABCDEF, cap: 10, lv: new Array(NC).fill(0), score: 8888, wave: 4, won: false, rank: 'C' });
    const b = await boot(browser, base, { hash: '#duelres=' + code });
    const st0 = await b.snap();
    assert.eq(st0.tStage, 'duelres', '结果页形态');
    assert.eq(st0.duels.length, 1, '对手成绩已入对决史');
    assert.eq(st0.duels[0].res, '', '尚未判定（待你开卷）');
    await b.shot('boot-stage-duelres');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });

  /* ================= 四码加载路径（数据逐字段核对） ================= */
  s.test('四码路径 #bounty=：wave/score/lv/chain → ghostStats 血量吻合', async () => {
    const d = { lv: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wave: 7, score: 5000, grazes: 10, chain: 2 };
    const code = codec.bountyPack(d);
    const b = await boot(browser, base, { hash: '#bounty=' + code });
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const sn = await b.snap();
    // spawnGhostBoss：G.boss.hp = ghostStats(G.ghost).hp —— 悬赏数据真实流入 BOSS 血量
    const st = codec.ghostStats(d);
    assert.ok(sn.boss, '残影 BOSS 在场');
    assert.eq(sn.boss[3], st.hp, 'BOSS maxhp = ghostStats(悬赏数据).hp（score 5000/chain 2 → ' + st.hp + '）');
    assert.eq(sn.wave, 7, '残影来源波次展示');
    await b.ctx.close();
  });
  s.test('四码路径 #rush=：order/tier → 出场序列直达构建器确认页并入局', async () => {
    const cfg = { order: [4, 1], tier: 2 };
    const code = codec.rushPack(cfg);
    const b = await boot(browser, base, { hash: '#rush=' + code });
    assert.eq((await b.snap()).tStage, 'brb', '分享链接直达构建器确认页');
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const sn = await b.snap();
    assert.eq(sn.mode, 'brb');
    assert.ok(sn.boss && sn.boss[0] === 4, '首场 BOSS = order[0]（虚空幻影 ki=4）');
    await b.ctx.close();
  });
  s.test('四码路径 #duel=：seed/cap/lv → duelRun 快照逐字段吻合', async () => {
    const d = { seed: 0x3E9AB077, lv: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], cap: 10 };
    const code = codec.duelPack(d);
    const b = await boot(browser, base, { hash: '#duel=' + code });
    const st0 = await b.snap();
    assert.eq(st0.tStage, 'duel', '对决确认页');
    await b.shot('duel-confirm-loaded');
    await b.page.keyboard.press('Enter'); // 出击即开卷
    await b.waitState('playing');
    const sn = await b.snap();
    assert.eq(sn.mode, 'duel');
    assert.eq(sn.duelRun.seed, 0x3E9AB077 >>> 0, 'seed 入局');
    assert.eq(sn.duelRun.cap, 10, '波次上限入局');
    assert.eq(sn.duelRun.lv[0], 1, '初始构筑卡 0');
    assert.eq(sn.duelRun.lv[2], 2, '初始构筑卡 2');
    await b.ctx.close();
  });
  s.test('四码路径 #duelres=：新档案建档待战 + 同档案合并判定（w/l/t 三态）', async () => {
    const seed = 0x00D0E11; // 任意 32 位种子
    const mkLs = meScore => ({ neonvoid_duels: JSON.stringify([{ seed: seed >>> 0, cap: 10, deck: [], me: { s: meScore, w: 9, win: false, r: 'B' }, opp: null, res: '', t: Date.now() }]) });
    // ① 新档案：对手成绩码先到 → 建档待战（me=null, res=''）
    const oppCode = { seed, cap: 10, lv: new Array(NC).fill(0), score: 30000, wave: 9, won: false, rank: 'B' };
    const b1 = await boot(browser, base, { hash: '#duelres=' + codec.duelScorePack(oppCode) });
    let sn = await b1.snap();
    assert.eq(sn.duels[0].seed, seed >>> 0, 'seed 入档');
    assert.isNull(sn.duels[0].me, '本机还没开卷');
    assert.eq(sn.duels[0].opp, 30000, '对手成绩入档');
    assert.eq(sn.duels[0].res, '', '待判定');
    await b1.ctx.close();
    // ② 同档案（me.s=31000）：对手 30000 → 我赢 res='w'
    const b2 = await boot(browser, base, { hash: '#duelres=' + codec.duelScorePack(oppCode), ls: mkLs(31000) });
    sn = await b2.snap();
    assert.eq(sn.duels[0].res, 'w', '我 31000 > 对手 30000 → 判我胜');
    await b2.ctx.close();
    // ③ 同档案：对手 31000 同分 → res='t'
    const tie = { seed, cap: 10, lv: new Array(NC).fill(0), score: 31000, wave: 9, won: false, rank: 'B' };
    const b3 = await boot(browser, base, { hash: '#duelres=' + codec.duelScorePack(tie), ls: mkLs(31000) });
    sn = await b3.snap();
    assert.eq(sn.duels[0].res, 't', '同分 → 平');
    await b3.ctx.close();
    // ④ 同档案：对手 32000 更高 → 我输 res='l'
    const lose = { seed, cap: 10, lv: new Array(NC).fill(0), score: 32000, wave: 9, won: false, rank: 'A' };
    const b4 = await boot(browser, base, { hash: '#duelres=' + codec.duelScorePack(lose), ls: mkLs(31000) });
    sn = await b4.snap();
    assert.eq(sn.duels[0].res, 'l', '我 31000 < 对手 32000 → 判我负');
    await b4.ctx.close();
  });

  /* ================= 每日挑战同日确定性 ================= */
  s.test('每日挑战同日确定性：两次开局 dseed / 词条 / 波次构成一致', async () => {
    const run = async () => {
      const b = await boot(browser, base);
      await startModeByKey(b.page, '5'); // 每日挑战
      await b.page.waitForTimeout(400);  // 首个出兵延迟 ~1.15s 未到 → 队列未消耗
      const sn = await b.snap();
      await b.ctx.close();
      return { dseed: sn.dseed, muts: sn.muts.slice(), comp: composition(sn), wave: sn.wave };
    };
    const r1 = await run();
    const r2 = await run();
    assert.eq(r1.wave, 1, '两次都停在第 1 波');
    assert.deep(r1.muts, r2.muts, '全员同词条（startGame 同步抽取，无帧竞态）');
    assert.deep(r1.comp, r2.comp, '波次 1 构成（未出生队列+在场敌人）一致');
    // [DAILY2] 种子断言用「种子输入」dseed（帧序无关）：旧版比较播种后的 RSTATE 状态快照，与首个
    // 出兵（≈1.15s）存在竞态——无头 rAF 抖动让 waitState 迟到 800ms+ 时种子流已被消耗，两轮偶发不等。
    assert.ok(r1.dseed != null && r2.dseed != null, '两次都记录了每日种子输入');
    assert.eq(r1.dseed, r2.dseed, '同日种子输入一致（同日同卷）');
    assert.eq(r1.dseed, codec.dailySeed() >>> 0, '种子 = 本地日期种子');
    assert.ok(r1.comp.length > 0, '构成非空');
  });

  /* ================= 画质三档切换 ================= */
  s.test('画质三档：手动锁档（cfg fx=1→L0 / fx=2→L2）+ NV_CHEAT 治理器降档/回升', async () => {
    // ① 手动「高」fx=1 → 锁 L0；手动「低」fx=2 → 锁 L2（真实 neonvoid_cfg 读取路径）
    for (const [fx, tier, cap] of [[1, 0, 400], [2, 2, 300]]) {
      const b = await boot(browser, base, { ls: { neonvoid_cfg: JSON.stringify({ fx }) } });
      await b.page.waitForTimeout(400); // 主循环每帧 setTier 锁档
      const sn = await b.snap();
      assert.eq(sn.tier, tier, 'fx=' + fx + ' → L' + tier);
      assert.eq(sn.ebCap, cap, '弹幕上限随档位');
      await b.ctx.close();
    }
    // ② 自动档治理器：NV_CHEAT.fps/lowNow/highNow 驱动真实主循环
    const b = await boot(browser, base);
    await startModeByKey(b.page, '1'); // classic（治理器只在对局中计量）
    const snap0 = await b.snap();
    assert.eq(snap0.tier, 0, '默认自动档 L0');
    await b.page.evaluate('window.NV_CHEAT.fps(30); window.NV_CHEAT.lowNow()');
    await b.page.waitForFunction('window.NV_SNAP().tier === 1', null, { timeout: 8000 });
    let sn = await b.snap();
    assert.eq(sn.ebCap, 400, 'L1 弹幕上限仍 400');
    assert.ok(sn.qToast && sn.qToast.indexOf('画质降档 · L1') >= 0, '降档提示 L1');
    await b.page.evaluate('window.NV_CHEAT.lowNow()');
    await b.page.waitForFunction('window.NV_SNAP().tier === 2', null, { timeout: 8000 });
    sn = await b.snap();
    assert.eq(sn.ebCap, 300, 'L2 弹幕上限 300');
    assert.ok(sn.qToast && sn.qToast.indexOf('弹幕上限 300') >= 0, '降档提示 L2');
    await b.page.evaluate('window.NV_CHEAT.fps(60); window.NV_CHEAT.highNow()');
    await b.page.waitForFunction('window.NV_SNAP().tier === 1', null, { timeout: 8000 });
    sn = await b.snap();
    assert.ok(sn.qToast && sn.qToast.indexOf('回升') >= 0, '方向感知：回升提示（不再叫降档）');
    await b.page.evaluate('window.NV_CHEAT.highNow()');
    await b.page.waitForFunction('window.NV_SNAP().tier === 0', null, { timeout: 8000 });
    sn = await b.snap();
    assert.eq(sn.ebCap, 400, 'L0 弹幕上限回 400');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });

  /* ================= 种子对决全链路 ================= */
  s.test('种子对决全链路：构建→码→开局→成绩码→对决史→判胜负', async () => {
    const b = await boot(browser, base);
    // ① 构建：进入构建页（chip），📅 今日日期种子 / 5 波上限 / 火力强化 1 级
    await b.page.mouse.click(647, 64);
    await b.waitStage('duel');
    await b.page.mouse.click(503, 109); // 📅 今日日期（dseed:t）
    await b.page.mouse.click(284, 139); // 5 波（dcap:5 首档）
    await b.page.mouse.click(95, 185);  // 卡 0 火力强化（dcard:0 → Lv1）
    await b.page.waitForTimeout(150);
    // ② 码：⧉ 复制对决链接（dshare）→ 剪贴板
    await b.page.mouse.click(422, 333);
    const link = await waitClipboard(b.page);
    assert.ok(/#duel=[A-Za-z0-9\-_]{28}$/.test(link), '剪贴板拿到 #duel= 链接：' + link);
    const code = link.split('#duel=')[1];
    const built = codec.duelUnpack(code);
    assert.ok(built, '对决码可解');
    assert.eq(built.seed, codec.dailySeed(), 'dseed:t 后码内 seed = 本机今日日期种子');
    assert.eq(built.cap, 5, '码内波次上限 5');
    assert.eq(built.lv[0], 1, '码内初始构筑火力强化 Lv1');
    // ③ 开局：码 → 确认页 → 出击
    const b2 = await boot(browser, base, { hash: '#duel=' + code });
    assert.eq((await b2.snap()).tStage, 'duel', '对手打开链接直达确认页');
    await b2.page.keyboard.press('Enter');
    await b2.waitState('playing');
    const run0 = await b2.snap();
    assert.eq(run0.duelRun.seed, built.seed, '对决 seed 入局');
    assert.eq(run0.duelRun.cap, 5, '上限 5 入局');
    assert.eq(run0.duelRun.lv[0], 1, '构筑入局');
    // ④ 打完一局：先让自动开火攒到分数（判定门槛 me.s > 0），再 kill 循环走真实 recordScore 路径
    await b2.page.waitForFunction('window.NV_SNAP().score > 0', null, { timeout: 30000 });
    await forceOver(b2);
    const over = await b2.snap();
    assert.eq(over.state, 'over');
    assert.ok(over.score > 0, '本局有得分（判定前提）');
    await b2.shot('duel-settle-844x390');
    // ⑤ 成绩码：结算屏按 D → 剪贴板
    await b2.page.waitForTimeout(900); // G.over > 0.7 解锁热键
    await b2.page.keyboard.press('d');
    const scoreLink = await waitClipboard(b2.page);
    assert.ok(/#duelres=[A-Za-z0-9\-_]{35}$/.test(scoreLink), '剪贴板拿到 #duelres= 成绩码链接');
    const res = codec.duelScoreUnpack(scoreLink.split('#duelres=')[1]);
    assert.ok(res, '成绩码可解');
    assert.eq(res.seed, built.seed, '成绩码 seed 与对决码一致（同码同卷）');
    assert.eq(res.cap, 5, '成绩码带上限');
    assert.eq(res.won, false, '本局未打满（击杀结束）→ won=false');
    assert.ok(res.score >= 0, '得分入码');
    // ⑥ 对决史：本机成绩入档（me 侧，NV_SNAP 里 me = 得分数字）
    const hist = await b2.snap();
    assert.ok(hist.duels.length >= 1, '对决史有记录');
    assert.eq(hist.duels[0].seed, built.seed >>> 0, '对决史行 seed');
    assert.ok(hist.duels[0].me === over.score, '本机成绩入档（me = 结算得分）');
    // ⑦ 判胜负：同档案打开对手（更低分）成绩码 → res='w'
    const opp = { seed: built.seed, cap: 5, lv: built.lv.slice(), score: Math.max(0, over.score - 100), wave: res.wave, won: false, rank: 'D' };
    await b2.page.keyboard.press('t'); // 回主界面（hashchange 需要 title 态）
    await b2.waitStage('mode');
    await b2.page.evaluate('location.hash = "#duelres=' + codec.duelScorePack(opp) + '"');
    await b2.waitStage('duelres');
    const judged = await b2.snap();
    assert.eq(judged.duels[0].res, 'w', '我方分高 → 判胜');
    await b2.shot('duel-result-judged');
    assert.deep(b2.errors, [], '无未捕获异常');
    await b2.ctx.close();
    await b.ctx.close();
  });

  /* ================= 昨日之影：采样与回放 ================= */
  s.test('昨日之影：昨日采样注入 → 开局召唤回放 → 本机采样落盘 → 结算对比', async () => {
    const d = (off) => { const t = new Date(); t.setDate(t.getDate() + off); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    const yday = d(-1), today = d(0);
    const yEntry = { sc: 1234, w: 3, s: [100, 80, 0, 200, 120, 1, 300, 160, 0, 380, 200, 2, 420, 230, 0, 300, 150, 1] };
    const b = await boot(browser, base, { ls: { neonvoid_shadow: JSON.stringify({ v: 1, days: { [yday]: yEntry } }) } });
    await b.page.keyboard.press('5'); // 每日挑战 → 单人选择页（出现召唤开关）
    await b.waitStage('players');
    await b.page.mouse.click(567, 272); // 👻 召唤昨日之影（shsum：W/2+70..+220, y H*0.525+54..+80）
    await b.page.waitForTimeout(150);
    await b.page.keyboard.press('1'); // 单人出击
    await b.waitState('playing');
    const sn0 = await b.snap();
    assert.eq(sn0.shadowRun, true, '本局为影子对照局');
    assert.ok(sn0.shadowRef && sn0.shadowRef.sc === 1234, '昨日之影数据已召唤（shadowRef.sc=1234）');
    await b.page.waitForTimeout(2200); // 0.5s/样 → ≥3 样
    const sn1 = await b.snap();
    assert.ok(sn1.shSampN >= 3, '对局中按 0.5s 采样（shSampN=' + sn1.shSampN + '）');
    // 打完本局 → shadowSaveRun 落盘今日采样（同日取更高分）
    await forceOver(b);
    const stored = await b.page.evaluate('localStorage.getItem("neonvoid_shadow")');
    const parsed = JSON.parse(stored);
    assert.ok(parsed.days[today] && parsed.days[today].s.length >= 6, '本局采样落盘（明日可回放）');
    assert.eq(parsed.days[yday].sc, 1234, '昨日条目保留（7 天环形窗口内）');
    // 结算屏：昨日之影对比行 + 844×390 底部布局证据（提示行让位修复的实机验证）
    const sn2 = await b.snap();
    assert.ok(sn2.shadowRef, '结算对比数据在');
    await b.page.waitForTimeout(1600); // 等 G.over>0.7 的 CTA/提示行入场（[FIX-COS13] 亮像素剖面验证）
    await b.shot('shadow-settle-844x390');
    assertRowsSeparated(runsOf(await bottomRowsMax(b.page)), '每日+影子对照结算（极端 stack）');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });

  /* ================= ghost / brb 胜局实机（NV_CHEAT.hp1 辅助） ================= */
  s.test('ghost 胜局实机：hp1 辅助 → 真实受击死亡 → winGame → 残影讨伐结算', async () => {
    const code = codec.bountyPack({ lv: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wave: 7, score: 5000, grazes: 10, chain: 2 });
    const b = await boot(browser, base, { hash: '#bounty=' + code });
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const before = await b.snap();
    assert.ok(before.boss, '残影 BOSS 在场');
    await b.page.evaluate('window.NV_CHEAT.hp1()'); // 辅助钩子：血量置 1，飞船自动开火走真实伤害路径
    await b.waitState('over', 20000);
    const sn = await b.snap();
    assert.eq(sn.won, true, '真实胜利路径（winGame）');
    assert.eq(sn.state, 'over');
    await b.page.waitForTimeout(1600); // 等 CTA/按钮带入场
    await b.shot('ghost-win-settle-844x390');
    assertRowsSeparated(runsOf(await bottomRowsMax(b.page)), 'ghost 胜局结算（击杀链提示在场对照组）');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });
  s.test('brb 胜局实机：hp1 辅助 → 通关自定义连战 → 全灭达成结算', async () => {
    const b = await boot(browser, base, { ls: { neonvoid_rush: JSON.stringify({ order: [0], tier: 0 }) } });
    await b.page.keyboard.press('b');
    await b.waitStage('brb');
    await b.page.keyboard.press('Enter');
    await b.waitState('playing');
    const before = await b.snap();
    assert.ok(before.boss && before.mode === 'brb', '连战 BOSS 在场');
    await b.page.evaluate('window.NV_CHEAT.hp1()'); // 辅助钩子：单场连战 BOSS 血量置 1
    await b.waitState('over', 20000);
    const sn = await b.snap();
    assert.eq(sn.won, true, '真实胜利路径（b.bn >= ord.length → winGame）');
    assert.eq(sn.state, 'over');
    await b.page.waitForTimeout(1600);
    await b.shot('brb-win-settle-844x390');
    assertRowsSeparated(runsOf(await bottomRowsMax(b.page)), 'brb 胜局结算（无悬赏提示对照组）');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.ctx.close();
  });

  /* ================= [A11Y-CB] 色盲模式 ================= */
  s.test('色盲模式：默认关 + 默认弹幕/拾取物像素原生色 · 开启后杂兵弹橙/BOSS 弹蓝菱/拾取物换板 + 设置页记忆', async () => {
    // ① 默认（无 cfg）：真实杂兵弹 bd=0 且数据持原始色；NV_CHEAT.shot 原地弹取色 = 原生粉红 → 绘制路径未变
    const b0 = await boot(browser, base);
    await startModeByKey(b0.page, '7'); // 擦弹专精：全敌型瞄准弹，第 1 波即出杂兵弹
    await b0.page.waitForFunction('window.NV_SNAP().ebN > 0', null, { timeout: 25000 });
    let sn = await b0.snap();
    assert.eq(sn.cfgCb, 0, '默认 cfgCb=0');
    assert.ok(sn.ebS.every(b => b[0] === 0), '默认弹幕 bd=0（无 BOSS 弹标记）');
    const cols0 = sn.ebS.map(b => b[6]);
    assert.ok(cols0.some(c => (c || '').indexOf('#ff') === 0 || (c || '').indexOf('#3d') === 0), '弹幕数据仍持原始色（模拟层未动）: ' + cols0.slice(0, 3).join(','));
    await b0.page.evaluate('window.NV_CHEAT.shot()'); // 原地悬停弹，自动挑离敌我实体最远的候选点
    await b0.page.waitForTimeout(250);
    let pr = await probeEB(b0.page);
    // 悬停弹窗内只应有自身像素：粉红体 ≥40 且无色盲板族（blue/cbOrange）
    const dflt = pr.slice().sort((a, b) => b.fam.pink - a.fam.pink)[0];
    assert.ok(dflt && dflt.best === 'pink' && dflt.fam.pink >= 40 && dflt.fam.cbOrange <= 2,
      '默认杂兵弹像素 = 原生粉红（' + (dflt ? JSON.stringify(dflt.fam) : '未采样') + '）→ 默认外观不变');
    await b0.page.evaluate('window.NV_CHEAT.pk("T")');
    await b0.page.waitForTimeout(150);
    let pp = await probePick(b0.page, 0);
    assert.ok(pp && pp.best === 'green' && pp.fam.green >= 40 && pp.fam.cbOrange <= 2, '默认 T 拾取物 = 原生绿（' + (pp ? JSON.stringify(pp.fam) : 'null') + '）');
    await b0.ctx.close();
    // ② 色盲模式开启（neonvoid_cfg 注入）：杂兵弹 → 橙像素；BOSS 弹 → 蓝像素；拾取物 T → 橙
    const b1 = await boot(browser, base, { ls: { neonvoid_cfg: JSON.stringify({ cb: 1 }) } });
    await startModeByKey(b1.page, '7');
    await b1.page.waitForTimeout(300);
    assert.eq((await b1.snap()).cfgCb, 1, 'cfg cb=1 已读入');
    let mobOK = false, mobDetail = '';
    for (let i = 0; i < 3 && !mobOK; i++) {
      await b1.page.evaluate('window.NV_CHEAT.shot()');
      await b1.page.waitForTimeout(250);
      pr = await probeEB(b1.page);
      const mob = pr.slice().sort((a, b) => (b.fam.cbOrange + b.fam.orange) - (a.fam.cbOrange + a.fam.orange))[0];
      mobOK = !!mob && (mob.best === 'cbOrange' || mob.best === 'orange') && mob.fam.cbOrange + mob.fam.orange >= 40 && mob.fam.pink <= 2;
      mobDetail = mob ? JSON.stringify(mob.fam) : 'none';
    }
    assert.ok(mobOK, '色盲杂兵弹 = 橙像素（3 轮最佳 ' + mobDetail + '）');
    await b1.page.evaluate('window.NV_CHEAT.bshot()'); // bd=1 弹自 (60,80) 匀速右飞，拖尾蓝线
    await b1.page.waitForTimeout(350);
    pr = await probeEB(b1.page);
    const bsb = pr.filter(p => p.bd === 1).sort((a, b) => b.fam.blue - a.fam.blue)[0];
    assert.ok(bsb && bsb.best === 'blue' && bsb.fam.blue >= 12 && bsb.sh === 4, '色盲 BOSS 弹 = 蓝像素 + 菱形位（' + (bsb ? JSON.stringify(bsb.fam) + ' sh=' + bsb.sh : '未采样') + '）');
    await b1.page.evaluate('window.NV_CHEAT.pk("T")');
    await b1.page.waitForTimeout(150);
    let pkOK = false, pkDetail = '';
    for (let i = 0; i < 3 && !pkOK; i++) {
      if (i > 0) await b1.page.evaluate('window.NV_CHEAT.pk("T")');
      await b1.page.waitForTimeout(150);
      pp = await probePick(b1.page, (await b1.snap()).picks.length - 1);
      pkOK = !!pp && (pp.best === 'cbOrange' || pp.best === 'orange') && pp.fam.cbOrange + pp.fam.orange >= 40 && pp.fam.pink <= 2;
      pkDetail = pp ? JSON.stringify(pp.fam) : 'null';
    }
    assert.ok(pkOK, '色盲 T 拾取物 = 橙系（3 轮最佳 ' + pkDetail + '）');
    await b1.ctx.close();
    // ③ 真实 BOSS 出招路径：BOSS 连战 → updBoss 出招段 bd=1 + 形状位（菱/反弹三角）→ 外环弹取色 = 蓝
    const b2 = await boot(browser, base, { ls: { neonvoid_cfg: JSON.stringify({ cb: 1 }) } });
    await startModeByKey(b2.page, '3');
    await b2.page.waitForFunction('window.NV_SNAP().ebS.some(b => b[0] === 1)', null, { timeout: 25000 });
    sn = await b2.snap();
    const bossB = sn.ebS.filter(b => b[0] === 1);
    assert.ok(bossB.length > 0, 'BOSS 弹（bd=1）在屏（真实 updBoss 路径）');
    assert.ok(bossB.every(b => b[5] === 4 || b[5] === 3), 'BOSS 弹形状位 = 4（菱）/3（反弹三角）');
    let hitB = 0;
    for (let i = 0; i < 4 && !hitB; i++) {
      await b2.page.waitForTimeout(600);
      hitB = (await probeEB(b2.page)).filter(p => p.bd === 1 && p.best === 'blue' && p.fam.blue >= 12).length;
    }
    assert.ok(hitB >= 1, '真实 BOSS 弹外环取色 = 蓝（4 轮采样命中 ' + hitB + '）');
    await b2.ctx.close();
    // ④ 设置页开关 + 记忆入 cfg：S 打开设置 → 点「色盲模式·开」→ CFG 即变 + localStorage 落盘 + 重载仍为开
    const b3 = await boot(browser, base);
    await b3.page.keyboard.press('S');
    await b3.waitStage('set');
    const btns3 = await b3.page.evaluate('window.NV_BTN()');
    const cbOn = btns3.btns.find(x => x.act === 'cfg:cb:1');
    const cbOff = btns3.btns.find(x => x.act === 'cfg:cb:0');
    assert.ok(cbOn && cbOff, '设置页存在「色盲模式」关/开选项（实测 rect ' + JSON.stringify(cbOff || null) + '）');
    assert.eq((await b3.snap()).cfgCb, 0, '点击前默认关');
    await b3.page.mouse.click(cbOn.x + cbOn.w / 2, cbOn.y + cbOn.h / 2);
    await b3.page.waitForTimeout(120);
    assert.eq((await b3.snap()).cfgCb, 1, '点击「开」立即生效');
    const stored = JSON.parse(await b3.page.evaluate('localStorage.getItem("neonvoid_cfg")'));
    assert.eq(stored.cb, 1, '记忆入 neonvoid_cfg');
    // 重载同一页面（localStorage 按 context 隔离，新开 context 不共享）→ 色盲模式留存生效
    await b3.page.reload({ waitUntil: 'load' });
    await b3.page.waitForFunction('typeof window.NV_SNAP === "function"', null, { timeout: 20000 });
    await b3.page.waitForTimeout(300);
    assert.eq((await b3.snap()).cfgCb, 1, '重载后色盲模式仍为开（留存生效）');
    await b3.ctx.close();
  });

  /* ================= [A11Y-T44] 触屏目标 ≥44px ================= */
  s.test('触屏 44px：全阶段按钮 touch rect ≥44 实测（NV_BTN）+ chips/模式/结算/重抽钮外扩点按行为验证', async () => {
    // ① 逐阶段实测：每颗按钮的触屏生效矩形（44px 外扩，与命中共用 touchRect）短边 ≥44
    const stages = [
      ['mode', null],
      ['players', async b => { await b.page.keyboard.press('Digit1'); }],
      ['guide', async b => { await b.page.keyboard.press('KeyG'); }],
      ['ach', async b => { await b.page.keyboard.press('KeyA'); }],
      ['set', async b => { await b.page.keyboard.press('KeyS'); }],
      ['credits', async b => { await b.page.keyboard.press('KeyC'); }],
      ['brb', async b => { await b.page.keyboard.press('KeyB'); }]
    ];
    for (const [name, setup] of stages) {
      const b = await boot(browser, base);
      if (setup) await setup(b);
      await b.page.waitForTimeout(200);
      const vb = await b.page.evaluate('window.NV_BTN()');
      assert.ok(vb.btns.length >= 1, name + '：按钮存在（' + vb.btns.length + ' 颗）');
      for (const bt of vb.btns) {
        assert.ok(bt.tw >= 44 && bt.th >= 44, name + '「' + bt.l + '」touch rect ' + bt.tw + '×' + bt.th + ' ≥44（视觉 ' + bt.w + '×' + bt.h + '）');
      }
      await b.ctx.close();
    }
    // ② hash 形态页：ghost / duel / duelres
    const code = codec.bountyPack({ lv: new Array(NC).fill(0), wave: 3, score: 900, grazes: 2, chain: 0 });
    const hashPages = [
      ['ghost', '#bounty=' + code],
      ['duel', '#duel=' + codec.duelPack({ seed: 0x1234, lv: new Array(NC).fill(0), cap: 5 })],
      ['duelres', '#duelres=' + codec.duelScorePack({ seed: 7, cap: 5, lv: new Array(NC).fill(0), score: 500, wave: 2, won: false, rank: 'C' })]
    ];
    for (const [tag, hash] of hashPages) {
      const b = await boot(browser, base, { hash });
      const vb = await b.page.evaluate('window.NV_BTN()');
      assert.ok(vb.btns.length >= 2, tag + '：按钮存在');
      for (const bt of vb.btns) assert.ok(bt.tw >= 44 && bt.th >= 44, tag + '「' + bt.l + '」touch rect ' + bt.tw + '×' + bt.th + ' ≥44');
      await b.ctx.close();
    }
    // ③ 行为验证（chips 视觉 h26）：chip 下缘外 6px 点按（外扩带 my=9 内、且不与上邻 chip 外扩矩形
    // 交接——1px canvas 边框偏移会让「上缘外 2px」落入两 chip 最近边等距点，取先入表者）→ 设置页打开
    const bc = await boot(browser, base);
    const vb0 = await bc.page.evaluate('window.NV_BTN()');
    const chip = vb0.btns.find(x => x.act === 'set');
    assert.ok(chip && chip.h < 44, '设置 chip 视觉高 ' + (chip ? chip.h : '?') + ' <44（依赖外扩命中）');
    assert.ok(chip.th >= 44, 'chip touch rect ' + chip.th + ' ≥44');
    await bc.page.touchscreen.tap(Math.round(chip.x + chip.w / 2), Math.round(chip.y + chip.h + 6));
    await bc.waitStage('set');
    // ④ 模式按钮外扩（844×390 压行后 ≈39 高 <44）：下缘外 2px 点按 → 进入选人页
    await bc.page.keyboard.press('Escape');
    await bc.waitStage('mode');
    const vb1 = await bc.page.evaluate('window.NV_BTN()');
    const modeBtn = vb1.btns.find(x => x.act === 'mode:classic');
    assert.ok(modeBtn && modeBtn.h < 44, '模式钮视觉高 ' + (modeBtn ? modeBtn.h : '?') + ' <44（横屏压缩）');
    await bc.page.touchscreen.tap(Math.round(modeBtn.x + modeBtn.w / 2), Math.round(modeBtn.y + modeBtn.h + 2));
    await bc.waitStage('players');
    // ⑤ 结算按钮外扩（视觉 h32）：report 钮上缘外 5px 点按 → 战报进剪贴板
    await bc.page.keyboard.press('Enter');
    await bc.waitState('playing');
    await forceOver(bc);
    // 无头环境 rAF 节流，固定 1200ms 不保证 G.over > 0.7（按钮带解锁）→ 直接等按钮带出现
    await bc.page.waitForFunction('window.NV_BTN().btns.length > 0', null, { timeout: 10000 });
    const vb2 = await bc.page.evaluate('window.NV_BTN()');
    assert.eq(vb2.state, 'over', '结算态');
    const rep = vb2.btns.find(x => x.act === 'report');
    assert.ok(rep && rep.h < 44, '结算钮视觉高 ' + (rep ? rep.h : '?') + ' <44');
    await bc.page.touchscreen.tap(Math.round(rep.x + rep.w / 2), Math.round(rep.y - 5));
    const clip = await waitClipboard(bc.page);
    assert.ok(clip.indexOf('NEON VOID') >= 0 || clip.indexOf('虚空') >= 0, '外扩点按拿到战报（' + clip.slice(0, 40) + '…）');
    // ⑥ 升级重抽钮（160×30）外扩：重开一局 → xp 触发三选一 → 点 reroll 上缘外 → rerolls 2→1
    await bc.page.keyboard.press('KeyT');
    await bc.waitStage('mode');
    await startModeByKey(bc.page, '1');
    await bc.page.evaluate('window.NV_CHEAT.xp()');
    await bc.waitState('levelup');
    const vb3 = await bc.page.evaluate('window.NV_BTN()');
    const rr = vb3.btns.find(x => x.act === 'reroll');
    assert.ok(rr && rr.h < 44, '重抽钮视觉高 ' + (rr ? rr.h : '?') + ' <44');
    assert.ok(rr.th >= 44, '重抽钮 touch rect ' + rr.th + ' ≥44');
    await bc.page.touchscreen.tap(Math.round(rr.x + rr.w / 2), Math.round(rr.y - 5));
    await bc.page.waitForTimeout(150);
    assert.eq((await bc.snap()).rerolls, 1, '外扩点按触发重抽（rerolls 2→1）');
    await bc.ctx.close();
  });

  /* ================= [A11Y-MONKEY] 随机输入压力（3 分钟） ================= */
  s.test('monkey：3 分钟随机点击/按键/摇杆注入 — 零 pageerror · 进程存活 · 可退回标题', async () => {
    const b = await boot(browser, base);
    const SEED = 0x00C0FFEE, rng = monkeyRng(SEED);
    const W2 = VIEW.width, H2 = VIEW.height;
    const KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyP', 'KeyM', 'KeyT', 'KeyQ', 'KeyE', 'KeyX', 'KeyR', 'KeyB', 'KeyC',
      'KeyG', 'KeyV', 'KeyF', 'Enter', 'Space', 'Escape', 'ShiftLeft', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace'];
    const t0 = Date.now(), DUR = 180000; // 3 分钟随机注入
    let ops = 0, lastHealth = t0;
    while (Date.now() - t0 < DUR) {
      const r = rng();
      if (r < 0.34) { // 随机鼠标点击
        await b.page.mouse.click(Math.floor(rng() * W2), Math.floor(rng() * H2));
      } else if (r < 0.52) { // 随机触屏点按
        await b.page.touchscreen.tap(Math.floor(rng() * W2), Math.floor(rng() * H2));
      } else if (r < 0.80) { // 随机按键
        await b.page.keyboard.press(KEYS[Math.floor(rng() * KEYS.length)]);
      } else if (r < 0.94) { // 摇杆注入：触屏 pointerdown + 三段拖移 + pointerup（左半屏起手）
        const jx = Math.floor(rng() * W2 * 0.5), jy = Math.floor(40 + rng() * (H2 - 80));
        const dx2 = Math.floor((rng() - 0.5) * 120), dy2 = Math.floor((rng() - 0.5) * 120);
        await b.page.dispatchEvent('#nv-canvas', 'pointerdown',
          { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: jx, clientY: jy, bubbles: true });
        for (let m = 1; m <= 3; m++) {
          await b.page.dispatchEvent('#nv-canvas', 'pointermove',
            { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: jx + Math.round(dx2 * m / 3), clientY: jy + Math.round(dy2 * m / 3), bubbles: true });
          await b.page.waitForTimeout(25);
        }
        await b.page.dispatchEvent('#nv-canvas', 'pointerup',
          { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: jx + dx2, clientY: jy + dy2, bubbles: true });
      } else { // 鼠标移动（瞄准路径）
        await b.page.mouse.move(Math.floor(rng() * W2), Math.floor(rng() * H2));
      }
      ops++;
      if (Date.now() - lastHealth > 15000) { // 每 15s 心跳：页面进程存活（NV_SNAP 可响应）
        await b.snap();
        lastHealth = Date.now();
      }
    }
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    // 断言一：零 pageerror
    assert.deep(b.errors, [], '3 分钟注入（' + ops + ' ops / ' + dur + 's, seed=' + SEED + '）零未捕获异常');
    // 断言二：进程存活（主循环仍在出帧、快照可取）
    const sn = await b.snap();
    assert.ok(sn && typeof sn.state === 'string', '进程存活：NV_SNAP 返回 state=' + sn.state);
    // 断言三：可正常退回标题（真实键盘路径，见 backToTitle）
    const fin = await backToTitle(b);
    assert.eq(fin.state, 'title', '退回标题态');
    assert.eq(fin.tStage, 'mode', '退回模式选择页');
    assert.deep(b.errors, [], '退回过程亦零异常');
    await b.shot('monkey-final-title');
    await b.ctx.close();
  });

  const r = await s.run();
  await browser.close();
  srv.close();
  console.log('截图/工件目录: ' + SHOTS);
  process.exit(r.fails.length ? 1 : 0);
})().catch(e => { console.error('E2E 框架级失败:', e); process.exit(1); });
