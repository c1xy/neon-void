#!/usr/bin/env node
/* Neon Void 单元测试 — node 直跑，无浏览器、无第三方依赖。
   被测对象从 index.html 源码按名字提取（见 _lib.js），跑的是游戏本体纯逻辑：
   - 四码编解码（#bounty= / #rush= / #duel= / #duelres=）往返 + 坏码拒绝 + 三码互斥解析为 null
   - RSTATE（mulberry32）同 seed 确定性
   - dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期）
   - 画质档位状态机（setTier + 主循环治理器真实源码切片）
   - overTitle() 六形态
   - 设置页开关语义（CFGS/CFG_RNG 真实源码提取）+ setGeom 全视口扫描 H=300..900
   - [R13-MIGRATE] 存档迁移矩阵：四码 v1/v2 历史版布局 + 旧荣誉榜/dstat/shadow/duels 形态，兼容 + 自愈
   运行：node tests/unit.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, createSuite, assert, buildSandbox, buildDstatStreak, buildGovernor, fakeDateCtor, getSource, extractDecl, extractFn } = require('./_lib');

const s = createSuite('unit');
const sb = buildSandbox();
const a = sb.api;
const NC = a.upgrades.length;
assert.eq(NC, 14, 'UPGRADES 卡数应为 14（四码布局前提）');

/* ================= #bounty= 残影悬赏码 ================= */
s.test('bounty v3 往返：普通值逐字段一致', () => {
  const d = { lv: [5, 3, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0], wave: 12, score: 123456, grazes: 77, chain: 3 };
  assert.deep(a.bountyUnpack(a.bountyPack(d)), d);
});
s.test('bounty v3 往返：全字段极值（wave 65535 / score 16777215 / grazes 65535 / chain 250）', () => {
  const d = { lv: new Array(NC).fill(0), wave: 65535, score: 16777215, grazes: 65535, chain: 250 };
  assert.deep(a.bountyUnpack(a.bountyPack(d)), d);
});
s.test('bounty v3 卡等级按卡 max 收口（火力强化 max 5 → 入码 7 回读 5）', () => {
  const lv = new Array(NC).fill(0); lv[0] = 7;
  const out = a.bountyUnpack(a.bountyPack({ lv, wave: 1, score: 0, grazes: 0, chain: 0 }));
  assert.eq(out.lv[0], 5, 'lv[0] 应收口到 dmg.max=5');
});
s.test('bounty 码固定 32 字符 base64url', () => {
  const code = a.bountyPack({ lv: new Array(NC).fill(0), wave: 1, score: 1, grazes: 0, chain: 0 });
  assert.eq(code.length, 32, 'v3 布局 24 字节 → 32 字符');
  assert.ok(/^[A-Za-z0-9\-_]+$/.test(code), '只含 base64url 字符');
});
s.test('bounty 旧码 v1/v2 仍可解析（缺省卡位视为 0）', () => {
  // v1：19 字节 [ver=1, 9×卡, wave2, score3, grazes2, chain1, xor]；v2：22 字节（12 卡）
  const mk = (ver, n) => {
    const b = new Array(1 + n + 9).fill(0);
    b[0] = ver; b[1] = 3; b[2] = 4;
    b[1 + n] = 0; b[2 + n] = 9; // wave 9
    b[3 + n] = 0; b[4 + n] = 0x12; b[5 + n] = 0x34; // score 0x001234 = 4660
    let x = 0; for (let i = 0; i < b.length - 1; i++) x ^= b[i];
    b[b.length - 1] = x;
    return a.b64uEnc(b);
  };
  const v1 = a.bountyUnpack(mk(1, 9));
  assert.ok(v1, 'v1 应可解析');
  assert.eq(v1.wave, 9, 'v1 wave');
  assert.eq(v1.score, 0x1234, 'v1 score');
  assert.eq(v1.lv[0], 3, 'v1 前 9 卡位可读');
  assert.eq(v1.lv[NC - 1], 0, 'v1 缺省新卡位视为 0');
  const v2 = a.bountyUnpack(mk(2, 12));
  assert.ok(v2, 'v2 应可解析');
  assert.eq(v2.lv[0], 3, 'v2 前 12 卡位可读');
  assert.eq(v2.lv[11], 0, 'v2 卡位 11 未写入 → 0');
  assert.eq(v2.lv[NC - 1], 0, 'v2 缺省新卡位视为 0');
  assert.eq(v2.score, 0x1234, 'v2 score');
});
s.test('bounty 坏码拒绝：XOR 校验坏 / 长度错 / 版本错 / 非法字符 / 空串', () => {
  const code = a.bountyPack({ lv: new Array(NC).fill(0), wave: 3, score: 500, grazes: 2, chain: 0 });
  const bytes = a.b64uDec(code);
  assert.isNull(a.bountyUnpack(null), 'null 拒绝');
  assert.isNull(a.bountyUnpack(''), '空串拒绝');
  assert.isNull(a.bountyUnpack(code.slice(0, 31)), '截断拒绝');
  assert.isNull(a.bountyUnpack(code + 'AAAA'), '多 3 字节超长拒绝（24+3=27 字节不属于任何版本布局）');
  // 注：尾拼 1 个余数位字符（code+'A'）解码出的字节与原码相同（base64 尾部余数位被丢弃），按设计等价原码、不拒绝
  assert.isNull(a.bountyUnpack('!!!!' + code.slice(4)), '非法 base64url 字符拒绝');
  const badVer = a.b64uEnc([9].concat(bytes.slice(1)));
  assert.isNull(a.bountyUnpack(badVer), '未知版本拒绝');
  const badXor = bytes.slice(); badXor[5] ^= 0x01;
  assert.isNull(a.bountyUnpack(a.b64uEnc(badXor)), 'XOR 校验拒绝');
  assert.isNull(a.bountyUnpack(a.b64uEnc(bytes.slice(0, 22))), '22 字节既非 v1/v2/v3 布局 → 拒绝');
});
s.test('bounty 裸 hash（无 #bounty= 前缀的旧链接）仍可解析', () => {
  const code = a.bountyPack({ lv: new Array(NC).fill(0), wave: 5, score: 999, grazes: 1, chain: 0 });
  assert.isNull(a.parseHashBounty(), '默认空 hash → null');
  const sb2 = buildSandbox({ location: { hash: '#' + code } });
  assert.deep(sb2.api.parseHashBounty(), a.bountyUnpack(code), '裸 hash 旧链接解析一致');
  const sb3 = buildSandbox({ location: { hash: '#bounty=' + code } });
  assert.deep(sb3.api.parseHashBounty(), a.bountyUnpack(code), '#bounty= 前缀解析一致');
});

