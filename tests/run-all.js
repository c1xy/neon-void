#!/usr/bin/env node
/* Neon Void 一键测试运行器：unit（node 直跑）+ e2e（playwright headless）顺序执行、汇总退出码。
   运行：node tests/run-all.js
   可选：NV_E2E_SHOTS=<目录> 指定 e2e 截图输出目录（缺省系统临时目录）。 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

process.chdir(path.resolve(__dirname, '..')); // 仓库根（neon-void/），测试内的相对路径以此为基准

const suites = [
  { name: 'unit', cmd: process.execPath, args: ['tests/unit.test.js'] },
  { name: 'e2e', cmd: process.execPath, args: ['tests/e2e.test.js'] }
];

let failed = 0;
const summary = [];
for (const s of suites) {
  console.log(`\n========== ${s.name} ==========`);
  console.log(`$ ${s.cmd} ${s.args.join(' ')}`);
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit', env: process.env });
  const ok = r.status === 0;
  summary.push(`${s.name}: ${ok ? 'PASS' : 'FAIL'} (exit ${r.status})`);
  if (!ok) failed++;
}

console.log('\n========== SUMMARY ==========');
for (const line of summary) console.log(line);
console.log(failed ? `\nRESULT: ${failed} suite(s) FAILED` : '\nRESULT: ALL GREEN');
process.exit(failed ? 1 : 0);
