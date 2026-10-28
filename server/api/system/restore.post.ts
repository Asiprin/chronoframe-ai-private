import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  restoreBackupArchive,
  validateBackupArchive,
} from '~~/server/services/backup'
import { logger } from '~~/server/utils/logger'

// 恢复包大小上限（防止磁盘被打满）
const MAX_RESTORE_BYTES = 100 * 1024 * 1024 * 1024

/**
 * POST /api/system/restore
 *
 * 上传备份 zip 并恢复（body 为原始 zip 字节流）。
 * 恢复会覆盖当前数据库与本地存储文件，需重启服务后生效。
 * 仅管理员可用。
 */
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  if (!session || !session.user.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const contentLengthHeader = getHeader(event, 'content-length')
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN
  if (Number.isFinite(contentLength) && contentLength > MAX_RESTORE_BYTES) {
    throw createError({ statusCode: 413, statusMessage: '恢复包过大' })
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-restore-upload-'))
  const zipPath = path.join(tempDir, 'backup.zip')

  try {
    let received = 0
    const write = fs.createWriteStream(zipPath)
    event.node.req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_RESTORE_BYTES) {
        event.node.req.destroy()
        write.destroy(new Error('恢复包过大'))
      }
    })
    await pipeline(event.node.req, write)

    validateBackupArchive(zipPath)

    const result = await restoreBackupArchive(zipPath)

    return {
      success: true,
      ...result,
      message: `恢复完成${result.restoredStorageFiles > 0 ? `（含 ${result.restoredStorageFiles} 个文件）` : ''}，请重启服务后生效`,
    }
  } catch (error: any) {
    logger.dynamic('backup').error('恢复备份失败：', error)
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : '恢复备份失败',
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