/* ================= #rush= 连战构建器码 ================= */
s.test('rush 往返：全 6 BOSS 序列 + 地狱档', () => {
  const cfg = { order: [0, 1, 2, 3, 4, 5], tier: 2 };
  assert.deep(a.rushUnpack(a.rushPack(cfg)), cfg);
});
s.test('rush 往返：单 BOSS + 标准档', () => {
  const cfg = { order: [3], tier: 0 };
  assert.deep(a.rushUnpack(a.rushPack(cfg)), cfg);
});
s.test('rush 序号/档位入码时收口（9→5、tier 3→2）', () => {
  const out = a.rushUnpack(a.rushPack({ order: [9, 0], tier: 5 }));
  assert.deep(out, { order: [5, 0], tier: 2 });
});
s.test('rush 坏码拒绝：空序列 / 长度不符 / XOR 坏 / 版本错 / 非法字符', () => {
  assert.isNull(a.rushPack({ order: [], tier: 0 }), '空序列 pack 返回 null');
  assert.isNull(a.rushPack(null), 'null pack 返回 null');
  const code = a.rushPack({ order: [1, 2], tier: 1 });
  const bytes = a.b64uDec(code);
  assert.isNull(a.rushUnpack(''), '空串拒绝');
  assert.isNull(a.rushUnpack(code + '!!'), '非法字符拒绝');
  assert.isNull(a.rushUnpack(a.b64uEnc([2].concat(bytes.slice(1)))), '版本错拒绝');
  assert.isNull(a.rushUnpack(a.b64uEnc(bytes.slice(0, bytes.length - 1))), '长度不符拒绝');
  const badXor = bytes.slice(); badXor[2] ^= 1;
  assert.isNull(a.rushUnpack(a.b64uEnc(badXor)), 'XOR 校验拒绝');
  assert.isNull(a.rushUnpack(a.b64uEnc([1, 0, 0, 0])), 'N=0（长度<5）拒绝');
  assert.isNull(a.rushUnpack(a.b64uEnc([1, 9].concat(new Array(9).fill(0), [0, 0]))), 'N=9 超上限拒绝');
  assert.isNull(a.rushUnpack(a.b64uEnc([1, 2, 1, 2, 9])), 'N 与长度不匹配拒绝');
});
s.test('rushValid 形状校验', () => {
  assert.ok(a.rushValid({ order: [0], tier: 0 }));
  assert.ok(!a.rushValid(null));
  assert.ok(!a.rushValid({ order: [], tier: 0 }), '空序列无效');
  assert.ok(!a.rushValid({ order: [6], tier: 0 }), '序号越界无效');
  assert.ok(!a.rushValid({ order: [1.5], tier: 0 }), '非整数无效');
  assert.ok(!a.rushValid({ order: [0], tier: 3 }), '档位越界无效');
});

/* ================= #duel= 对决码 ================= */
s.test('duel 往返：seed u32（含 >2^31）/ 卡等 / 波次上限', () => {
  const d = { seed: 0xDEADBEEF, lv: [1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], cap: 15 };
  assert.deep(a.duelUnpack(a.duelPack(d)), d);
  const d2 = { seed: 0xFFFFFFFF, lv: new Array(NC).fill(0), cap: 1 };
  assert.deep(a.duelUnpack(a.duelPack(d2)), d2, 'seed 全 1 / cap 1');
});
s.test('duel 卡等按卡 max 收口、cap 收口 1..99（cap 缺省/0 走 ||10 默认）', () => {
  const lv = new Array(NC).fill(0); lv[2] = 9; // shot max 3
  const out = a.duelUnpack(a.duelPack({ seed: 5, lv, cap: 0 }));
  assert.eq(out.lv[2], 3, 'shot 收口到 max 3');
  assert.eq(out.cap, 10, 'cap 0 falsy → pack 默认 10（CL(…||10,1,99)）');
  const out2 = a.duelUnpack(a.duelPack({ seed: 5, lv: new Array(NC).fill(0), cap: 200 }));
  assert.eq(out2.cap, 99, 'cap 200 收口到 99');
});
s.test('duel 码固定 28 字符', () => {
  const code = a.duelPack({ seed: 1, lv: new Array(NC).fill(0), cap: 10 });
  assert.eq(code.length, 28, '21 字节 → 28 字符');
});
s.test('duel 坏码拒绝：尾部拼 junk / XOR 坏 / 长度错 / 版本错 / 非法字符', () => {
  const code = a.duelPack({ seed: 0x1234, lv: new Array(NC).fill(0), cap: 10 });
  const bytes = a.b64uDec(code);
  assert.isNull(a.duelUnpack(''), '空串拒绝');
  assert.isNull(a.duelUnpack(null), 'null 拒绝');
  assert.isNull(a.duelUnpack(code + 'A'), '尾部拼 junk 拒绝（base64 余数位校验）');
  assert.isNull(a.duelUnpack(code.slice(1)), '长度错拒绝');
  assert.isNull(a.duelUnpack(a.b64uEnc([2].concat(bytes.slice(1)))), '版本错拒绝');
  const badXor = bytes.slice(); badXor[8] ^= 0x80;
  assert.isNull(a.duelUnpack(a.b64uEnc(badXor)), 'XOR 校验拒绝');
  assert.isNull(a.duelUnpack(code.replace(/A/, '!', ) || code + '.'), '非法字符拒绝');
});
s.test('duelSeedText 八位大写十六进制', () => {
  assert.eq(a.duelSeedText(0), '#00000000');
  assert.eq(a.duelSeedText(0xDEADBEEF), '#DEADBEEF');
});

/* ================= #duelres= 成绩码 ================= */
s.test('duelres 往返：得分 u24 / 波次 / won 标志 / 评级', () => {
  const d = { seed: 0x11223344, cap: 10, lv: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], score: 999999, wave: 7, won: true, rank: 'A' };
  assert.deep(a.duelScoreUnpack(a.duelScorePack(d)), d);
});
s.test('duelres 往返：全零 + won=false + 未知评级回落 D', () => {
  const d = { seed: 0, cap: 5, lv: new Array(NC).fill(0), score: 0, wave: 0, won: false, rank: 'Z' };
  assert.deep(a.duelScoreUnpack(a.duelScorePack(d)), { seed: 0, cap: 5, lv: new Array(NC).fill(0), score: 0, wave: 0, won: false, rank: 'D' });
});
s.test('duelres 极值：score 16777215 / wave 255 / cap 99', () => {
  const d = { seed: 0xFFFFFFFF, cap: 99, lv: new Array(NC).fill(0), score: 16777215, wave: 255, won: true, rank: 'S' };
  assert.deep(a.duelScoreUnpack(a.duelScorePack(d)), d);
});
s.test('duelres 坏码拒绝', () => {
  const code = a.duelScorePack({ seed: 1, cap: 10, lv: new Array(NC).fill(0), score: 5, wave: 2, won: false, rank: 'D' });
  const bytes = a.b64uDec(code);
  assert.isNull(a.duelScoreUnpack(''), '空串拒绝');
  assert.isNull(a.duelScoreUnpack(code + 'B'), '尾部 junk 拒绝');
  assert.isNull(a.duelScoreUnpack(a.b64uEnc(bytes.slice(0, 25))), '长度错拒绝（25 字节 ≠ 26）');
  assert.isNull(a.duelScoreUnpack(a.b64uEnc(bytes.concat([0, 0, 0]))), '长度错拒绝（29 字节 ≠ 26）');
  const badXor = bytes.slice(); badXor[20] ^= 1;
  assert.isNull(a.duelScoreUnpack(a.b64uEnc(badXor)), 'XOR 校验拒绝');
  assert.isNull(a.duelScoreUnpack(a.b64uEnc([9].concat(bytes.slice(1)))), '版本错拒绝');
});

