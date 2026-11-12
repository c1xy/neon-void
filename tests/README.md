# Neon Void 自动化测试（tests/）

零依赖单文件游戏的回归测试基建。**被测对象是 index.html 本体**：单测直接从源码按名字提取真实的
函数/声明/内联逻辑块执行（不是手抄复刻），e2e 用 playwright 无头浏览器走真实页面路径。

## 一键运行

```bash
node tests/run-all.js        # unit + e2e 顺序执行，任一失败退出码非零
```

只跑单侧：

```bash
node tests/unit.test.js      # 无浏览器，node 直跑，秒级
node tests/e2e.test.js       # playwright headless，约 1 分钟
```

环境要求：Node ≥ 18；e2e 需要 playwright 浏览器，按以下顺序解析——
本仓库 `node_modules` 的 `playwright`/`playwright-core` → 全局 npm 的
`@playwright/cli` 内置 `playwright-core`（Windows/macOS 常见位置）→ 浏览器优先内置
chromium，缺失时回落系统 Chrome（`channel: 'chrome'`）→ Edge（`channel: 'msedge'`）。
任一路径可用即可，无需额外安装。

e2e 截图/工件目录由环境变量指定（缺省系统临时目录 `neon-void-e2e-shots`）：

```bash
NV_E2E_SHOTS=./shots node tests/e2e.test.js
```

## 三件套

| 文件 | 作用 |
| --- | --- |
| `_lib.js` | 共享库：源码提取器（字符串/注释/正则字面量感知的括号配对）、四码/RSTATE/画质/留存的沙箱、迷你测试框架与断言 |
| `unit.test.js` | 45+4 项：#bounty/#rush/#duel/#duelres 四码编解码往返 + 坏码拒绝 + 三码互斥解析为 null；RSTATE（mulberry32）同 seed 确定性；dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期）；画质档位状态机（setTier + 主循环治理器真实源码切片）；overTitle 六形态；另附 4 项源码静态断言（宣传语口径/提示行让位/hp1 钩子在位） |
| `e2e.test.js` | 10 形态逐一 boot（7 模式键盘路径 + 残影/构建器/种子对决三个入口页 + 对决结果页）、四码加载路径逐字段核对、每日挑战同日确定性（两次开局对比）、画质三档切换（手动锁档 + NV_CHEAT 治理器）、种子对决全链路（构建→码→开局→成绩码→对决史→判胜负）、昨日之影采样与回放、ghost/brb 胜局实机（NV_CHEAT.hp1 辅助钩子走真实胜利路径） |
| `run-all.js` | 一键运行器：process.chdir 到仓库根，顺序跑 unit + e2e，汇总退出码 |

## 验收钩子（index.html 内，生产路径零调用）

- `window.NV_SNAP()` — 只读快照：state/mode/won/wave/score/muts/queue/enemies/boss/duelRun/
  duels/shadowRef/shSampN/tier/ebCap/qToast 等，e2e 的断言全部走它。
- `window.NV_CHEAT.*` — 测试专用写钩子：`xp()` 触发升级、`fps(f)` 模拟帧率、
  `lowNow()/highNow()` 直接满足降/回升持时、`kill()` 速死走 recordScore、
  `hp1()` 把当前 BOSS/残影血量置 1（走真实受击死亡→winGame 路径）、`tier()` 读档位。

## 注意事项

- e2e 的 context 带 `hasTouch: true`：命中游戏的移动端横屏媒体查询，画布铺满 844×390
  （桌面 `pointer:fine` 会退回 16:10 信箱式布局，不是真机形态）。
- 「每日同日确定性」对比的是帧序无关的量：seed（RSTATE 播种后快照，首个出兵延迟前读取）、
  词条（startGame 同步抽取）、波次 1 构成（未出生队列 + 在场敌人的类型多重集）。
- 四码的编码/解码在 Node 侧用 `_lib.js` 提取的同一套编解码器完成，e2e 只用它们构造
  测试输入与解析剪贴板产物，页面侧走真实 hash 载入路径。
