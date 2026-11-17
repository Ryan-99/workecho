import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MCP_HOME 用于会话/凭据存放位置，默认项目目录（本机使用，不出网）
export const MCP_HOME = process.env.SANGFOR_MCP_HOME || path.resolve(__dirname, '..');
export const AUTH_DIR = path.join(MCP_HOME, 'auth');
export const SESSION_FILE = path.join(AUTH_DIR, 'session.json');
export const CREDENTIALS_FILE = path.join(AUTH_DIR, 'credentials.json');
fs.mkdirSync(AUTH_DIR, { recursive: true });

export const BASE = 'https://support.sangfor.com.cn';
export const BBS_BASE = 'https://bbs.sangfor.com.cn';
// 站点 axios 约定的请求头
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const BASE_HEADERS = {
  'User-Agent': UA,
  'X-Requested-With': 'xmlhttprequest',
  'HTTP_X_REQUESTED_WITH': 'xmlhttprequest',
  'Accept': 'application/vnd.edusoho.v2+json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

// 下载默认落盘目录：当前用户系统下载文件夹（每台机器各自的，不绑定特定用户名）；
// 可用环境变量 SANGFOR_DOWNLOAD_DIR 覆盖（如个人偏好放数据盘）。
export const DEFAULT_DOWNLOAD_DIR =
  process.env.SANGFOR_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads');

// 信封约定：200/0/666 视为成功；40701 = 未登录（40002 = 参数缺失，由 unwrap 按 message 区分）
export const OK_CODES = [200, 0, 666];
export const AUTH_CODES = [40701, 40002];