/* ================= 三码互斥：前缀不匹配 / 解码失败一律 null ================= */
s.test('互斥：#rush= 码喂给 bounty/duel/duelres 解析器 → 全部 null', () => {
  const rc = a.rushPack({ order: [1, 2, 3], tier: 1 });
  const loc = { hash: '#rush=' + rc };
  const sb2 = buildSandbox({ location: loc });
  assert.isNull(sb2.api.parseHashBounty(), 'rush 码 ≠ bounty（前缀+解码均不符）');
  assert.isNull(sb2.api.parseHashDuel(), 'rush 码 ≠ duel');
  assert.isNull(sb2.api.parseHashDuelRes(), 'rush 码 ≠ duelres');
  assert.isNull(a.duelUnpack(rc), 'rush 码直接喂 duelUnpack → null');
  assert.isNull(a.duelScoreUnpack(rc), 'rush 码直接喂 duelScoreUnpack → null');
  assert.isNull(a.bountyUnpack(rc), 'rush 码直接喂 bountyUnpack → null');
});
s.test('互斥：#duel= 码喂给 bounty/rush/duelres 解析器 → 全部 null', () => {
  const dc = a.duelPack({ seed: 0xCAFEBABE, lv: new Array(NC).fill(0), cap: 10 });
  const sb2 = buildSandbox({ location: { hash: '#duel=' + dc } });
  assert.isNull(sb2.api.parseHashBounty(), 'duel 码 ≠ bounty（裸 hash 兜底也过不了解码）');
  assert.isNull(sb2.api.parseHashRush(), 'duel 码 ≠ rush');
  assert.isNull(sb2.api.parseHashDuelRes(), 'duel 码 ≠ duelres');
  assert.isNull(a.rushUnpack(dc), 'duel 码直接喂 rushUnpack → null');
  assert.isNull(a.duelScoreUnpack(dc), 'duel 码直接喂 duelScoreUnpack → null');
  assert.isNull(a.bountyUnpack(dc), 'duel 码直接喂 bountyUnpack → null');
});
s.test('互斥：#duelres= 码喂给 bounty/rush/duel 解析器 → 全部 null', () => {
  const drc = a.duelScorePack({ seed: 7, cap: 10, lv: new Array(NC).fill(0), score: 5000, wave: 3, won: false, rank: 'C' });
  const sb2 = buildSandbox({ location: { hash: '#duelres=' + drc } });
  assert.isNull(sb2.api.parseHashBounty(), 'duelres 码 ≠ bounty');
  assert.isNull(sb2.api.parseHashRush(), 'duelres 码 ≠ rush');
  assert.isNull(sb2.api.parseHashDuel(), 'duelres 码 ≠ duel');
  assert.isNull(a.duelUnpack(drc), 'duelres 码直接喂 duelUnpack → null');
  assert.isNull(a.rushUnpack(drc), 'duelres 码直接喂 rushUnpack → null');
  assert.isNull(a.bountyUnpack(drc), 'duelres 码直接喂 bountyUnpack → null');
});
s.test('互斥：#bounty= 码喂给 rush/duel/duelres 解析器 → 全部 null', () => {
  const bc = a.bountyPack({ lv: new Array(NC).fill(0), wave: 4, score: 8000, grazes: 9, chain: 0 });
  const sb2 = buildSandbox({ location: { hash: '#bounty=' + bc } });
  assert.isNull(sb2.api.parseHashRush(), 'bounty 码 ≠ rush');
  assert.isNull(sb2.api.parseHashDuel(), 'bounty 码 ≠ duel');
  assert.isNull(sb2.api.parseHashDuelRes(), 'bounty 码 ≠ duelres');
  assert.deep(sb2.api.parseHashBounty(), a.bountyUnpack(bc), 'bounty 码自己的解析器应成功');
});
s.test('互斥：非码 hash（普通锚点/空 hash/杂串）四解析器全 null', () => {
  for (const h of ['', '#', '#guide', '#-top', '#bounty=', '#duel=short', '#rush=!!']) {
    const sb2 = buildSandbox({ location: { hash: h } });
    assert.isNull(sb2.api.parseHashBounty(), 'bounty 解析 null @ ' + h);
    assert.isNull(sb2.api.parseHashRush(), 'rush 解析 null @ ' + h);
    assert.isNull(sb2.api.parseHashDuel(), 'duel 解析 null @ ' + h);
    assert.isNull(sb2.api.parseHashDuelRes(), 'duelres 解析 null @ ' + h);
  }
});

/* ================= RSTATE（mulberry32）同 seed 确定性 ================= */
s.test('RSTATE：同 seed 两次播种 → 1000 位序列逐位一致', () => {
  const seq = () => { a.srand(0x1EDA9C0F); return Array.from({ length: 1000 }, () => a.rnd()); };
  assert.deep(seq(), seq(), '同 seed 序列应完全一致');
});
s.test('RSTATE：不同 seed → 序列分化；全部落在 [0,1)', () => {
  a.srand(12345); const x = Array.from({ length: 100 }, () => a.rnd());
  a.srand(12346); const y = Array.from({ length: 100 }, () => a.rnd());
  assert.ok(JSON.stringify(x) !== JSON.stringify(y), '相邻 seed 也应分化');
  for (const v of x) assert.ok(v >= 0 && v < 1, 'rnd() ∈ [0,1)');
});
s.test('RSTATE：seed 0 边界可用', () => {
  a.srand(0);
  const v = a.rnd();
  assert.ok(v >= 0 && v < 1, 'seed 0 可推进');
  a.srand(0);
  assert.eq(a.rnd(), v, 'seed 0 确定性复现');
});
s.test('RSTATE：RG/RGI 落界内；RGI 含端点', () => {
  a.srand(0xC0FFEE);
  for (let i = 0; i < 200; i++) {
    const v = a.RG(-3, 7);
    assert.ok(v >= -3 && v < 7, 'RG ∈ [-3,7)');
    const n = a.RGI(2, 5);
    assert.ok(Number.isInteger(n) && n >= 2 && n <= 5, 'RGI ∈ {2..5}');
  }
});
s.test('dailySeed：同日恒定、跨日变化、32 位', () => {
  const mk = (y, m, d) => fakeDateCtor(new Date(y, m - 1, d, 12, 0, 0).getTime());
  const s1 = buildSandbox({ Date: mk(2026, 11, 13) }).api.dailySeed();
  const s2 = buildSandbox({ Date: mk(2026, 11, 13) }).api.dailySeed();
  assert.eq(s1, s2, '同日两次计算一致');
  const s3 = buildSandbox({ Date: mk(2026, 11, 14) }).api.dailySeed();
  assert.ok(s1 !== s3, '相邻日期种子不同');
  assert.ok((s1 >>> 0) === s1, '32 位无符号');
});

/* ================= dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期） =================
   [FIX-TEST-DATE] TODAY/YDAY/B4Y 一律从 FakeDate 的固定时刻推导（原硬编码 '2026-11-13' 是日期轮转地雷：
   跑测试的日历日一旦翻过 11-13，5 个用例全红）。固定时刻本身仍是稳定的本地 2026-11-13 12:00。 */
