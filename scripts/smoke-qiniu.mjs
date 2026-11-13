// 七牛模块自测：不发任何网络请求。
// 运行：node scripts/smoke-qiniu.mjs   （成功输出 OK，退出码 0）
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { uploadBuffer, uploadToken, signPolicy, randomKey } from '../lib/qiniu.js';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 硬保证：任何意外触网都会让自测失败，而不是静默发出请求。
globalThis.fetch = () => { throw new Error('smoke 不应发起网络请求'); };

// —— 1. 固定输入断言真实 token（用 Python 独立算过一遍） ——
const AK = 'test-ak';
const SK = 'test-sk';
const BUCKET = 'demo';
const KEY = 'dsh-rag/x.png';
const FROZEN_NOW = 1_700_000_000_000; // deadline = 1700003600
const EXPECTED_POLICY = '{"scope":"demo:dsh-rag/x.png","deadline":1700003600}';
const EXPECTED_ENCODED_POLICY = 'eyJzY29wZSI6ImRlbW86ZHNoLXJhZy94LnBuZyIsImRlYWRsaW5lIjoxNzAwMDAzNjAwfQ';
const EXPECTED_SIGN = 'HYnqVHF6VchT7eAz2DcfGEoHnqQ';
const EXPECTED_TOKEN = `${AK}:${EXPECTED_SIGN}:${EXPECTED_ENCODED_POLICY}`;

const realNow = Date.now;
Date.now = () => FROZEN_NOW;
let token;
try {
  token = uploadToken({ accessKey: AK, secretKey: SK, bucket: BUCKET, key: KEY, expires: 3600 });
} finally {
  Date.now = realNow;
}
assert.equal(token, EXPECTED_TOKEN, 'token 与独立计算的固定值不一致');

// token 结构 + 独立复算 HMAC-SHA1
const [ak, sign, encodedPolicy] = token.split(':');
assert.equal(ak, AK);
assert.equal(encodedPolicy, EXPECTED_ENCODED_POLICY);
assert.equal(Buffer.from(encodedPolicy, 'base64url').toString('utf8'), EXPECTED_POLICY);
assert.equal(sign, b64url(createHmac('sha1', SK).update(encodedPolicy).digest()), '签名独立复算不一致');
assert.equal(sign, signPolicy(encodedPolicy, SK), 'signPolicy 与 token 内签名不一致');

// base64url 必须无 padding、只用 URL 安全字符
assert.doesNotMatch(sign, /=/, 'encodedSign 不应带 padding');
assert.doesNotMatch(encodedPolicy, /=/, 'encodedPolicy 不应带 padding');
assert.match(sign, /^[A-Za-z0-9_-]+$/);
assert.match(encodedPolicy, /^[A-Za-z0-9_-]+$/);

// returnBody 参与策略时也保持 tiny JSON（固定输入）
const withBody = uploadToken({
  accessKey: AK, secretKey: SK, bucket: BUCKET, key: KEY, expires: 60, returnBody: { key: '$(key)' },
});
const bodyPolicy = JSON.parse(Buffer.from(withBody.split(':')[2], 'base64url').toString('utf8'));
assert.deepEqual(bodyPolicy, { scope: 'demo:dsh-rag/x.png', deadline: Math.floor(realNow() / 1000) + 60, returnBody: { key: '$(key)' } });
assert.equal(withBody.split(':')[1], b64url(createHmac('sha1', SK).update(withBody.split(':')[2]).digest()));

// —— 2. randomKey 形态 ——
const rk = randomKey('imgs/', '.webp');
assert.match(rk, /^imgs\/[A-Za-z0-9_-]{22}\.webp$/, `randomKey 形态异常: ${rk}`);
assert.notEqual(rk, randomKey('imgs/', '.webp'), 'randomKey 不应重复');
assert.match(randomKey('', 'png'), /^[A-Za-z0-9_-]{22}\.png$/);
assert.match(randomKey('p/'), /^p\/[A-Za-z0-9_-]{22}$/);

// —— 3. 错误路径（全部在发请求之前抛错，不触网） ——
await assert.rejects(() => uploadBuffer({ enabled: false }, { key: KEY, buffer: Buffer.from('x') }), /^Error: 七牛未启用$/);
await assert.rejects(() => uploadBuffer({ enabled: true, accessKey: AK, secretKey: SK, domain: 'https://cdn.example.com' }, { key: KEY, buffer: Buffer.from('x') }), /七牛配置缺少 bucket/);

// 任何错误信息都不得包含 secretKey
const errs = [];
for (const config of [
  { enabled: true, accessKey: AK, secretKey: SK, bucket: BUCKET, key: KEY, domain: 'https://cdn.example.com', accessKeyMissing: true },
]) {
  try {
    await uploadBuffer({ ...config, accessKey: '' }, { key: KEY, buffer: Buffer.from('x') });
  } catch (err) { errs.push(err.message); }
}
try { uploadToken({ accessKey: AK, secretKey: SK, bucket: BUCKET }); } catch (err) { errs.push(err.message); }
assert.ok(errs.length > 0);
for (const msg of errs) assert.ok(!msg.includes(SK), `错误信息泄露了 secretKey: ${msg}`);

console.log('OK');
