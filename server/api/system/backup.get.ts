import { createBackupArchive } from '~~/server/services/backup'
import { logger } from '~~/server/utils/logger'

/**
 * GET /api/system/backup?storage=1
 *
 * 下载系统备份 zip（数据库热备份 + 可选的本地存储文件）。
 * 仅管理员可用。
 */
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  if (!session || !session.user.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const includeStorage =
    getQuery(event).storage === '1' || getQuery(event).storage === 'true'

  const ts = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 19)
  setHeader(event, 'Content-Type', 'application/zip')
  setHeader(
    event,
    'Content-Disposition',
    `attachment; filename="chronoframe-backup-${ts}.zip"`,
  )

  try {
    const archive = await createBackupArchive({ includeStorage })
    return sendStream(event, archive)
  } catch (error) {
    logger.dynamic('backup').error('创建备份失败：', error)
    throw createError({
      statusCode: 500,
      statusMessage:
        error instanceof Error ? error.message : '创建备份失败',
    })
  }
})
