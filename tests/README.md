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
node tests/e2e.test.js       # playwright headless，约 9~10 分钟（含 5 分钟 monkey + 性能基线）
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
| `_lib.js` | 共享库：源码提取器（字符串/注释/正则字面量感知的括号配对）、四码/RSTATE/画质/留存的沙箱、迷你测试框架与断言。dstat 切片沙箱与切片本体共用同一注入 Date（跨日 time-bomb 防御）；`NV_E2E_ONLY=子串` 过滤器供调试 |
| `unit.test.js` | 55+12 项：#bounty/#rush/#duel/#duelres 四码编解码往返 + 坏码拒绝 + 三码互斥解析为 null；RSTATE（mulberry32）同 seed 确定性；dstat 连续挑战天数边界（recordScore 真实源码切片 + 可注入日期，任意日历日可跑）；画质档位状态机（setTier + 主循环治理器真实源码切片）；overTitle 六形态；**设置页 CFGS 开关语义**（二值行 o[1] 必须=「开」，mute 反相键不动）；**setGeom 全视口扫描 H=300..900**（9 行设置项行盒不交叠/不压副标题/返回按钮/榜块标题，[FIX-GEOM1]+[R13-GEOM1] crowd 档）；**[R13-MIGRATE] 存档迁移矩阵 8 类**（悬赏码 v1/v2 布局 + 裸 hash 旧链接 + rush/duel/duelres v1 与未知版本拒绝 + 旧荣誉榜 loadLB 补全/重置 + dstat 早期形态 + shadow 历史形态 + duels 旧行，兼容加载 + 坏形状自愈）；另附 12 项源码静态断言（宣传语口径/结算让位/hp1 钩子/对决页标签呼吸间距/setGeom 常量/发版纪律 CACHE=14 与 v1.5.4 同步/[R14-PROMO] 三条分享码 toast 完整口径/[R14-HOV] hover 门+混合设备还原/[R14-OVER] 结算主界面钮/[R14-LOGO1] 小窗 logo 让位/[R14-COPY] 设置页文案） |
| `e2e.test.js` | 10 形态逐一 boot（7 模式键盘路径 + 残影/构建器/种子对决三个入口页 + 对决结果页）、四码加载路径逐字段核对、每日挑战同日确定性（dseed 帧序无关）、画质三档切换（手动锁档 + NV_CHEAT 治理器，fps/low·high 成对重发）、种子对决全链路（构建→码→开局→成绩码→对决史→判胜负）、昨日之影采样与回放、ghost/brb 胜局实机、**色盲模式**（默认外观像素不变 + 开启后弹幕蓝橙/拾取物换板取色断言 + 设置页记忆）、**触屏 44px**（全阶段 touch rect 实测 + 外扩点按行为）、**[R14-HOV] 触屏完整一局**（844×390 仿真：鼠标 hover 白圈像素实测 → 触屏按下即清（pointerleave 不可达路径）· 摇杆/技能/升级选卡/波次闸/结算「⌂ 主界面」全触屏路径 · 零 pageerror）、**设置页实机**（scan/shake 语义往返 + 高亮像素落点 + 9 行不压返回钮）、**对决构建页亮像素剖面**（档位按钮→标签暗隙 ≥10px）、**[R13-MIGRATE] 存档迁移实机**（v1 悬赏码 + 旧 lb/dstat/duels/shadow 一包旧档 → 零异常加载 + 自愈就位 + 对局落盘迁移）、**性能基线**（10 形态 boot ≤2s / 对局 30s JS heap 增长 ≤5MB（CDP 强制 GC）/ SW 离线启动 ≤3s；采样写 `perf-baseline.json` 工件）、**monkey**（[A11Y-MONKEY]+[R13-MONKEY] **5 分钟**随机点击/按键/摇杆注入 + 每 ~15s 前台/后台 visibility 切换 + 每 ~25s 视口 resize（含 844×320 极矮档），零 pageerror + 进程存活 + 可退回标题，seed=0x00C0FFEE 可重放） |
| `run-all.js` | 一键运行器：process.chdir 到仓库根，顺序跑 unit + e2e，汇总退出码 |

## 验收钩子（index.html 内，生产路径零调用）

