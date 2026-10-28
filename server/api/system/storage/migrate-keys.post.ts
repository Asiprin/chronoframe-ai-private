import { eq } from 'drizzle-orm'

/**
 * 存储键前缀迁移：批量重写 photos 表的 storageKey / thumbnailKey /
 * livePhotoVideoKey 中的路径前缀。
 *
 * 典型场景：更换存储方案（如 OpenList → 本地）后，历史文件键带有旧存储的
 * 虚拟路径前缀（如 NAS/File/files/...），导致新方案按旧键找不到文件。
 * 用本工具把旧前缀替换为新前缀（可留空=直接去掉）。
 *
 * 默认 dryRun 只预览影响范围，dryRun: false 才真正写入。
 */
export default eventHandler(async (event) => {
  await requireUserSession(event)

  const body = await readBody(event).catch(() => ({}))
  const normalize = (value: unknown) =>
    typeof value === 'string'
      ? value
          .replace(/\\/g, '/')
          .replace(/\/+/g, '/')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')
      : ''

  const fromPrefix = normalize(body?.fromPrefix)
  const toPrefix = normalize(body?.toPrefix)
  const dryRun = body?.dryRun !== false

  if (!fromPrefix) {
    throw createError({
      statusCode: 400,
      statusMessage: '请填写要替换的键前缀',
    })
  }

  const db = useDB()
  const rows = await db
    .select({
      id: tables.photos.id,
      storageKey: tables.photos.storageKey,
      thumbnailKey: tables.photos.thumbnailKey,
      livePhotoVideoKey: tables.photos.livePhotoVideoKey,
    })
    .from(tables.photos)

  const columns = ['storageKey', 'thumbnailKey', 'livePhotoVideoKey'] as const
  const samples: Array<{ column: string; before: string; after: string }> = []
  const updates: Array<{ id: string; set: Record<string, string> }> = []
  let totalKeys = 0

  for (const row of rows) {
    const set: Record<string, string> = {}
    for (const column of columns) {
      const key = row[column]
      if (typeof key !== 'string' || !key) continue
      const normalizedKey = key.replace(/\\/g, '/').replace(/\/+/g, '/')
      const matches =
        normalizedKey === fromPrefix ||
        normalizedKey.startsWith(`${fromPrefix}/`)
      if (!matches) continue

      const after = `${toPrefix}${normalizedKey.slice(fromPrefix.length)}`
        .replace(/\/{2,}/g, '/')
        .replace(/^\/+/, '')
      set[column] = after
      totalKeys += 1
      if (samples.length < 6) {
        samples.push({ column, before: key, after })
      }
    }
    if (Object.keys(set).length > 0) {
      updates.push({ id: row.id, set })
    }
  }

  if (!dryRun) {
    for (const update of updates) {
      await db
        .update(tables.photos)
        .set(update.set)
        .where(eq(tables.photos.id, update.id))
    }
  }

  return {
    success: true,
    dryRun,
    affectedRows: updates.length,
    totalKeys,
    samples,
  }
})
