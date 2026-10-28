#!/usr/bin/env node
/**
 * 构建后修复：把 exiftool-vendored.pl（exiftool 的 Perl 脚本包）补进 .output/server/node_modules。
 *
 * 背景：exiftool-vendored 通过动态 require("exiftool-vendored.pl") 定位 exiftool.pl，
 * Nitro 打包追踪无法发现该动态引用，导致 .output 里缺失此包。
 * 在没有系统 exiftool 的环境（如 macOS 本地）任何 exiftool 调用会永久挂起；
 * Docker 镜像因装有系统 exiftool（apk add exiftool）会自动回退，不受影响。
 * 为保证 .output 自包含、本地与容器行为一致，构建后统一补齐。
 */
import { cp, mkdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 从 exiftool-vendored 的上下文解析其依赖 exiftool-vendored.pl 的真实路径。
// 注意：pnpm 顶层是符号链接，必须用 realpath 定位到 .pnpm 真实目录，
// 否则 require 的 node_modules 逐级查找会落空。
const requireFromVendored = createRequire(
  await realpath(
    path.join(root, 'node_modules/exiftool-vendored/dist/Exiftool.js'),
  ),
)

let src
try {
  src = path.dirname(requireFromVendored.resolve('exiftool-vendored.pl'))
} catch {
  console.warn('[fixup] 未找到 exiftool-vendored.pl 依赖，跳过（如运行在 Docker 中可忽略）')
  process.exit(0)
}

const dest = path.join(root, '.output/server/node_modules/exiftool-vendored.pl')
await mkdir(path.dirname(dest), { recursive: true })
await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true })
console.log(`[fixup] exiftool-vendored.pl 已补齐到 ${path.relative(root, dest)}`)
