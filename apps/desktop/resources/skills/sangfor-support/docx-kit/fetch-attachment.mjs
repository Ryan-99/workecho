import { loadSession } from '../lib/auth.mjs';
import { cookieHeader } from '../lib/http.mjs';
import fs from 'node:fs';
await loadSession();
let u = process.argv[2];
if (u.startsWith('/')) u = 'https://support.sangfor.com.cn' + u;
const out = process.argv[3];
for (let hop = 0; hop < 6; hop++) {
  const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', cookie: cookieHeader(new URL(u).hostname), referer: 'https://support.sangfor.com.cn/' }, redirect: 'manual' });
  const loc = res.headers.get('location');
  if (loc) { u = new URL(loc, u).href; console.error('redirect ->', u); continue; }
  if (!res.ok) { console.error('HTTP', res.status); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log('saved', out, buf.length, 'bytes |', res.headers.get('content-type'));
  break;
}
