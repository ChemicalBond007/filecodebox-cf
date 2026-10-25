// FileCodeBox-CF · 全局配置与常量
// 该文件不依赖任何外部包，纯 Web 标准 API 即可运行。

// 取件码字符集：去掉易混淆字符 0/O/1/l/I
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8; // 取件码长度
export const CODE_GROUP = 4; // 每 4 位插入一个连字符，便于口述

// 过期时间档位（毫秒），供前端下拉与后端换算共用
export const EXPIRE_PRESETS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  forever: 0, // 0 代表永久
};

// 下载次数档位：0 = 不限
export const DOWNLOAD_PRESETS = [1, 10, 100, 0];

// 文件直链 token 有效期（毫秒），仅作轻量防直链，过期后需重新取件
export const FILE_TOKEN_TTL = 10 * 60 * 1000;
export const MAX_TEXT_BYTES = 222 * 1024; // UTF-8 字节，222 KiB，不是字符数
export const MAX_SHARE_BODY_BYTES = MAX_TEXT_BYTES * 6 + 64 * 1024; // JSON 转义最多放大六倍
export const MAX_CLAIM_BODY_BYTES = 16 * 1024;
export const PASSWORD_WINDOW_MS = 5 * 60 * 1000;
export const PASSWORD_PAIR_LIMIT = 5;
export const PASSWORD_CODE_LIMIT = 30;
export const AUTO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function appName(env) {
  return env.APP_NAME || '文件快递柜';
}

export function appSubtitle(env) {
  return env.APP_SUBTITLE || '像取快递一样取文件 · Powered by Cloudflare + ImgBed';
}