- `window.NV_SNAP()` — 只读快照：state/mode/won/wave/score/muts/queue/enemies/boss/duelRun/
  duels/shadowRef/shSampN/tier/ebCap/qToast/cfgCb/dseed/sgeom（设置页几何本体：crowd/hdrY/y0/pitch/h/honFit）/
  ebS（弹幕样本：bd=BOSS 标记/bo=反弹/sh=色盲形状/c=原始色）/pp（飞船位）/picks（拾取物样本）等，e2e 的断言全部走它。
- `window.NV_BTN()` — 只读按钮矩形：当前状态所有画布按钮的视觉矩形（x/y/w/h）与触屏生效的
  44px 外扩矩形（tx/ty/tw/th，与命中共用 touchRect），触屏审计用例直接实测它。
- `window.NV_CHEAT.*` — 测试专用写钩子：`xp()` 触发升级、`fps(f)` 模拟帧率、
  `lowNow()/highNow()` 直接满足降/回升持时、`kill()` 速死走 recordScore、
  `hp1()` 把当前 BOSS/残影血量置 1（走真实受击死亡→winGame 路径）、`tier()` 读档位、
  `pk(k)` 投放拾取物（色盲拾取板断言）、`shot()` 原地悬停杂兵弹（自动避开敌我实体）、
  `bshot()` 匀速 BOSS 弹（bd=1 绘制路径断言）。

## 调试过滤

`NV_E2E_ONLY=子串 node tests/e2e.test.js` 只跑名字含该子串的用例（全量口径不变，run-all 不受影响）。

## 存档迁移矩阵（[R13-MIGRATE]，本轮新增维度）

构造历史存档/历史码布局 ≥8 种，逐一断言「兼容加载 + 坏形状自愈」，unit 与 e2e 双层：

| # | 历史形态 | 断言 |
| --- | --- | --- |
| ① | 悬赏码 v1（19 字节 9 卡布局） | `#bounty=` 页面路径可解析，缺省新卡位视为 0，ghostStats 下游可消费 |
| ② | 悬赏码 v2（22 字节 12 卡布局） | 同上 |
| ③ | 裸 hash 旧悬赏链接（无 `#bounty=` 前缀） | 旧分享链接仍可加载 |
| ④ | rush/duel/duelres v1 布局 | 历史唯一版本可解；未知版本号（ver=2）拒绝——不半残不炸 |
| ⑤ | 旧荣誉榜行缺 `m`/`c` 字段（v1.3 时代） | loadLB 补 `classic`/归一 0；坏形状行整表重置 + removeItem 落盘自愈 |
| ⑥ | dstat 早期形态（无 `mcombo`，best 缺 `c`/`t`） | sanitizeDstat 补全 4 字段；数组/标量/非法 JSON → 全默认 |
| ⑦ | shadow 历史形态（缺 `v`/条目缺 `sc`·`w`/NaN·null 样本/超窗口） | sanitizeShadow 自愈为 `{v:1,days:{…}}`；坏条目整条丢弃；7 天环形裁剪 |
| ⑧ | duels 旧行（无 `opp`/`res`/`deck`/`t`，cap 越界，>12 条） | sanitizeDuels 补全/收口/封顶；seed 非数行整行丢弃 |
| 实机 | 一包旧档 + v1 悬赏码真实 boot | 零 pageerror；v1 码入局血量吻合；影子开关自愈出现；对局落盘后 dstat/lb 已是全字段形态、duels 旧档原样保留 |

## 注意事项

- e2e 的 context 带 `hasTouch: true`：命中游戏的移动端横屏媒体查询，画布铺满 844×390
  （桌面 `pointer:fine` 会退回 16:10 信箱式布局，不是真机形态）。
- 「每日同日确定性」对比的是帧序无关的量：dseed（种子输入快照）、词条（startGame 同步抽取）、
  波次 1 构成（未出生队列 + 在场敌人的类型多重集）。
- 四码的编码/解码在 Node 侧用 `_lib.js` 提取的同一套编解码器完成，e2e 只用它们构造
  测试输入与解析剪贴板产物，页面侧走真实 hash 载入路径。
- monkey 的 visibility 切换通过改写 `document.hidden` + 派发真实 `visibilitychange`
  命中游戏监听器（playing 时自动暂停 + 音频挂起）；resize 走 `setViewportSize`
  真实触发 window.resize（画布重建/去抖路径）。
