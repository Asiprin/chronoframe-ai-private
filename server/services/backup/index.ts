import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from 'fflate'

import {
  getDatabaseFilePath,
  useSqliteDB,
} from '~~/server/utils/db'
import { getStorageManager } from '~~/server/plugins/3.storage'
import { logger } from '~~/server/utils/logger'

const log = logger.dynamic('backup')

export const BACKUP_FORMAT = 1

export interface BackupManifest {
  app: 'chronoframe'
  format: number
  createdAt: string
  database: { file: string }
  storage: { included: boolean; provider?: string; fileCount?: number }
  counts?: { photos?: number }
}

export interface RestoreResult {
  restoredDatabase: boolean
  previousDatabaseBackup: string | null
  restoredStorageFiles: number
  storageIncluded: boolean
  restartRequired: boolean
}

/**
 * 获取本地存储提供商的根目录（仅 local 提供商支持文件备份）
 */
function getLocalStorageRoot(): string | null {
  try {
    const provider = getStorageManager().getProvider()
    const config = provider.config as { basePath?: string } | undefined
    if (config?.basePath) {
      return path.resolve(config.basePath)
    }
  } catch (error) {
    log.warn('获取存储提供商失败', error)
  }
  return null
}

async function countRows(
  sqlite: ReturnType<typeof useSqliteDB>,
  table: string,
): Promise<number> {
  try {
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
      .get() as { c: number }
    return row?.c ?? 0
  } catch {
    return 0
  }
}

/** 递归收集目录下的所有文件（绝对路径） */
async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        out.push(abs)
      }
    }
  }
  await walk(dir)
  return out
}

/** 简单背压闸门：压缩产出过快时暂停读文件 */
class DrainGate {
  private waiters: Array<() => void> = []
  private drained = true

  request() {
    this.drained = false
  }

  release() {
    this.drained = true
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  async wait() {
    if (this.drained) return
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
}

/**
 * 创建备份 zip 流（数据库热备份 + 可选的本地存储文件）。
 *
 * zip 结构：
 *   manifest.json
 *   database/app.sqlite3
 *   storage/...（可选，仅本地存储；照片按原样存储不二次压缩）
 *
 * 返回可直接管道到 HTTP 响应的 Readable。
 */
export async function createBackupArchive(options: {
  includeStorage: boolean
}): Promise<Readable> {
  const sqlite = useSqliteDB()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-backup-'))
  const dbCopyPath = path.join(tempDir, 'app.sqlite3')

  // better-sqlite3 热备份（WAL 模式下安全）
  await sqlite.backup(dbCopyPath)

  const photos = await countRows(sqlite, 'photos')
  const storageRoot = options.includeStorage ? getLocalStorageRoot() : null
  const storageFiles = storageRoot ? await collectFiles(storageRoot) : []

  const manifest: BackupManifest = {
    app: 'chronoframe',
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    database: { file: 'database/app.sqlite3' },
    storage: {
      included: Boolean(storageRoot),
      provider: storageRoot ? 'local' : undefined,
      fileCount: storageRoot ? storageFiles.length : undefined,
    },
    counts: { photos },
  }

  const gate = new DrainGate()
  const readable = new Readable({
    read() {
      gate.release()
    },
  })

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    void rm(tempDir, { recursive: true, force: true })
  }

  const zip = new Zip((err, data, final) => {
    if (err) {
      readable.destroy(err)
      cleanup()
      return
    }
    if (data && data.length > 0) {
      if (!readable.push(Buffer.from(data))) {
        gate.request()
      }
    }
    if (final) {
      readable.push(null)
      cleanup()
    }
  })

  /** 把一个文件按流式塞进 zip；compress=true 时压缩（适合数据库等文本类内容） */
  const addFile = (
    entryName: string,
    filePath: string,
    compress: boolean,
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const entry = compress
        ? new ZipDeflate(entryName, { level: 6 })
        : new ZipPassThrough(entryName)
      zip.add(entry)

      const rs = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 })
      rs.on('data', (chunk) => {
        rs.pause()
        entry.push(new Uint8Array(chunk), false)
        void gate.wait().then(() => rs.resume())
      })
      rs.on('end', () => {
        entry.push(new Uint8Array(0), true)
        resolve()
      })
      rs.on('error', (error) => {
        reject(error)
      })
    })
  }

  // 异步组装（不阻塞返回，错误通过流的 destroy 传递）
  void (async () => {
    try {
      const manifestData = new Uint8Array(
        Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      )
      const manifestEntry = new ZipPassThrough('manifest.json')
      zip.add(manifestEntry)
      manifestEntry.push(manifestData, true)

      await addFile('database/app.sqlite3', dbCopyPath, true)

      if (storageRoot) {
        for (const abs of storageFiles) {
          const rel = path.relative(storageRoot, abs)
          const entryName = `storage/${rel.split(path.sep).join('/')}`
          // 照片/缩略图本身已是压缩格式，直接原样打包（速度优先）
          await addFile(entryName, abs, false)
        }
      }

      zip.end()
    } catch (error) {
      log.error('备份打包失败：', error)
      readable.destroy(
        error instanceof Error ? error : new Error('备份打包失败'),
      )
      cleanup()
    }
  })()

  return readable
}

interface ZipEntryHandler {
  match: (name: string) => boolean
  onEntry: (name: string, data: Buffer) => Promise<void> | void
}

/** 校验 zip 条目路径安全（zip-slip 防护） */
function isSafeEntryName(name: string): boolean {
  return !(
    name.startsWith('/') ||
    name.includes('..') ||
    name.includes('\\') ||
    name.includes(':')
  )
}

