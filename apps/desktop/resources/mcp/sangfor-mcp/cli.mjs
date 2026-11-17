#!/usr/bin/env node
// 终端登录/检查工具（MCP 之外的备用入口）
//   node cli.mjs login          交互式登录（密码或扫码）
//   node cli.mjs login --qr     直接走扫码
//   node cli.mjs whoami         查看登录状态
import readline from 'node:readline/promises';
import * as auth from './lib/auth.mjs';
import { AUTH_DIR } from './lib/config.mjs';
import QRCode from 'qrcode';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cmd = process.argv[2] ?? 'whoami';
const flagQr = process.argv.includes('--qr');

if (cmd === 'whoami') {
  await auth.loadSession();
  const me = await auth.whoami();
  console.log(me ? `已登录：${me.username} (uid=${me.uid})` : '未登录（node cli.mjs login）');
  process.exit(me ? 0 : 1);
}

if (cmd === 'login') {
  await auth.loadSession();
  const cred = auth.loadCredentials();
  let method = flagQr ? 'qrcode' : null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (!method) {
    method = await rl.question('登录方式 [1]账号密码 [2]扫码 (默认1): ');
    method = method.trim() === '2' ? 'qrcode' : 'password';
  }

  if (method === 'qrcode') {
    const url = await auth.qrCreate();
    const qrFile = path.join(AUTH_DIR, 'qr.png');
    await QRCode.toFile(qrFile, url, { width: 500 });
    console.log('\n请用微信/深信服 App 扫码：');
    console.log(await auth.qrAscii(url));
    console.log(`二维码图片：${qrFile}`);
    console.log(`（或手机浏览器打开：${url}）\n轮询中...`);
    spawn('cmd', ['/c', 'start', '', qrFile], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      let st;
      try {
        st = await auth.qrPoll();
      } catch (e) {
        console.log('轮询出错：' + e.message);
        continue;
      }
      if (st.status === 3) {
        console.log(`✅ 登录成功：${st.info?.username ?? ''}`);
        rl.close();
        process.exit(0);
      }
      if (st.status === 2) {
        console.log('二维码过期，请重新运行');
        rl.close();
        process.exit(2);
      }
      if (st.status === 1) console.log('已扫码，请在手机上确认...');
    }
    console.log('等待超时');
    rl.close();
    process.exit(2);
  }

  const username = (await rl.question('账号(手机/邮箱): ')).trim();
  const password = (await rl.question('密码: ')).trim();
  rl.close();
  try {
    const me = await auth.loginPassword(username, password);
    console.log(`✅ 登录成功：${me.username}`);
    const store = (await readline.createInterface({ input: process.stdin, output: process.stdout }).question('保存凭据供自动重登? [y/N]: ')).trim().toLowerCase() === 'y';
    if (store) {
      auth.storeCredentials(username, password);
      console.log('已保存到 auth/credentials.json');
    }
  } catch (e) {
    if (e.name === 'CaptchaRequiredError') {
      console.log('❌ ' + e.message);
      const file = await auth.captchaImage();
      console.log(`验证码图片：${file}，或直接在浏览器打开支持站登录一次后重试（会话会共用）。`);
    } else {
      console.log('❌ ' + e.message);
    }
    process.exit(1);
  }
  process.exit(0);
}

console.log('用法: node cli.mjs [login|whoami] [--qr]');
