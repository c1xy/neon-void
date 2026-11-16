# NEON VOID · 霓虹虚空

零依赖单文件 HTML5 弹幕射击游戏：**`index.html` 一个文件就是全部**（`sw.js` 是唯一的附加文件，
只负责 PWA 离线缓存）。双击 `index.html` 即玩；WebAudio 实时合成音源，无任何构建/打包步骤。

- 当前版本 **v1.5.6**（关于页/页脚/sw.js 三处同源；测试套件静态钉住该契约，见 tests/README.md）
- 体量 ~320KB · Canvas 2D · 1320 词条组合 · 6 BOSS · 36 成就 · 14 构筑卡

## 运行

| 方式 | 说明 |
| --- | --- |
| 双击 `index.html` | 直接游玩（file:// 下不注册 SW，不受影响） |
| 任意静态服务器 | `python -m http.server` / `npx serve` 等，http(s) 下自动注册 SW |
| 离线 | 装过 SW 后断网可玩（stale-while-revalidate；`?查询参数`/`#锚点` 不影响缓存命中） |

**操作**：WASD/方向键移动 · 鼠标瞄准自动开火 · `P` 暂停 · `M` 静音 · `A` 成就 · `G` 指南 ·
`S` 设置 · `C` 关于 · `B` 连战构建器。移动端横屏触屏：左半屏摇杆 + 右下技能键。

## 10 形态清单（与游戏内「关于 · CREDITS」页一致）

| # | 形态 | 入口 |
| --- | --- | --- |
| 1 | 经典战役 classic | 主菜单 `1` |
| 2 | 无尽深渊 endless | 主菜单 `2` |
| 3 | BOSS 连战 boss | 主菜单 `3` |
| 4 | 混沌 chaos | 主菜单 `4` |
| 5 | 每日挑战 daily | 主菜单 `5`（同日同卷：种子=本地日期） |
| 6 | 对抗（热座） versus | 主菜单 `6` |
| 7 | 擦弹专精 graze | 主菜单 `7`（开火封印 · 擦弹即得分） |
| 8 | 残影悬赏 ghost | 死亡后签发悬赏码 / `#bounty=` 打开 |
| 9 | 自定义连战 brb（连战构建器） | `B` 构建器 / `#rush=` 打开 |
| 10 | 种子对决 duel | 主菜单 ⚔ chip / `#duel=` 打开（对决成绩回执为 `#duelres=`） |

## 分享四码

| 码 | 含义 |
| --- | --- |
| `#bounty=` | 残影悬赏：构筑/波次/得分/擦弹/击杀链全部入码，打开即迎战死亡残影 |
| `#rush=` | 自定义连战：BOSS 出场序列 + 血量档位入码，打开直达构建器确认页 |
| `#duel=` | 种子对决：seed/波次上限/初始构筑入码，同码同卷同词条同随机流 |
| `#duelres=` | 对决成绩：成绩回执码，与本机对决史自动判 w/l/t 三态胜负 |

四码编码/解码、坏码拒绝与历史版本迁移由 `tests/unit.test.js` 全矩阵回归钉住。

## Service Worker 与发版纪律

`sw.js` 采用 stale-while-revalidate：命中缓存先行，后台回源更新；activate 清旧版本缓存。
**发版纪律（[FIX-SW1]）**：凡改动了被缓存文件，`sw.js` 的 `CACHE` 版本号必须在前一版基础上 +1
（当前 `neon-void-v16`），`index.html` 页脚/关于页版本串同步递增。升级路径（旧缓存接管 → 新版
发布 → 接管后缓存/网络/导航三路资源全为新版）由 `tests/e2e.test.js` 的 [R16-SWUPG] 用例端到端验证。

## 测试

```bash
node tests/run-all.js    # unit（node 直跑）+ e2e（playwright headless）全量回归
```

详见 **[tests/README.md](tests/README.md)**：55+18 项单测（四码编解码/迁移矩阵/画质治理器等，
被测对象直接提取自 index.html 源码）+ 35 项 e2e（10 形态 boot/四码路径/触屏/色盲/存档迁移/
连局压测/SW 升级路径/5 分钟 monkey/性能基线）。
