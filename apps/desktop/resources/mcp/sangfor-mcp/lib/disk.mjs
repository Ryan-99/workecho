import fs from 'node:fs';
import path from 'node:path';

export class NoSpaceError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NoSpaceError';
  }
}

async function freeBytes(dir) {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

export async function driveFree(driveRoot) {
  try {
    return await freeBytes(driveRoot);
  } catch {
    return -1;
  }
}

/**
 * 选下载目录：优先 prefer（用户/默认下载目录，无条件尊重——即使在系统盘），
 * 空间不够时挑剩余空间最大的非系统盘备选（C: 不作备选）。
 * needBytes = 预期文件大小。返回 {dir, free}，找不到合格目录抛 NoSpaceError（附各盘余量报告）。
 */
export async function chooseDestDir({ needBytes = 0, prefer } = {}) {
  const margin = needBytes * 0.15 + 512 * 1024 * 1024; // 15% + 512MB 余量
  const preferResolved = prefer ? path.resolve(prefer).toLowerCase() : null;
  const candidates = [];
  if (prefer) candidates.push({ dir: prefer, label: '下载目录', isPrefer: true });

  // 枚举非 C 盘符（D: 起），空间不够下载目录时作为备选
  const drives = [];
  for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${L}:\\`;
    if (fs.existsSync(root)) drives.push(root);
  }
  const driveFrees = [];
  for (const root of drives) {
    const free = await driveFree(root);
    if (free > 0) driveFrees.push({ root, free });
  }
  driveFrees.sort((a, b) => b.free - a.free);
  for (const d of driveFrees) {
    const dir = path.join(d.root, 'Download', 'Sangfor');
    if (!candidates.some((c) => path.resolve(c.dir).toLowerCase() === path.resolve(dir).toLowerCase())) {
      candidates.push({ dir, label: `${d.root} 备选`, isPrefer: false });
    }
  }

  const report = [];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c.dir, { recursive: true });
      const free = await freeBytes(c.dir);
      report.push(`${c.dir}  空闲 ${fmtGB(free)}`);
      const drive = c.dir.slice(0, 2).toUpperCase();
      if (drive === 'C:' && !c.isPrefer) continue; // 系统盘只作为用户显式指定的下载目录，不作备选
      if (free >= needBytes + margin) return { dir: c.dir, free };
    } catch {
      /* 目录不可用（无权限等），跳过 */
    }
  }
  const allDrives = [
    ...driveFrees.map((d) => `${d.root} 空闲 ${fmtGB(d.free)}`),
    `C: ${prefer && preferResolved?.startsWith('c:') ? '（首选下载目录所在盘，空间不足）' : '（不作备选）'}`,
  ];
  throw new NoSpaceError(
    `磁盘空间不足：需要约 ${fmtGB(needBytes + margin)}。\n各盘余量：\n  ${allDrives.join('\n  ')}\n请清理空间后重试，或用 save_dir 指定其他目录。`
  );
}

function fmtGB(n) {
  return (n / 1024 ** 3).toFixed(1) + 'GB';
}