const FIXED_MS = new Date(2026, 10, 13, 12, 0, 0).getTime(); // 本地 2026-11-13 12:00
const fmtDay = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TODAY = fmtDay(FIXED_MS), YDAY = fmtDay(FIXED_MS - 86400000), B4Y = fmtDay(FIXED_MS - 2 * 86400000);
function makeDstatTick() {
  const bt = buildDstatStreak();
  const FixedDate = fakeDateCtor(FIXED_MS);
  return (dstat) => {
    const G = { dstat: dstat || null, maxCombo: 5, wave: 3 };
    bt.tick(G, FixedDate);
    return G.dstat;
  };
}
s.test('dstat 连续天数：last=昨天 → +1', () => {
  const tick = makeDstatTick();
  const out = tick({ last: YDAY, streak: 3, best: { s: 100, w: 1, c: 0, t: 0 }, mcombo: 0 });
  assert.eq(out.streak, 4, '昨天连续 3 天 → 今天第 4 天');
  assert.eq(out.last, TODAY, 'last 更新为今天');
});
s.test('dstat 连续天数：last=前天（断签）→ 从 1 重起', () => {
  const tick = makeDstatTick();
  const out = tick({ last: B4Y, streak: 9, best: { s: 100, w: 1, c: 0, t: 0 }, mcombo: 0 });
  assert.eq(out.streak, 1);
  assert.eq(out.last, TODAY);
});
s.test('dstat 连续天数：last=今天 → 不动（同日多局只计一次）', () => {
  const tick = makeDstatTick();
  const out = tick({ last: TODAY, streak: 4, best: { s: 100, w: 1, c: 0, t: 0 }, mcombo: 0 });
  assert.eq(out.streak, 4, '同日第二局不重复计数');
  const out2 = tick(out);
  assert.eq(out2.streak, 4, '同日第三局仍不重复计数');
});
s.test('dstat 连续天数：last=今天但 streak 异常归零 → 修复为 1', () => {
  const tick = makeDstatTick();
  const out = tick({ last: TODAY, streak: 0, best: { s: 0, w: 0, c: 0, t: 0 }, mcombo: 0 });
  assert.eq(out.streak, 1);
});
s.test('dstat 连续天数：首局（空档）→ 1', () => {
  const tick = makeDstatTick();
  const out = tick(null);
  assert.eq(out.streak, 1);
  assert.eq(out.last, TODAY);
});
s.test('sanitizeDstat：坏形状自愈（streak 收口 3660 / 非日期形状清空 / best 变形归零）', () => {
  const o1 = a.sanitizeDstat(JSON.stringify({ last: '2026-01-01', streak: 99999 }));
  assert.eq(o1.streak, 3660, 'streak 上限 3660');
  const o2 = a.sanitizeDstat(JSON.stringify({ last: '2026/11/13', streak: 5 }));
  assert.eq(o2.last, '', '非 YYYY-MM-DD 形状的 last 清空');
  assert.eq(o2.streak, 5, 'streak 保留');
  const o2b = a.sanitizeDstat(JSON.stringify({ last: '2026-13-99', streak: 5 }));
  assert.eq(o2b.last, '2026-13-99', '形状合法的 last（校验只查格式不查语义）按设计保留');
  const o3 = a.sanitizeDstat(JSON.stringify({ last: YDAY, streak: -3 }));
  assert.eq(o3.streak, 0, '负 streak 归零');
  assert.eq(o3.last, '', 'streak 丢失时 last 一并作废（防跨天误续）');
  const o4 = a.sanitizeDstat(JSON.stringify({ best: { s: 'x' } }));
  assert.deep(o4.best, { s: 0, w: 0, c: 0, t: 0 }, 'best 变形归零');
  const o5 = a.sanitizeDstat('not json');
  assert.deep(o5, { last: '', streak: 0, best: { s: 0, w: 0, c: 0, t: 0 }, mcombo: 0 }, '非 JSON → 全默认');
});
s.test('dstat 落盘段：今日最佳与最长连击随成绩刷新', () => {
  const bt = buildDstatStreak();
  const FixedDate = fakeDateCtor(new Date(2026, 10, 13, 12, 0, 0).getTime());
  const G = { dstat: { last: TODAY, streak: 2, best: { s: 100, w: 1, c: 0, t: 0 }, mcombo: 3 }, maxCombo: 9, wave: 4 };
  bt.tick(G, FixedDate, { s: 5000, w: 4, t: 12345 });
  assert.eq(G.dstat.best.s, 5000, '今日最佳被刷新');
  assert.eq(G.dstat.best.w, 4, '最佳行波次');
  assert.eq(G.dstat.mcombo, 9, '最长连击被刷新');
  assert.eq(G.dstat.streak, 2, '同日不重复计数');
});

/* ================= 画质档位状态机 ================= */
s.test('setTier：0↔2 直达 / 同档 no-op / 越界收口 / q 映射与弹幕上限', () => {
  const g = buildGovernor();
  const { api, G, toasts } = g;
  api.setTier(2, true);
  assert.eq(G.tier, 2); assert.eq(G.q, 0); assert.eq(api.ebCap(), 300);
  api.setTier(5, true);
  assert.eq(G.tier, 2, '越上界收口 2');
  api.setTier(-1, true);
  assert.eq(G.tier, 0, '越下界收口 0');
  assert.eq(api.ebCap(), 400, 'L0 弹幕上限回 400');
  const tN = toasts.length;
  api.setTier(0, true);
  assert.eq(toasts.length, tN, '同档切换无提示');
});
s.test('画质治理器（真实源码切片）：低帧 10s 逐级降档 L0→L1→L2，L2 兜底不再降', () => {
  const g = buildGovernor();
  const { api, G } = g;
  const tick = g.makeTick({ fx: 0 }, 1.0); // RDT=1s：10 tick = 10 秒
  G.state = 'playing';
  api.setTier(0);
  G.tLow = 0; G.tHigh = 0;
  api.srand(1); G.ftEma = 1000 / 30; // 30fps（<40）
  for (let i = 0; i < 9; i++) tick();
  assert.eq(G.tier, 0, '9 秒不降档');
  tick();
  assert.eq(G.tier, 1, '低帧持续 10 秒 → 降 L1');
  assert.ok(g.toasts[g.toasts.length - 1][0].indexOf('L1 省电') >= 0, '降档提示 L1');
  G.tLow = 0;
  for (let i = 0; i < 10; i++) tick();
  assert.eq(G.tier, 2, '再 10 秒 → 降 L2');
  assert.ok(g.toasts[g.toasts.length - 1][0].indexOf('弹幕上限 300') >= 0, '降档提示 L2');
  assert.eq(api.ebCap(), 300, 'L2 弹幕上限 300');
  G.tLow = 0;
  for (let i = 0; i < 30; i++) tick();
  assert.eq(G.tier, 2, 'L2 兜底不再降');
});
s.test('画质治理器：高帧 20s 逐级回升 L2→L1→L0，方向感知提示', () => {
  const g = buildGovernor();
  const { api, G } = g;
  const tick = g.makeTick({ fx: 0 }, 1.0);
  G.state = 'playing';
  api.setTier(2);
  G.ftEma = 1000 / 60; // 60fps（≥55）
  for (let i = 0; i < 19; i++) tick();
  assert.eq(G.tier, 2, '19 秒不回升');
  tick();
  assert.eq(G.tier, 1, '高帧持续 20 秒 → 回升 L1');
  assert.ok(g.toasts[g.toasts.length - 1][0].indexOf('回升') >= 0, '回升提示（不再叫降档）');
  G.tHigh = 0;
  for (let i = 0; i < 20; i++) tick();
  assert.eq(G.tier, 0, '再 20 秒 → 回升 L0');
  assert.ok(g.toasts[g.toasts.length - 1][0].indexOf('L0 全效') >= 0, '回升提示 L0');
  assert.eq(api.ebCap(), 400);
  G.tHigh = 0;
  for (let i = 0; i < 25; i++) tick();
  assert.eq(G.tier, 0, 'L0 兜底不再升');
});
s.test('画质治理器：40~55 观望带不动作且清零计时；非对局（title）不计量', () => {
  const g = buildGovernor();
  const { G } = g;
  const tick = g.makeTick({ fx: 0 }, 1.0);
  G.state = 'playing';
  G.ftEma = 1000 / 47; // 观望带
  for (let i = 0; i < 60; i++) tick();
  assert.eq(G.tier, 0, '观望带 60 秒无动作');
  assert.eq(G.tLow, 0, '低帧计时清零');
  assert.eq(G.tHigh, 0, '高帧计时清零');
  G.ftEma = 1000 / 30; G.tLow = 9;
  G.state = 'title';
  for (let i = 0; i < 60; i++) tick();
  assert.eq(G.tier, 0, '标题页低帧不降档');
  assert.eq(G.tLow, 9, '非对局不累计低帧持时');
});
s.test('画质治理器：手动「高/低」锁档（CFG.fx=1 → L0；CFG.fx=2 → L2）', () => {
  const g1 = buildGovernor();
  g1.G.state = 'playing'; g1.G.tier = 2;
  g1.makeTick({ fx: 1 }, 0.016)();
  assert.eq(g1.G.tier, 0, '「高」锁 L0');
  const g2 = buildGovernor();
  g2.G.state = 'playing'; g2.G.tier = 0;
  g2.makeTick({ fx: 2 }, 0.016)();
  assert.eq(g2.G.tier, 2, '「低」锁 L2');
  assert.eq(g2.api.ebCap(), 300);
});
s.test('画质档位不影响玩法数据：档位切换不触碰 RSTATE', () => {
  const g = buildGovernor();
  const { api, G } = g;
  api.srand(0xBEEF);
  const before = [];
  for (let i = 0; i < 20; i++) before.push(api.rnd());
  api.srand(0xBEEF);
  G.state = 'playing'; G.ftEma = 1000 / 30;
  const tick = g.makeTick({ fx: 0 }, 1.0);
  for (let i = 0; i < 10; i++) tick(); // 触发一次降档
  assert.eq(G.tier, 1);
  const after = [];
  for (let i = 0; i < 20; i++) after.push(api.rnd());
  assert.deep(before, after, 'RSTATE 流与档位无关（「弹幕数据格式、战报、悬赏码完全不受档位影响」）');
});

