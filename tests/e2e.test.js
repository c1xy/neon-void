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
        // --enable-precise-memory-info：performance.memory.usedJSHeapSize 精确到字节（缺省分桶近似，
        // 性能基线的 heap 断言需要真值）
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
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
  s.test('每日挑战同日确定性：两次开局 seed / 词条 / 波次构成一致', async () => {
    const run = async () => {
      const b = await boot(browser, base);
      await startModeByKey(b.page, '5'); // 每日挑战
      // 快照与「观察到 playing」同一页帧完成（evaluate 内 rAF 轮询取样）。旧版固定睡 400ms 再取：
      // 负载下页面往返把取样推过首个出兵延迟（~1.15s）→ 出兵消耗 rnd() → RSTATE 状态快照漂移
      // → 偶发翻车（run-all 连跑时实发过一次）。startGame 同步跑完 startWave(1) 才置 playing，
      // 队列/词条在 playing 首帧前已就绪，立即取样即确定性。
      const sn = await b.page.evaluate(() => new Promise(res => {
        const tick = () => {
          const s = window.NV_SNAP();
          if (s && s.state === 'playing') res(s); else requestAnimationFrame(tick);
        };
        tick();
      }));
      await b.ctx.close();
      return { seed: sn.seed, muts: sn.muts.slice(), comp: composition(sn), wave: sn.wave };
    };
    const r1 = await run();
    const r2 = await run();
    assert.eq(r1.wave, 1, '两次都停在第 1 波');
    assert.deep(r1.muts, r2.muts, '全员同词条（startGame 同步抽取，无帧竞态）');
    assert.deep(r1.comp, r2.comp, '波次 1 构成（未出生队列+在场敌人）一致');
    assert.eq(r1.seed, r2.seed, 'RSTATE 播种后状态一致（同日同卷）');
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
    await b.page.mouse.click(95, 211);  // 卡 0 火力强化（dcard:0 → Lv1；[FIX-DUEL1] 网格顶 +26 → y 197..224）
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

  /* ================= [FIX-CFG2]/[FIX-GEOM1] 设置页实机（渲染标签 = 实际行为） ================= */
  s.test('设置页实机：scan/shake 开关语义往返 + 高亮像素落在「开」+ 行盒不交叠', async () => {
    const b = await boot(browser, base);
    await b.page.mouse.click(773, 89); // ⚙ 设置 chip（W-130..W-12, y 76..102）
    await b.waitStage('set');
    await b.page.mouse.move(10, 10);
    await b.page.waitForTimeout(250);
    const sg = (await b.snap()).sgeom;
    assert.ok(sg && sg.compact, '844×390 命中 compact 几何');
    assert.ok(sg.pitch >= sg.h, '行盒不交叠（pitch ' + sg.pitch + ' ≥ 行高 ' + sg.h + '，[FIX-GEOM1] 旧版 18<20）');
    // CFGS 行序（unit 侧已钉住数组本体）：0 mute / 5 shake / 6 scan；选项按钮 x 固定 W/2+10+oi*68, w62
    const btnStat = (x0, x1, yT, h) => b.page.evaluate(([a, c, d, w]) => {
      const img = document.getElementById('nv-canvas').getContext('2d').getImageData(a, c, w, d).data;
      let maxRB = -999;
      for (let j = 0; j < img.length; j += 4) maxRB = Math.max(maxRB, img[j] - img[j + 2]);
      return maxRB; // 高亮 #ffc233 → R-B=204；未选 #5a7090 → R-B≈-54
    }, [x0, yT, h, x1 - x0]);
    const rowY = i => [Math.round(sg.y0 + i * sg.pitch), sg.h];
    const oi0 = 432, oi1 = 500, w = 62;
    const readRow = async i => {
      const [yT, h] = rowY(i);
      return { a: await btnStat(oi0, oi0 + w, yT, h), b: await btnStat(oi1, oi1 + w, yT, h) };
    };
    const cls = rb => rb > 100 ? 'Y' : 'g';
    // 缺键回填：shake/scan=1 → 高亮必须落在 oi1（「开」）；mute=0 → 高亮在 oi0（「开」=不静音，键语义反相恰好正确）
    let st = await readRow(5);
    assert.eq(cls(st.a) + cls(st.b), 'gY', 'shake 默认值 1 → 「开」高亮（渲染标签=布尔闸门）');
    st = await readRow(6);
    assert.eq(cls(st.a) + cls(st.b), 'gY', 'scan 默认值 1 → 「开」高亮');
    st = await readRow(0);
    assert.eq(cls(st.a) + cls(st.b), 'Yg', 'mute 默认值 0 → 「开」高亮（声音开，反相语义保持不动）');
    // 点击往返：点「开」→ CFG 落 1 且扫描线 DOM 生效；点「关」→ 0 且隐藏
    const scanY = rowY(6)[0] + Math.floor(sg.h / 2);
    const cfgRead = () => b.page.evaluate('JSON.parse(localStorage.getItem("neonvoid_cfg")||"{}")');
    const scanDisp = () => b.page.evaluate('getComputedStyle(document.querySelector(".nv-scan")).display');
    await b.page.mouse.click(oi1 + w / 2, scanY); await b.page.mouse.move(10, 10); await b.page.waitForTimeout(150);
    assert.eq((await cfgRead()).scan, 1, '点「开」→ CFG.scan=1');
    assert.ok(await scanDisp() !== 'none', 'CFG.scan=1 → 扫描线显示（真值闸门生效）');
    st = await readRow(6);
    assert.eq(cls(st.a) + cls(st.b), 'gY', 'scan=1 渲染高亮在「开」');
    await b.page.mouse.click(oi0 + w / 2, scanY); await b.page.mouse.move(10, 10); await b.page.waitForTimeout(150);
    assert.eq((await cfgRead()).scan, 0, '点「关」→ CFG.scan=0');
    assert.eq(await scanDisp(), 'none', 'CFG.scan=0 → 扫描线隐藏');
    // shake 行同样往返（值落盘即契约；渲染侧乘数消费点由 unit 静态断言钉住）
    const shakeY = rowY(5)[0] + Math.floor(sg.h / 2);
    await b.page.mouse.click(oi0 + w / 2, shakeY); await b.page.mouse.move(10, 10); await b.page.waitForTimeout(150);
    assert.eq((await cfgRead()).shake, 0, 'shake 点「关」→ 0');
    await b.page.mouse.click(oi1 + w / 2, shakeY); await b.page.mouse.move(10, 10); await b.page.waitForTimeout(150);
    assert.eq((await cfgRead()).shake, 1, 'shake 点「开」→ 1');
    assert.deep(b.errors, [], '无未捕获异常');
    await b.shot('set-rows-844x390');
    await b.ctx.close();
  });

  /* ================= [FIX-DUEL1] 对决构建页实机（波次上限标签呼吸间距 ≥10px） ================= */
  s.test('对决构建页实机：档位按钮带 →「波次上限」标签 → 初始构筑标题，亮像素剖面三段分离', async () => {
    const b = await boot(browser, base);
    await b.page.mouse.click(647, 64); // ⚔ 种子对决 chip
    await b.waitStage('duel');
    await b.page.waitForTimeout(250);
    // x 340..505 覆盖 10 波/15 波按钮与居中标签；y 124..235 覆盖按钮带/标签/构筑标题/卡首行
    const rows = await b.page.evaluate(() => {
      const img = document.getElementById('nv-canvas').getContext('2d').getImageData(340, 124, 165, 111).data;
      const out = [];
      for (let y = 0; y < 111; y++) {
        let m = 0;
        for (let x = 0; x < 165; x++) {
          const i = (y * 165 + x) * 4;
          m = Math.max(m, img[i] + img[i + 1] + img[i + 2]);
        }
        out.push({ y: 124 + y, on: m > 260 });
      }
      return out;
    });
    const runs = [];
    for (const r of rows) {
      if (r.on && (!runs.length || runs[runs.length - 1].end < r.y - 1)) runs.push({ start: r.y, end: r.y });
      else if (r.on) runs[runs.length - 1].end = r.y;
    }
    const s = JSON.stringify(runs);
    assert.ok(runs.length >= 3, '至少三段亮带（档位按钮/波次上限标签/构筑标题）实测 ' + s);
    assert.ok(runs[0].end <= 152, '首段=档位按钮带（底 ≤ H*0.055+130=151.5）实测 ' + s);
    const gap1 = runs[1].start - runs[0].end - 1;
    assert.ok(gap1 >= 10, '档位按钮→「波次上限」标签暗隙 ≥10px（[FIX-DUEL1]，旧版 ~2px）实测 ' + gap1 + 'px ' + s);
    const gap2 = runs[2].start - runs[1].end - 1;
    assert.ok(gap2 >= 4, '标签→「初始构筑」标题暗隙 ≥4px（旧版两行整段叠印）实测 ' + gap2 + 'px ' + s);
    assert.deep(b.errors, [], '无未捕获异常');
    await b.shot('duel-band-844x390');
    await b.ctx.close();
  });

  /* ================= 性能基线（采样写入测试输出：控制台表 + perf-baseline.json） ================= */
  const PERF = { env: { node: process.version, viewport: '844x390', dpr: 1, date: new Date().toISOString() }, boot: [], heap: null, swOfflineMs: null };
  s.test('性能基线：10 形态逐一 boot ≤2s（导航起 → 形态就绪，逐形态采样）', async () => {
    // 7 模式（键盘 → 对局就绪）+ 残影/构建器/种子对决三个入口页 + 对决结果页——与 boot 回归同一形态集
    const FORMS = [
      ['classic', 'mode', '1', null], ['endless', 'mode', '2', null], ['boss', 'mode', '3', null],
      ['chaos', 'mode', '4', null], ['daily', 'mode', '5', null], ['versus', 'mode', '6', null], ['graze', 'mode', '7', null],
      ['ghost', 'stage:ghost', null, { hash: '#bounty=' + codec.bountyPack({ lv: new Array(NC).fill(0), wave: 3, score: 100, grazes: 0, chain: 0 }) }],
      ['brb', 'stage:brb', 'b', { ls: { neonvoid_rush: JSON.stringify({ order: [0], tier: 0 }) } }],
      ['duel', 'stage:duel', null, { chip: true }],
      ['duelres', 'stage:duelres', null, { hash: '#duelres=' + codec.duelScorePack({ seed: 1, cap: 10, lv: new Array(NC).fill(0), score: 100, wave: 1, won: false, rank: 'D' }) }]
    ];
    for (const [name, kind, key, opts] of FORMS) {
      const t0 = Date.now();
      const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, hasTouch: true });
      if (opts && opts.ls) for (const [k, v] of Object.entries(opts.ls)) {
        await ctx.addInitScript(([k2, v2]) => { try { localStorage.setItem(k2, v2); } catch (e) {} }, [k, v]);
      }
      const page = await ctx.newPage();
      await page.goto(base + '/index.html' + (opts && opts.hash || ''), { waitUntil: 'load' });
      await page.waitForFunction('typeof window.NV_SNAP === "function"', null, { timeout: 20000 });
      const msSnap = Date.now() - t0;
      if (kind === 'mode') { // 模式形态：数字 → 单人 → 对局就绪
        await page.keyboard.press(key);
        await page.waitForFunction('window.NV_SNAP().tStage === "players"', null, { timeout: 8000 });
        await page.keyboard.press('1');
        await page.waitForFunction('window.NV_SNAP().state === "playing"', null, { timeout: 8000 });
      } else if (kind === 'stage:brb') {
        await page.keyboard.press(key);
        await page.waitForFunction('window.NV_SNAP().tStage === "brb"', null, { timeout: 8000 });
      } else if (kind === 'stage:duel') {
        await page.mouse.click(647, 64);
        await page.waitForFunction('window.NV_SNAP().tStage === "duel"', null, { timeout: 8000 });
      } else { // stage:ghost / stage:duelres —— hash 直达，就绪即形态
        await page.waitForFunction('window.NV_SNAP().tStage === "' + kind.slice(6) + '"', null, { timeout: 8000 });
      }
      const ms = Date.now() - t0;
      PERF.boot.push({ form: name, ready: kind === 'mode' ? 'playing' : kind.slice(6), snapMs: msSnap, bootMs: ms });
      console.log('  · boot ' + name.padEnd(8) + ' ' + msSnap + 'ms(snap) / ' + ms + 'ms(ready)');
      assert.ok(ms <= 2000, name + ' boot ' + ms + 'ms ≤ 2000ms');
      await ctx.close();
    }
  });
  s.test('性能基线：对局 30s JS heap 增长 ≤5MB（classic 实机 + CDP 强制 GC 双端采样）', async () => {
    const b = await boot(browser, base);
    await startModeByKey(b.page, '1');
    const client = await b.ctx.newCDPSession(b.page);
    await client.send('HeapProfiler.enable');
    const gcRead = async () => {
      await client.send('HeapProfiler.collectGarbage');
      await client.send('HeapProfiler.collectGarbage');
      await b.page.waitForTimeout(120);
      return b.page.evaluate('performance.memory.usedJSHeapSize');
    };
    const h0 = await gcRead();
    const samples = [{ t: 0, mb: +(h0 / 1048576).toFixed(2) }];
    for (let i = 1; i <= 6; i++) { // 30s 自然对局（出兵/受击/死亡→结算均为正常流），每 5s 采样
      await b.page.waitForTimeout(5000);
      samples.push({ t: i * 5, mb: +((await b.page.evaluate('performance.memory.usedJSHeapSize')) / 1048576).toFixed(2) });
    }
    const h1 = await gcRead();
    const growthMB = +((h1 - h0) / 1048576).toFixed(2);
    PERF.heap = { startMB: samples[0].mb, endGCMB: +(h1 / 1048576).toFixed(2), growthMB, samples };
    console.log('  · heap 30s：' + samples[0].mb + 'MB → ' + (h1 / 1048576).toFixed(2) + 'MB（GC 后），增长 ' + growthMB + 'MB');
    assert.ok(growthMB <= 5, '30s heap 增长 ' + growthMB + 'MB ≤ 5MB');
    await b.ctx.close();
  });
  s.test('性能基线：SW 离线启动 ≤3s（先在线装 SW → 断网重载 → NV_SNAP 就绪）', async () => {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('typeof window.NV_SNAP === "function"', null, { timeout: 20000 });
    await page.waitForFunction('navigator.serviceWorker.controller !== null', null, { timeout: 15000 }); // install+claim 完成
    await ctx.setOffline(true);
    const t1 = Date.now();
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('typeof window.NV_SNAP === "function"', null, { timeout: 10000 });
    const ms = Date.now() - t1;
    const sn = await page.evaluate('window.NV_SNAP()');
    PERF.swOfflineMs = ms;
    console.log('  · SW 离线启动 ' + ms + 'ms（state=' + sn.state + '）');
    assert.ok(ms <= 3000, '离线启动 ' + ms + 'ms ≤ 3000ms');
    assert.ok(sn && sn.state, '离线启动后页面可交互（NV_SNAP 可读）');
    await ctx.close();
  });

  const r = await s.run();
  // 性能基线落盘：测试工件目录（NV_E2E_SHOTS）+ 控制台汇总，供后续轮次对比回归
  try {
    fs.writeFileSync(path.join(SHOTS, 'perf-baseline.json'), JSON.stringify(PERF, null, 1));
    console.log('性能基线 → ' + path.join(SHOTS, 'perf-baseline.json'));
  } catch (e) { console.log('性能基线落盘失败（不影响判定）: ' + e.message); }
  await browser.close();
  srv.close();
  console.log('截图/工件目录: ' + SHOTS);
  process.exit(r.fails.length ? 1 : 0);
})().catch(e => { console.error('E2E 框架级失败:', e); process.exit(1); });