/**
 * 流式读取 zip 并把匹配的条目交给 handler（条目数据按单个文件缓存后处理）。
 * 未匹配的条目会被安全地跳过。
 */
function processZipFile(
  zipPath: string,
  handlers: ZipEntryHandler[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const uz = new Unzip()
    uz.register(UnzipInflate)
    uz.register(UnzipPassThrough)

    let failed = false
    let inFlight = 0
    let streamEnded = false
    const fail = (error: Error) => {
      if (failed) return
      failed = true
      rs.destroy()
      reject(error)
    }
    const maybeDone = () => {
      if (!failed && streamEnded && inFlight === 0) resolve()
    }

    uz.onfile = (file) => {
      const name = file.name

      if (!isSafeEntryName(name)) {
        fail(new Error(`备份文件包含非法路径：${name}`))
        return
      }

      const handler = handlers.find((h) => h.match(name))
      if (!handler) {
        // 跳过：仍然消费数据流，避免解压器卡住
        file.ondata = () => {}
        file.start()
        return
      }

      inFlight++
      const chunks: Buffer[] = []
      file.ondata = (err, chunk, final) => {
        if (failed) return
        if (err) {
          fail(err instanceof Error ? err : new Error(String(err)))
          return
        }
        if (chunk && chunk.length > 0) {
          chunks.push(Buffer.from(chunk))
        }
        if (final) {
          void Promise.resolve(
            handler.onEntry(name, Buffer.concat(chunks)),
          )
            .then(() => {
              inFlight--
              maybeDone()
            })
            .catch((error) =>
              fail(
                error instanceof Error
                  ? error
                  : new Error(`处理备份条目失败：${name}`),
              ),
            )
        }
      }
      file.start()
    }

    const rs = fs.createReadStream(zipPath, { highWaterMark: 1024 * 1024 })
    rs.on('data', (chunk) => {
      if (!failed) {
        try {
          uz.push(new Uint8Array(chunk))
        } catch (error) {
          fail(
            error instanceof Error ? error : new Error('备份文件解析失败'),
          )
        }
      }
    })
    rs.on('end', () => {
      streamEnded = true
      maybeDone()
    })
    rs.on('error', fail)
  })
}

/**
 * 从备份 zip 恢复。
 *
 * - 数据库：先热备份当前库为 .bak-<时间戳>，再原子替换（删除陈旧 WAL）
 * - 存储文件：解压 storage/ 到本地存储根目录（覆盖同名文件）
 * - 恢复完成后必须重启服务才会生效（数据库连接与缓存仍在使用旧数据）
 */
export async function restoreBackupArchive(
  zipPath: string,
): Promise<RestoreResult> {
  const dbPath = getDatabaseFilePath()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-restore-'))
  const newDbTemp = path.join(tempDir, 'app.sqlite3')

  let manifest: BackupManifest | null = null
  let dbFound = false
  let restoredStorageFiles = 0

  const storageRoot = getLocalStorageRoot()

  try {
    await processZipFile(zipPath, [
      {
        match: (name) => name === 'manifest.json',
        onEntry: (_name, data) => {
          try {
            manifest = JSON.parse(data.toString('utf-8'))
          } catch {
            throw new Error('备份文件的 manifest.json 解析失败')
          }
        },
      },
      {
        match: (name) => name === 'database/app.sqlite3',
        onEntry: async (_name, data) => {
          await fs.promises.writeFile(newDbTemp, data)
          dbFound = true
        },
      },
      {
        match: (name) => name.startsWith('storage/') && name !== 'storage/',
        onEntry: async (name, data) => {
          if (!storageRoot) return
          const rel = name.slice('storage/'.length)
          const target = path.resolve(storageRoot, rel)
          // 双保险：确保目标路径仍在存储根目录内
          const relCheck = path.relative(storageRoot, target)
          if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new Error(`备份文件包含非法路径：${name}`)
          }
          await mkdir(path.dirname(target), { recursive: true })
          await fs.promises.writeFile(target, data)
          restoredStorageFiles++
        },
      },
    ])

    if (!manifest) {
      throw new Error('备份文件缺少 manifest.json，可能不是 ChronoFrame 备份')
    }
    if (manifest.app !== 'chronoframe') {
      throw new Error('备份文件的 manifest 校验失败（app 字段不匹配）')
    }
    if (manifest.format > BACKUP_FORMAT) {
      throw new Error(
        `备份格式版本 ${manifest.format} 高于当前支持的 ${BACKUP_FORMAT}，请升级后再恢复`,
      )
    }
    if (!dbFound) {
      throw new Error('备份文件缺少 database/app.sqlite3')
    }

    // 保护当前数据库
    let previousDatabaseBackup: string | null = null
    if (fs.existsSync(dbPath)) {
      previousDatabaseBackup = `${dbPath}.bak-${Date.now()}`
      await copyFile(dbPath, previousDatabaseBackup)
    }

    // 原子替换数据库并清理陈旧 WAL/SHM
    await rename(newDbTemp, dbPath)
    await rm(`${dbPath}-wal`, { force: true })
    await rm(`${dbPath}-shm`, { force: true })

    log.success(
      `备份恢复完成：数据库已替换${restoredStorageFiles > 0 ? `，${restoredStorageFiles} 个存储文件已恢复` : ''}（需重启服务生效）`,
    )

    return {
      restoredDatabase: true,
      previousDatabaseBackup,
      restoredStorageFiles,
      storageIncluded: restoredStorageFiles > 0,
      restartRequired: true,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * 校验上传的恢复包基本合法性（zip 可读且非空）
 */
export function validateBackupArchive(zipPath: string): void {
  const size = fs.statSync(zipPath).size
  if (size < 32) {
    throw new Error('备份文件为空或已损坏')
  }
}