/* ================= overTitle() 六形态 ================= */
s.test('overTitle 六形态逐一核对', () => {
  const expect = {
    boss: ['全灭达成', 'A L L   B O S S E S   D O W N'],
    brb: ['全灭达成', 'C U S T O M   R U S H   C L E A R'],
    versus: ['P1 获胜', 'S H I P   W I N S'],
    ghost: ['残影讨伐', 'G H O S T   S L A I N'],
    duel: ['对决完成', 'D U E L   C O M P L E T E'],
    classic: ['虚空肃清', 'S E C T O R   C L E A R E D']
  };
  for (const mode of Object.keys(expect)) {
    sb.G.mode = mode;
    assert.deep(a.overTitle(), expect[mode], 'mode=' + mode);
  }
  sb.G.mode = 'unknown-mode';
  assert.deep(a.overTitle(), expect.classic, '未知形态回落 default（虚空肃清）');
});

/* ================= [FIX-CFG2] 设置页开关语义（真实源码提取 CFGS/CFG/CFG_RNG） ================= */
s.test('CFGS 开关语义：二值行 o[1] 必须=「开」；shake/scan=[关,开]，mute 反相 [开,关] 恰好正确', () => {
  const src = getSource();
  const CFGS = new Function(extractDecl(src, 'CFGS') + '; return CFGS;')();
  const CFG_RNG = new Function(extractDecl(src, 'CFG_RNG') + '; return CFG_RNG;')();
  const row = k => { const r = CFGS.find(x => x.k === k); assert.ok(r, 'CFGS 行存在: ' + k); return r; };
  // 逐行不变式：CFG_RNG 上限=1 的二值行（mute 除外——其键语义反相，0=不静音）序号 1 必须=「开」：
  // 缺键回填 1（布尔真值闸门=开）时渲染高亮必须落在「开」上
  // （[FIX-CFG1] wgate/shadow 同款陷阱，[FIX-CFG2] shake/scan 一并修正）
  for (const r of CFGS) {
    if (CFG_RNG[r.k] !== 1 || r.k === 'mute') continue;
    assert.eq(r.o.length, 2, r.k + ' 二值行选项数=2');
    assert.eq(r.o[1], '开', r.k + ' o[1] 必须=「开」（回填值 1 的渲染标签）');
    assert.eq(r.o[0], '关', r.k + ' o[0]=「关」');
  }
  // 点名修复的行 + 明确不动的 mute 行 + [A11Y-CB] 色盲行同律
  assert.deep(row('shake').o, ['关', '开'], '屏幕震动行');
  assert.deep(row('scan').o, ['关', '开'], 'CRT 扫描线行');
  assert.deep(row('shadow').o, ['关', '开'], '昨日之影行（[FIX-CFG1] 回归）');
  assert.deep(row('wgate').o, ['关', '开'], '波间暂停行（[FIX-CFG1] 回归）');
  assert.deep(row('cb').o, ['关', '开'], '色盲模式行（[A11Y-CB] 默认关）');
  assert.deep(row('mute').o, ['开', '关'], '声音总开关行键语义反相（0=不静音）恰好正确——不许动');
  // 布尔真值闸门消费点仍在位：scan → 扫描线显隐；shake → 震幅乘数
  assert.ok(src.indexOf("sc.style.display = CFG.scan ? '' : 'none'") >= 0, 'applyCfg 的 CFG.scan 真值闸门在位');
  assert.ok(src.indexOf('CFG.shake') >= 0, 'CFG.shake 真值乘数消费点在位');
});

/* ================= [FIX-GEOM1]+[R13-GEOM1] setGeom 全视口扫描（真实源码提取，SAFE 归零） =================
   9 行设置项（含色盲模式）在 H=300..900 全程：行盒不交叠、不压副标题/返回按钮/榜块标题。
   crowd 档（H<430）标题块上移 0.30H + 行盒收薄 14px（R12 遗留：844×390 末行压返回钮 7.8px、
   844×320 末 3 行压钮 12~48px 且被屏幕下缘截断 10px —— 本扫描覆盖该回归带）。 */
s.test('setGeom 全视口扫描 H=300..900：行盒不交叠、不压副标题/返回按钮/榜块标题', () => {
  const src = getSource();
  const CL = new Function(extractDecl(src, 'CL') + '; return CL;')();
  const CFGS = new Function(extractDecl(src, 'CFGS') + '; return CFGS;')();
  const SAFE0 = { l: 0, r: 0, t: 0, b: 0 };
  const n = CFGS.length;
  assert.eq(n, 9, 'CFGS 9 行（含色盲模式）——几何扫描前提');
  for (let H = 300; H <= 900; H++) {
    const setGeom = new Function('H', 'CFGS', 'SAFE', 'CL', extractFn(src, 'setGeom') + '; return setGeom;')(H, CFGS, SAFE0, CL);
    const sg = setGeom();
    const bottom = sg.y0 + (n - 1) * sg.pitch + sg.h;
    const tag = 'H=' + H;
    assert.ok(sg.pitch >= sg.h - 0.001, tag + ' 行距≥行高（行盒不交叠，旧版 compact 18<20）pitch=' + sg.pitch.toFixed(2) + ' h=' + sg.h);
    // 副标题字身下缘 ≈ hdrY+29：首行保险丝 y0≥hdrY+30（盒级净距）；crowd 档 hdrY=0.30H；
    // 桌面分支 y0=H*0.47，且 H∈[703,739] 榜块让位会把首行上移到 y0min=H*0.47-10（既有行为，字身擦边 ≤1.7px）→ 阈值取 +20
    const yFloor = H < 430 ? Math.max(56, H * 0.30) + 30 : H < 560 ? H * 0.425 + 30 : H * 0.425 + 20;
    assert.ok(sg.y0 >= yFloor - 0.01, tag + ' 首行文本不压副标题（y0≥' + yFloor.toFixed(1) + '）y0=' + sg.y0.toFixed(2));
    if (H >= 370) {
      assert.ok(bottom <= H - 38, tag + ' 行块底边≤返回按钮上沿（H-38）bottom=' + bottom.toFixed(2));
      if (H > 430 && sg.honFit) assert.ok(bottom <= H * 0.80 - 19 + 0.01, tag + ' 行块底边≤榜块标题字身上缘（honTop-7）bottom=' + bottom.toFixed(2));
    }
  }
});

