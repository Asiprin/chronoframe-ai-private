#!/usr/bin/env node
/**
 * 构建后修复：把 exiftool-vendored.pl（exiftool 的 Perl 脚本包）补进 .output/server/node_modules。
 *
 * 背景：exiftool-vendored 通过动态 require("exiftool-vendored.pl") 定位 exiftool.pl，
 * Nitro 打包追踪无法发现该动态引用，导致 .output 里缺失此包。
 * 在没有系统 exiftool 的环境（如 macOS 本地）任何 exiftool 调用会永久挂起；
 * Docker 镜像因装有系统 exiftool（apk add exiftool）可回退，但为保证
 * .output 自包含、本地与容器行为一致，构建后统一补齐。
 *
 * ⚠️ 解析锚点必须用 package.json（固定小写文件名）。
 * 不要用 dist/Exiftool.js —— 实际文件名是 ExifTool.js（大写 T），
 * macOS 不区分大小写察觉不到，Linux（Docker 构建）会 ENOENT。
 */
import { cp, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 定位 exiftool-vendored.pl 包的真实目录（多策略兜底，全部大小写安全） */
async function resolvePlPackageDir() {
  // 1) 从 exiftool-vendored 包内部解析它的依赖（pnpm/npm/yarn 布局都适用）
  try {
    const anchor = await realpath(
      path.join(root, 'node_modules/exiftool-vendored/package.json'),
    )
    return path.dirname(createRequire(anchor).resolve('exiftool-vendored.pl'))
  } catch {
    /* 尝试下一策略 */
  }
  // 2) pnpm 布局兜底：真实包目录的同级
  try {
    const vendoredDir = await realpath(
      path.join(root, 'node_modules/exiftool-vendored'),
    )
    const sibling = path.join(path.dirname(vendoredDir), 'exiftool-vendored.pl')
    await stat(path.join(sibling, 'package.json'))
    return sibling
  } catch {
    /* 尝试下一策略 */
  }
  // 3) 依赖提升布局兜底：根 node_modules
  try {
    return path.dirname(
      createRequire(path.join(root, 'package.json')).resolve(
        'exiftool-vendored.pl',
      ),
    )
  } catch {
    /* 全部失败 */
  }
  return null
}

const src = await resolvePlPackageDir()
if (!src) {
  console.warn('[fixup] 未找到 exiftool-vendored.pl 依赖，跳过。')
  console.warn(
    '[fixup] Docker 构建可忽略（镜像内有系统 exiftool 兜底）；macOS 本地构建请检查 node_modules 后重试。',
  )
  process.exit(0)
}

const dest = path.join(root, '.output/server/node_modules/exiftool-vendored.pl')
await mkdir(path.dirname(dest), { recursive: true })
await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log(`[fixup] exiftool-vendored.pl 已补齐到 ${path.relative(root, dest)}`)
