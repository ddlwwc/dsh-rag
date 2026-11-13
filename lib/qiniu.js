// dsh-rag — 七牛云上传通道（零依赖：node:crypto + 全局 fetch）
//
// 附件默认存本地（/rag/asset 路由）；本模块只是可选的 CDN 通道。
// 配置来自 <DSH_HOME>/rag/config.json 的 qiniu 段；secretKey 只在宿主进程里使用，
// 绝不出现在返回值或任何错误信息中。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/** 七牛直传域名只认这些 region，其余一律走通用域名。 */
const UPLOAD_REGIONS = new Set(['z0', 'z1', 'z2', 'na0', 'as0', 'sgpo']);

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/** base64url，无 padding。 */
function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function need(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`七牛配置缺少 ${name}`);
  }
  return value;
}

/**
 * 用 secretKey 对 encodedPolicy 做 HMAC-SHA1，返回 base64url（无 padding）。
 * 单独导出便于单测，不做任何配置校验。
 */
export function signPolicy(encodedPolicy, secretKey) {
  return b64url(createHmac('sha1', secretKey).update(encodedPolicy).digest());
}

/**
 * 生成七牛上传凭证。
 * @returns {string} `${accessKey}:${encodedSign}:${encodedPolicy}`
 */
export function uploadToken({ accessKey, secretKey, bucket, key, expires = 3600, returnBody } = {}) {
  need(accessKey, 'accessKey');
  need(secretKey, 'secretKey');
  need(bucket, 'bucket');
  need(key, 'key');

  const putPolicy = {
    scope: `${bucket}:${key}`,
    deadline: Math.floor(Date.now() / 1000) + expires,
  };
  if (returnBody !== undefined) putPolicy.returnBody = returnBody;

  const encodedPolicy = b64url(JSON.stringify(putPolicy));
  const encodedSign = signPolicy(encodedPolicy, secretKey);
  return `${accessKey}:${encodedSign}:${encodedPolicy}`;
}

function uploadEndpoint(region) {
  return UPLOAD_REGIONS.has(region)
    ? `https://up-${region}.qiniup.com`
    : 'https://upload.qiniup.com';
}

/**
 * 上传内存中的 Buffer 到七牛。
 * @returns {Promise<{url: string, key: string}>}
 */
export async function uploadBuffer(config, { key, buffer, mime } = {}) {
  const cfg = config || {};
  if (!cfg.enabled) throw new Error('七牛未启用');
  need(cfg.bucket, 'bucket');
  need(cfg.domain, 'domain');
  if (!key) throw new Error('七牛上传缺少 key');
  if (!buffer) throw new Error('七牛上传缺少 buffer');

  const token = uploadToken({
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    bucket: cfg.bucket,
    key,
    expires: cfg.expires ?? 3600,
  });

  const form = new FormData();
  form.append('token', token);
  form.append('key', key);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), basename(key) || 'file');

  let res;
  try {
    res = await fetch(uploadEndpoint(cfg.region), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // fetch 的报错只含网络层信息；这里再包一层，保证不带出任何凭据。
    const reason = err?.name === 'TimeoutError' ? '请求超时（10s）' : (err?.message || String(err));
    throw new Error(`七牛上传失败：${reason}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`七牛上传失败：HTTP ${res.status} ${text.slice(0, 500)}`);
  }

  const domain = String(cfg.domain).replace(/\/$/, '');
  return { url: `${domain}/${encodeURI(key)}`, key };
}

/**
 * 上传本地文件；key 缺省为 prefix + sha256(buffer).slice(0,16) + 扩展名。
 */
export async function uploadFile(config, absPath, { key } = {}) {
  const buffer = await readFile(absPath);
  const ext = extname(absPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const finalKey = key || `${config?.prefix || ''}${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}${ext}`;
  return uploadBuffer(config, { key: finalKey, buffer, mime });
}

/** 随机对象名：prefix + 16 字节 base64url + ext（ext 可为 '.png' 或 'png'）。 */
export function randomKey(prefix = '', ext = '') {
  const suffix = b64url(randomBytes(16));
  const dotExt = ext && !ext.startsWith('.') ? `.${ext}` : ext;
  return `${prefix || ''}${suffix}${dotExt || ''}`;
}