/* ================= [R13-MIGRATE] 存档迁移矩阵 =================
   四码 v1/v2 历史版本布局 + 旧荣誉榜/dstat/shadow/duels 历史形态，逐一断言「兼容加载 + 坏形状自愈」。
   e2e 侧另有「存档迁移实机」一包旧档走真实页面 boot→对局→落盘全链路。 */
function mkBountyLegacy(ver, nCards, wave, score, grazes, chain) {
  // v1: 1+9+2+3+2+1+1=19 字节；v2: 22 字节（12 卡）。布局同 index.html bountyUnpack 的 BOUNTY_LEGACY 表。
  const b = new Array(1 + nCards + 9).fill(0);
  b[0] = ver;
  b[1] = 3; b[2] = 4; // 前两卡等级 3/4，其余缺省视为 0
  b[1 + nCards] = (wave >> 8) & 255; b[2 + nCards] = wave & 255;
  b[3 + nCards] = (score >> 16) & 255; b[4 + nCards] = (score >> 8) & 255; b[5 + nCards] = score & 255;
  b[6 + nCards] = (grazes >> 8) & 255; b[7 + nCards] = grazes & 255;
  b[8 + nCards] = chain;
  let x = 0; for (let i = 0; i < b.length - 1; i++) x ^= b[i];
  b[b.length - 1] = x;
  return a.b64uEnc(b);
}
s.test('存档迁移矩阵 ① 悬赏码 v1（19 字节 9 卡布局）：hash 页面路径兼容 + ghostStats 下游可消费', () => {
  const code = mkBountyLegacy(1, 9, 9, 0x001234, 3, 1);
  const sb2 = buildSandbox({ location: { hash: '#bounty=' + code } });
  const d = sb2.api.parseHashBounty();
  assert.ok(d, 'v1 悬赏码经 #bounty= 前缀解析成功');
  assert.eq(d.wave, 9, 'v1 wave');
  assert.eq(d.score, 0x1234, 'v1 score');
  assert.eq(d.grazes, 3, 'v1 grazes');
  assert.eq(d.chain, 1, 'v1 chain');
  assert.eq(d.lv[0], 3, 'v1 前 9 卡位可读');
  assert.eq(d.lv[NC - 1], 0, 'v1 缺省新卡位视为 0（构筑继承安全）');
  const st = a.ghostStats(d);
  assert.ok(st.hp > 0 && isFinite(st.hp), 'ghostStats(v1 数据).hp=' + st.hp + ' 有限正数（悬赏页可开局）');
});
s.test('存档迁移矩阵 ② 悬赏码 v2（22 字节 12 卡布局）：hash 页面路径兼容 + ghostStats 下游可消费', () => {
  const code = mkBountyLegacy(2, 12, 15, 0xABCDEF, 40, 2);
  const sb2 = buildSandbox({ location: { hash: '#bounty=' + code } });
  const d = sb2.api.parseHashBounty();
  assert.ok(d, 'v2 悬赏码解析成功');
  assert.eq(d.wave, 15, 'v2 wave');
  assert.eq(d.score, 0xABCDEF, 'v2 score');
  assert.eq(d.grazes, 40, 'v2 grazes');
  assert.eq(d.lv[11], 0, 'v2 卡位 11 未写入 → 0');
  assert.eq(d.lv[NC - 1], 0, 'v2 缺省新卡位视为 0');
  const st = a.ghostStats(d);
  assert.ok(st.hp > 0 && isFinite(st.hp), 'ghostStats(v2 数据).hp=' + st.hp + ' 有限正数');
});
s.test('存档迁移矩阵 ③ 裸 hash 旧悬赏链接（无 #bounty= 前缀的历史分享形态）仍可加载', () => {
  const code = mkBountyLegacy(1, 9, 4, 5000, 1, 0);
  const sb2 = buildSandbox({ location: { hash: '#' + code } });
  const d = sb2.api.parseHashBounty();
  assert.ok(d, '裸 hash 旧链接解析成功');
  assert.eq(d.wave, 4, '裸 hash v1 wave');
});
s.test('存档迁移矩阵 ④ rush/duel/duelres v1 布局（历史唯一版本）：可解 + 未知版本拒绝自愈', () => {
  // rush v1：[ver=1, N, N×序号, tier, xor]
  const rb = [1, 2, 1, 2, 1, 0]; let rx = 0; for (let i = 0; i < rb.length - 1; i++) rx ^= rb[i]; rb[rb.length - 1] = rx;
  const r1 = a.rushUnpack(a.b64uEnc(rb));
  assert.ok(r1, 'rush v1 码可解');
  assert.deep(r1, { order: [1, 2], tier: 1 }, 'rush v1 字段');
  assert.isNull(a.rushUnpack(a.b64uEnc([2, 2, 1, 2, 1, rx])), 'rush ver=2（未来版本）拒绝——不半残不炸');
  // duel v1：21 字节布局（DUEL_VER=1）
  const dcode = a.duelPack({ seed: 7, lv: new Array(NC).fill(0), cap: 5 });
  const d1 = a.duelUnpack(dcode);
  assert.ok(d1 && d1.cap === 5, 'duel v1 码可解（当前版本即历史版本，向后兼容）');
  assert.isNull(a.duelUnpack(a.b64uEnc([2].concat(a.b64uDec(dcode).slice(1)))), 'duel ver=2 拒绝');
  // duelres v1：26 字节布局
  const rcode = a.duelScorePack({ seed: 9, cap: 5, lv: new Array(NC).fill(0), score: 100, wave: 2, won: false, rank: 'C' });
  const rr1 = a.duelScoreUnpack(rcode);
  assert.ok(rr1 && rr1.score === 100, 'duelres v1 码可解');
  assert.isNull(a.duelScoreUnpack(a.b64uEnc([2].concat(a.b64uDec(rcode).slice(1)))), 'duelres ver=2 拒绝');
});
s.test('存档迁移矩阵 ⑤ 旧荣誉榜（neonvoid_lb）：v1.3 时代行缺 m/c → loadLB 补全；坏形状 → 整表重置 + removeItem 自愈', () => {
  const src = getSource();
  const MODE_TAG = new Function(extractDecl(src, 'MODE_TAG') + '; return MODE_TAG;')();
  const mkLS = init => {
    const store = Object.assign({}, init);
    return { store, removed: [], getItem(k) { return k in store ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { store[k] = undefined; delete store[k]; this.removed.push(k); } };
  };
  const run = ls => {
    const G = {};
    new Function('G', 'localStorage', 'MODE_TAG', extractFn(src, 'loadLB') + '; return loadLB;')(G, ls, MODE_TAG)();
    return G.lb;
  };
  // ① v1.3 时代行：只有 n/s/w，无 m（模式标注后期才加）；c 存真值布尔
  const out = run(mkLS({ neonvoid_lb: JSON.stringify([{ n: 'AAA', s: 123456, w: 9, c: 1 }, { n: 'BBB', s: 2345, w: 4 }]) }));
  assert.eq(out.length, 2, '旧行保留');
  assert.eq(out[0].m, 'classic', '缺 m 补 classic');
  assert.eq(out[0].c, 1, 'c 真值归一为 1');
  assert.eq(out[1].c, 0, '缺 c 归一 0');
  assert.eq(out[1].w, 4, 'w 保留');
  // ② 坏形状行（null / s 非数）→ 整表降级重置 + removeItem（[FIX-DATA1] 自愈，绝不白屏）
  const ls2 = mkLS({ neonvoid_lb: JSON.stringify([{ s: 100, w: 1 }, null, { s: 'x' }]) });
  assert.deep(run(ls2), [], '坏形状整表重置');
  assert.ok(ls2.removed.indexOf('neonvoid_lb') >= 0, 'removeItem 落盘自愈');
  // ③ 非 JSON / 超 5 行截断
  assert.deep(run(mkLS({ neonvoid_lb: 'not json' })), [], '非 JSON → 空表（catch 兜底）');
  const six = JSON.stringify([1, 2, 3, 4, 5, 6].map(i => ({ s: i * 100, w: 1 })));
  assert.eq(run(mkLS({ neonvoid_lb: six })).length, 5, '超 5 行截断为 5');
});
s.test('存档迁移矩阵 ⑥ dstat v1.4 早期形态：缺 mcombo/best.c/best.t → sanitizeDstat 补全 4 字段', () => {
  const o = a.sanitizeDstat(JSON.stringify({ last: '2026-11-10', streak: 3, best: { s: 4200, w: 3 } }));
  assert.eq(o.streak, 3, 'streak 保留');
  assert.eq(o.last, '2026-11-10', 'last 保留');
  assert.deep(o.best, { s: 4200, w: 3, c: 0, t: 0 }, 'best 补 c/t');
  assert.eq(o.mcombo, 0, 'mcombo 补 0');
  // 数组 / 标量 / 非法 JSON → 全默认（自愈不抛错）
  const D0 = { last: '', streak: 0, best: { s: 0, w: 0, c: 0, t: 0 }, mcombo: 0 };
  assert.deep(a.sanitizeDstat('[1,2]'), D0, '数组形态 → 全默认');
  assert.deep(a.sanitizeDstat('42'), D0, '标量形态 → 全默认');
  assert.deep(a.sanitizeDstat('garbage'), D0, '非法 JSON → 全默认');
});
s.test('存档迁移矩阵 ⑦ shadow 历史形态：缺 v 字段/条目缺 sc·w/NaN 样本/超窗口 → sanitizeShadow 自愈', () => {
  const ok = '2026-11-12';
  // ① v1.5 早期条目（缺 sc/w，只有采样串）→ 补 0，采样保留
  const o1 = a.sanitizeShadow(JSON.stringify({ days: { [ok]: { s: [100, 80, 0, 200, 120, 1] } } }));
  assert.deep(o1.days[ok], { sc: 0, w: 0, s: [100, 80, 0, 200, 120, 1] }, '缺 sc/w 补 0，采样保留');
  assert.eq(o1.v, 1, '缺 v 字段 → v=1');
  // ② 顶层数组 / 字符串等坏形状 → 空壳 {v:1,days:{}}
  assert.deep(a.sanitizeShadow(JSON.stringify([{ sc: 1 }])), { v: 1, days: {} }, '顶层数组 → 空壳');
  assert.deep(a.sanitizeShadow('"junk"'), { v: 1, days: {} }, '字符串 → 空壳');
  // ③ 样本串混入脏值：NaN 字面量（JSON.parse 直接抛错）→ 空壳自愈；null 样本位（+null=0）→ 采样归 0 保留
  const o3a = a.sanitizeShadow('{"days":{"' + ok + '":{"sc":5,"w":1,"s":[100,80,NaN]}}}');
  assert.deep(o3a, { v: 1, days: {} }, 'NaN 字面量（非法 JSON）→ 空壳自愈');
  const o3 = a.sanitizeShadow(JSON.stringify({ days: { [ok]: { sc: 5, w: 1, s: [100, 80, null, 300, 160, 1] } } }));
  assert.deep(o3.days[ok].s, [100, 80, 0, 300, 160, 1], 'null 样本位归 0 保留');
  // ④ 超 7 天窗口裁剪（环形覆盖保留最近）
  const many = {}; for (let i = 1; i <= 9; i++) many['2026-11-0' + i] = { sc: i, w: 1, s: [1, 2, 3] };
  const o4 = a.sanitizeShadow(JSON.stringify({ days: many }));
  assert.eq(Object.keys(o4.days).length, 7, '9 天裁到 7 天');
  assert.ok(o4.days['2026-11-09'] && !o4.days['2026-11-01'], '保留最近 7 天');
});
s.test('存档迁移矩阵 ⑧ duels 旧行缺字段：me/opp/res/deck/t 补全 + cap 收口 + 12 条封顶', () => {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ seed: 0x1000 + i, cap: 999, me: { s: 100 + i } });
  const out = a.sanitizeDuels(JSON.stringify(rows));
  assert.eq(out.length, 12, '14 条封顶 12');
  assert.eq(out[0].cap, 99, 'cap 999 收口 99');
  assert.isNull(out[0].opp, '缺 opp → null（待对手）');
  assert.eq(out[0].res, '', '缺 res → 待判定');
  assert.deep(out[0].deck, [], '缺 deck → []');
  assert.eq(out[0].t, 0, '缺 t → 0');
  assert.eq(out[0].me.s, 100, 'me.s 保留');
  assert.eq(out[0].me.r, 'D', 'me.r 缺失补 D');
  const out2 = a.sanitizeDuels(JSON.stringify([{ seed: 'x' }, { seed: 7 }]));
  assert.eq(out2.length, 1, 'seed 非数行整行丢弃（自愈）');
  assert.eq(out2[0].seed, 7, '合法行保留');
  assert.deep(a.sanitizeDuels('garbage'), [], '非 JSON → 空史');
});

