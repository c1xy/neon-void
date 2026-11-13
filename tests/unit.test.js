#!/usr/bin/env node
/* Neon Void 单元测试 — node 直跑，无浏览器、无第三方依赖。
   被测对象从 index.html 源码按名字提取（见 _lib.js），跑的是游戏本体纯逻辑：
   - 四码编解码（#bounty= / #rush= / #duel= / #duelres=）往返 + 坏码拒绝 + 三码互斥解析为 null
   - RSTATE（mulberry32）同 seed 确定性
   - dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期）
   - 画质档位状态机（setTier + 主循环治理器真实源码切片）
   - overTitle() 六形态
   运行：node tests/unit.test.js */
'use strict';
const { createSuite, assert, buildSandbox, buildDstatStreak, buildGovernor, fakeDateCtor, getSource, extractDecl, extractFn } = require('./_lib');

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

/* ================= dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期） ================= */
const TODAY = '2026-11-13', YDAY = '2026-11-12', B4Y = '2026-11-11';
function makeDstatTick() {
  const bt = buildDstatStreak();
  const FixedDate = fakeDateCtor(new Date(2026, 10, 13, 12, 0, 0).getTime()); // 本地 2026-11-13
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
  // 本轮点名修复的三行 + 明确不动的 mute 行
  assert.deep(row('shake').o, ['关', '开'], '屏幕震动行');
  assert.deep(row('scan').o, ['关', '开'], 'CRT 扫描线行');
  assert.deep(row('shadow').o, ['关', '开'], '昨日之影行（[FIX-CFG1] 回归）');
  assert.deep(row('wgate').o, ['关', '开'], '波间暂停行（[FIX-CFG1] 回归）');
  assert.deep(row('mute').o, ['开', '关'], '声音总开关行键语义反相（0=不静音）恰好正确——不许动');
  // 布尔真值闸门消费点仍在位：scan → 扫描线显隐；shake → 震幅乘数
  assert.ok(src.indexOf("sc.style.display = CFG.scan ? '' : 'none'") >= 0, 'applyCfg 的 CFG.scan 真值闸门在位');
  assert.ok(src.indexOf('CFG.shake') >= 0, 'CFG.shake 真值乘数消费点在位');
});

/* ================= [FIX-GEOM1] setGeom 全视口扫描（真实源码提取，SAFE 归零） =================
   H≥370：8 行 × 行距下限 18 + 副标题保险丝（H*0.425+30）起，几何上才可能放得下
   （H*0.425+174 ≤ H-38 ⇔ H ≥ 368.7）——真机最矮形态 844×390 在覆盖范围内；
   H<370 属不可能视口，只断「行盒不交叠 + 副标题保险丝」两条无条件成立的约束 */
s.test('setGeom 全视口扫描 H=300..900：行盒不交叠、不压副标题/返回按钮/榜块标题', () => {
  const src = getSource();
  const CL = new Function(extractDecl(src, 'CL') + '; return CL;')();
  const CFGS = new Function(extractDecl(src, 'CFGS') + '; return CFGS;')();
  const SAFE0 = { l: 0, r: 0, t: 0, b: 0 };
  const n = CFGS.length;
  for (let H = 300; H <= 900; H++) {
    const setGeom = new Function('H', 'CFGS', 'SAFE', 'CL', extractFn(src, 'setGeom') + '; return setGeom;')(H, CFGS, SAFE0, CL);
    const sg = setGeom();
    const bottom = sg.y0 + (n - 1) * sg.pitch + sg.h;
    const tag = 'H=' + H;
    assert.ok(sg.pitch >= sg.h - 0.001, tag + ' 行距≥行高（行盒不交叠，旧版 compact 18<20）pitch=' + sg.pitch.toFixed(2) + ' h=' + sg.h);
    // 副标题字身下缘 ≈ H*0.425+29：compact 保险丝 y0≥+30（盒级净距）；桌面分支 y0=H*0.47，且
    // H∈[703,739] 榜块让位会把首行上移到 y0min=H*0.47-10（旧版既有行为，字身擦边 ≤1.7px）→ 阈值取 +20
    const yFloor = H < 560 ? H * 0.425 + 30 : H * 0.425 + 20;
    assert.ok(sg.y0 >= yFloor - 0.01, tag + ' 首行文本不压副标题（y0≥' + yFloor.toFixed(1) + '）y0=' + sg.y0.toFixed(2));
    if (H >= 370) {
      assert.ok(bottom <= H - 38, tag + ' 行块底边≤返回按钮上沿（H-38）bottom=' + bottom.toFixed(2));
      if (H > 430 && sg.honFit) assert.ok(bottom <= H * 0.80 - 19 + 0.01, tag + ' 行块底边≤榜块标题字身上缘（honTop-7）bottom=' + bottom.toFixed(2));
    }
  }
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
  suite2.test('结算底部三行统一让位（[FIX-COS13]）：stackFits 预算 + ctaY 受 btnY-31 钳制 + 提示行随 ctaY', () => {
    assert.ok(src.indexOf('const stackFits = !compact || hintY <= btnY - 46;') >= 0, 'stackFits 预算在位');
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
  suite2.test('[FIX-GEOM1] setGeom compact 行高 18 与行距下限持平 + 榜块让位判定提前 8px', () => {
    assert.ok(src.indexOf('const h = compact ? 18 : 26, n = CFGS.length;') >= 0, 'compact 行高 18（旧版 20 > pfloor 18 → 行盒交叠）');
    assert.ok(src.indexOf('if (H > 430 && bottom0 > honTop - 8) {') >= 0, '榜块标题字身（honTop-7）让位判定提前 8px 触发');
    assert.ok(src.indexOf('const pfloor = compact ? 18 : 28;') >= 0, '行距下限 18 保持');
  });
  const r2 = await suite2.run();
  const fails = r.fails.length + r2.fails.length;
  console.log(`UNIT TOTAL: ${r.pass + r2.pass} passed, ${fails} failed, ${r.total + r2.total} tests`);
  process.exit(fails ? 1 : 0);
})();
