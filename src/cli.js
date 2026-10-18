#!/usr/bin/env node
// cli.js —— dsh-sync 命令行入口：版本信息与离线自检。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version, name, description } = require('../package.json');

const HELP = `
${name} v${version}

${description}

用法:
  dsh-sync                    显示帮助
  dsh-sync --version, -v      显示版本号
  dsh-sync selfcheck          运行离线自检（不联网、不写入 profile，输出 PASS/FAIL）
  dsh-sync help, --help, -h   显示本帮助
`;

const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(`dsh-sync v${version}`);
} else if (arg === 'selfcheck') {
  // selfcheck 自行打印 PASS/FAIL 汇总并设置 process.exitCode，直接沿用其结果。
  await import('../scripts/selfcheck.js');
} else if (arg === undefined || arg === 'help' || arg === '--help' || arg === '-h') {
  console.log(HELP.trim() + '\n');
} else {
  console.error(`未知命令: ${arg}`);
  console.log(HELP.trim() + '\n');
  process.exitCode = 1;
}