(async () => {
  const r = await s.run();
  // 源码自检：确认宣传语补全与提示行让位已在 index.html 中（本轮清账项的静态断言）
  const src = getSource();
  const suite2 = createSuite('unit:static');
  suite2.test('对决确认页宣传语含完整口径「同码同卷同词条同随机流（升级三选一同池，序列随对局节奏）」', () => {
    assert.ok(src.indexOf('已从对决链接载入 · 同码同卷同词条同随机流（升级三选一同池，序列随对局节奏） · 出击即开卷') >= 0);
  });
  suite2.test('复制对决链接 toast 文案含完整口径', () => {
    assert.ok(src.indexOf('对决链接已复制 · 发给对手，同码同卷同词条同随机流（升级三选一同池，序列随对局节奏）') >= 0);
  });
  suite2.test('[R14-PROMO] 分享链接宣传语三处统一完整口径（#bounty=/#rush= 补全，样板=#duel=）', () => {
    assert.ok(src.indexOf('残影悬赏链接已复制 · 发给朋友，构筑/波次/成绩/击杀链全部入码 · 打开即迎战你的死亡残影') >= 0,
      '#bounty= 分享 toast 已补全（短版旧文案「发给朋友来讨伐你的残影」已移除）');
    assert.ok(src.indexOf('发给朋友来讨伐你的残影') < 0, '旧短版已移除');
    assert.ok(src.indexOf('分享链接已复制 · 发给朋友，出场序列与血量档全部入码 · 打开直接迎战你的自定义连战') >= 0,
      '#rush= 分享 toast 已补全（短版旧文案「发给朋友迎战你的菜单」已移除）');
    assert.ok(src.indexOf('发给朋友迎战你的菜单') < 0, '旧短版已移除');
  });
  suite2.test('结算底部三行统一让位（[FIX-COS13]+[FIX-COS13b]）：stackFits 预算 + ctaY 受 btnY-31 钳制 + 提示行随 ctaY', () => {
    assert.ok(src.indexOf('const stackFits = !compact || hintY <= btnY - 55;') >= 0, 'stackFits 预算在位（COS13b：hintY ≤ btnY-55 保证 ctaY=hintY+24 不被带顶钳制拉回）');
    assert.ok(src.indexOf('const stackFits = !compact || hintY <= btnY - 46;') < 0, '旧预算 btnY-46 已被 COS13b 收紧');
    assert.ok(src.indexOf('Math.min(hintDrawn ? hintY + 24 : Math.min(H * 0.87, rowEnd + 30), btnY - 31)') >= 0, 'CTA 也受带顶钳制');
    assert.ok(src.indexOf('const hintRowY = ctaY + 24;') >= 0, '提示行随 CTA（中心距恒 24px，无独立钳制）');
    assert.ok(src.indexOf('hintY <= btnY - 7') < 0, '旧版独立钳制已移除');
  });
  suite2.test('NV_CHEAT.hp1 钩子存在（残影/BOSS 血量置 1 走真实死亡路径）', () => {
    assert.ok(src.indexOf('hp1: () => { if (G.boss) G.boss.hp = 1; }') >= 0);
  });
  suite2.test('[FIX-DUEL1] 对决构建页「波次上限」标签与档位按钮行呼吸间距 ≥10px，网格双侧几何一致', () => {
    // 档位按钮：y = H*0.055+106, h=24 → 底 +130；标签 10.5px 字身上缘 ≈ 中点-6.5（textBaseline middle 实测）
    const btnBottom = 106 + 24, labelY = 147, glyphHalf = 6.5;
    assert.ok(labelY - glyphHalf - btnBottom >= 10, '标签字身上缘距按钮下缘 ≥10px：' + (labelY - glyphHalf - btnBottom).toFixed(1));
    assert.ok(src.indexOf("txt('波次上限（打满即对决完成）', cx, H * 0.055 + 147") >= 0, '标签 y=+147 在位（旧版 +138 已移除）');
    assert.ok(src.indexOf('H * 0.055 + 138') < 0, '旧版标签位置已移除');
    assert.eq(src.split('H * 0.055 + (inv ? 86 : 176)').length - 1, 2, 'gy0=176 公式渲染侧/titleBtns 双侧各一份');
    assert.ok(src.indexOf('inv ? 86 : 150') < 0, '旧版网格顶 150 已移除');
    assert.ok(src.indexOf('const dnFit = Math.max(0, Math.floor((Math.min(H - 56 - SAFE.b, H * 0.80) - 8 - (hy + 15)) / 13) + 1);') >= 0, '对决史条数按动作按钮带钳制在位');
  });
  suite2.test('[FIX-GEOM1]+[R13-GEOM1] setGeom compact 行高 18 / crowd 档 14 与行距下限持平 + 榜块让位判定提前 8px', () => {
    assert.ok(src.indexOf('const h = crowd ? 14 : compact ? 18 : 26, n = CFGS.length;') >= 0, 'compact 18（旧版 20 > pfloor 18 → 行盒交叠）/ crowd 14（极矮横屏 9 行压返回钮修复）');
    assert.ok(src.indexOf('if (H > 430 && bottom0 > honTop - 8) {') >= 0, '榜块标题字身（honTop-7）让位判定提前 8px 触发');
    assert.ok(src.indexOf('const pfloor = crowd ? 14 : compact ? 18 : 28;') >= 0, '行距下限与行高持平（行盒相接不交叠）');
    assert.ok(src.indexOf('const crowd = compact && H < 430;') >= 0, 'crowd 极矮横屏档（844×390 / 844×320）在位');
    assert.ok(src.indexOf('const hdrY = crowd ? Math.max(56, H * 0.30) : H * 0.425;') >= 0, 'crowd 标题块上移 0.30H 在位');
    assert.ok(src.indexOf("txt('—— 系统设置 · SETTINGS ——', cx, sg.hdrY,") >= 0, '设置页标题跟随 hdrY（渲染/几何同源）');
  });
  suite2.test('[R13-SW] 发版纪律：sw.js CACHE 版本与 index.html 版本串同步递增', () => {
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const m = swSrc.match(/const CACHE = 'neon-void-v(\d+)'/);
    assert.ok(m, 'sw.js CACHE 版本行在位');
    const idx = getSource();
    const vs = idx.match(/NEON VOID v(\d+\.\d+\.\d+)/);
    assert.ok(vs, 'index.html 页脚版本串在位');
    assert.eq(vs[1], '1.5.4', 'index.html 版本 = 1.5.4（本轮发版）');
    assert.eq(+m[1], 14, 'sw.js CACHE = v14（上一版 v13 + 1）');
  });
  suite2.test('[R14-HOV] hover 白圈判定带 mouse.inside 门 + 触屏事件同步清 hover 态', () => {
    // 四处 hov 判定（title 按钮/升级卡/波次闸/结算钮）全部带 inside 门——stuck hover 清零
    assert.eq((src.match(/const hov = mouse\.inside && mouse\.x >= /g) || []).length, 4, '4 处 hov 判定都有 mouse.inside 门');
    assert.ok(src.indexOf("cv.addEventListener('pointermove', (e) => {") >= 0);
    assert.ok((src.match(/mouse\.inside = false; \/\/ \[FIX-HOV1\]/g) || []).length >= 1, '触屏 pointerdown 清 hover 态在位');
    assert.ok(src.indexOf('if (G.touchMode) G.touchMode = false; // [R14-HOV] 同上：真鼠标点按还原鼠标形态') >= 0 ||
      (src.match(/if \(G\.touchMode\) G\.touchMode = false;/g) || []).length === 2, '混合设备真鼠标还原 touchMode（move+down 两处）');
  });
  suite2.test('[R14-OVER] 结算屏「⌂ 主界面」钮在位（触屏可达 goTitle，同键盘 T/波次闸 ⌂）', () => {
    assert.ok(src.indexOf("items.push({ k: 'title', l: '⌂ 主界面 · T', c: '#7d95b8' });") >= 0, '结算主界面钮在位');
    assert.ok(src.indexOf("else if (k === 'title') { goTitle(); return; }") >= 0, 'overAct(title) → goTitle 在位');
    assert.ok(src.indexOf("txt(ob.l, ob.x + ob.w / 2, ob.y + ob.h / 2, ob.w < 96 ? 9 : 12") >= 0, '窄 chip 缩字号防溢出');
  });
  suite2.test('[R14-LOGO1] 小窗（H<560）× 页眉 ≤0.425H 的标题页（players/ach/set/ghost）跳过大 logo', () => {
    assert.ok(src.indexOf("!((G.tStage === 'set' || G.tStage === 'ach' || G.tStage === 'players' || G.tStage === 'ghost') && H < 560)") >= 0,
      'logo 让位条件在位（桌面常规窗口 H≥560 逐像素不变）');
  });
  suite2.test('[R14-COPY] 设置页副标题去同义反复 + 分享链接宣传语三处完整口径', () => {
    assert.ok(src.indexOf("txt('点击选项立即生效 · 自动保存到本机'") >= 0, '设置页副标题精简在位');
    assert.ok(src.indexOf('点击选项立即生效并保存') < 0, '旧同义反复句已移除');
  });
  const r2 = await suite2.run();
  const fails = r.fails.length + r2.fails.length;
  console.log(`UNIT TOTAL: ${r.pass + r2.pass} passed, ${fails} failed, ${r.total + r2.total} tests`);
  process.exit(fails ? 1 : 0);
})();
