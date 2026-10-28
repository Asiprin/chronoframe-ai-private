import path from 'node:path'
import { and, eq, isNull, or, sql } from 'drizzle-orm'

/**
 * 扫描导入：把直接拷贝进存储目录的媒体文件批量入库。
 *
 * 遍历存储目录中所有媒体文件，与数据库比对，为"存在但未入库"的文件
 * 投递处理任务。后续管线（缩略图 / EXIF / 入库 / AI 元数据）与网页上传
 * 完全一致。重复执行安全：已入库的文件自动跳过。
 */

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif',
  '.hdr',
  '.exr',
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.avi',
  '.mkv',
  '.webm',
  '.flv',
  '.wmv',
  '.m4v',
  '.3gp',
  '.mpeg',
  '.mpg',
])
// 与 app/libs/upload-task-classifier.ts 的实况照片判断保持一致
const LIVE_PHOTO_VIDEO_EXTENSIONS = new Set(['.mov'])
const LIVE_PHOTO_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.jpg', '.jpeg'])

type ScanTaskType = 'photo' | 'video' | 'live-photo-video'

const getExtension = (key: string) => path.extname(key).toLowerCase()

/** 比对用的归一化：统一斜杠并去掉开头的 /（容忍历史数据里的前导斜杠差异） */
const normalizeKey = (key: string) =>
  key.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')

const getPairId = (key: string) => {
  const ext = path.extname(key)
  const dir = path.dirname(key)
  const base = path.basename(key, ext).toLowerCase()
  return `${dir}/${base}`
}

export default eventHandler(async (event) => {
  await requireUserSession(event)

  const { storageProvider } = useStorageProvider(event)

  // listAll 返回的 key 与数据库 storageKey 格式一致（含 prefix），直接使用
  const prefix = ((storageProvider.config?.prefix as string) || '').replace(
    /^\/+|\/+$/g,
    '',
  )
  const stripPrefix = (key: string) => {
    if (prefix && (key === prefix || key.startsWith(`${prefix}/`))) {
      return key.slice(prefix.length).replace(/^\//, '')
    }
    return key
  }

  // 1. 枚举存储目录中的候选媒体文件（跳过缩略图目录与隐藏文件）
  let objects
  try {
    objects = await storageProvider.listAll()
  } catch {
    throw createError({
      statusCode: 502,
      statusMessage: '无法获取文件列表，请检查存储设置',
    })
  }

  const candidateKeys = objects
    .map((o) => o.key)
    .filter((key) => {
      const name = path.basename(key)
      if (name.startsWith('.')) return false
      // 缩略图目录排除：兼容任意存储布局（本地 photos/thumbnails/、
      // OpenList .../photos/thumbnails/ 等），认"父目录名为 thumbnails"
      const parent = path.basename(path.dirname(key))
      if (parent === 'thumbnails') return false
      const rel = stripPrefix(key)
      if (rel === 'thumbnails' || rel.startsWith('thumbnails/')) return false
      const ext = getExtension(key)
      return (
        IMAGE_EXTENSIONS.has(ext) ||
        VIDEO_EXTENSIONS.has(ext) ||
        LIVE_PHOTO_VIDEO_EXTENSIONS.has(ext)
      )
    })
  const candidateSet = new Set(candidateKeys)

  // 2. 与数据库比对，找出未入库的文件（归一化 key，容忍前导斜杠差异）
  const db = useDB()
  const existingRows = await db
    .select({
      storageKey: tables.photos.storageKey,
      fileSize: tables.photos.fileSize,
    })
    .from(tables.photos)

  // 存储里一个文件都没枚举到、库里却有照片 → 多半是存储列表不可用，给明确报错
  if (objects.length === 0 && existingRows.length > 0) {
    throw createError({
      statusCode: 422,
      statusMessage: '未能发现照片文件，请检查存储设置和照片目录',
    })
  }

  const existingMap = new Map(
    existingRows.map((row) => [normalizeKey(row.storageKey), row.fileSize]),
  )
  // 同名同大小指纹（文件键前缀错位时防重复导入已有照片）
  const existingFingerprints = new Set(
    existingRows
      .filter((row) => typeof row.fileSize === 'number')
      .map(
        (row) => `${path.basename(normalizeKey(row.storageKey))}|${row.fileSize}`,
      ),
  )

  // 实况照片配对集合：同目录同名的图片（照抄上传分类器的语义）
  const liveImagePairIds = new Set(
    candidateKeys
      .filter((key) => LIVE_PHOTO_IMAGE_EXTENSIONS.has(getExtension(key)))
      .map((key) => getPairId(key)),
  )

  const classify = (key: string): ScanTaskType => {
    const ext = getExtension(key)
    if (VIDEO_EXTENSIONS.has(ext)) return 'video'
    if (LIVE_PHOTO_VIDEO_EXTENSIONS.has(ext)) {
      return liveImagePairIds.has(getPairId(key)) ? 'live-photo-video' : 'video'
    }
    return 'photo'
  }

  const newItems: Array<{ type: ScanTaskType; storageKey: string }> = []
  let existingCount = 0
  let conflictCount = 0
  for (const obj of objects) {
    const storageKey = obj.key
    if (!candidateSet.has(storageKey)) continue
    const hit = existingMap.get(normalizeKey(storageKey))
    if (hit !== undefined) {
      existingCount += 1
      // 同名但大小与入库记录不同 → 大概率是另一个文件，需重命名才能导入
      if (typeof hit === 'number' && obj.size != null && hit !== obj.size) {
        conflictCount += 1
      }
      continue
    }
    // 键不匹配但同名同大小 → 已入库照片（存储键前缀错位），绝不重复导入
    const fingerprint = `${path.basename(normalizeKey(storageKey))}|${obj.size ?? -1}`
    if (existingFingerprints.has(fingerprint)) {
      existingCount += 1
      continue
    }
    newItems.push({ type: classify(storageKey), storageKey })
  }

  // 提示用目录：优先取现有照片的公共目录（跨存储布局都能显示真实路径），
  // 无现有照片时退回存储 prefix 配置
  const commonDir = (() => {
    const dirs = existingRows.map((row) =>
      normalizeKey(row.storageKey).split('/').slice(0, -1).join('/'),
    )
    if (dirs.length === 0) return ''
    let common = dirs[0]
    for (const dir of dirs.slice(1)) {
      while (common && dir !== common && !dir.startsWith(`${common}/`)) {
        common = common.split('/').slice(0, -1).join('/')
      }
    }
    return common
  })()
  const scanRoot = commonDir || (storageProvider.config?.prefix as string) || ''

  const workerPool = globalThis.__workerPool
  if (!workerPool) {
    throw createError({
      statusCode: 503,
      statusMessage: '任务队列未就绪，请稍后重试',
    })
  }

  // 3. AI 补全：库里缺少描述的照片（含刚导入的走照片管线自动生成）。
  // 只投"补空字段"任务（不带 force）——已编辑描述的照片天然被跳过。
  const needAiRows = await db
    .select({ id: tables.photos.id })
    .from(tables.photos)
    .where(
      and(
        or(
          isNull(tables.photos.description),
          eq(tables.photos.description, ''),
        ),
        sql`COALESCE(${tables.photos.isVideo}, 0) != 1`,
      ),
    )
  let aiQueued = 0
  for (const row of needAiRows) {
    await workerPool.addTask(
      { type: 'photo-ai-metadata', photoId: row.id },
      { priority: 1, maxAttempts: 3 },
    )
    aiQueued += 1
  }

  if (newItems.length === 0) {
    return {
      success: true,
      scanned: candidateSet.size,
      existing: existingCount,
      queued: 0,
      aiQueued,
      conflicts: conflictCount,
      scanRoot,
    }
  }

  // 4. 批量投递处理任务（优先级与网页上传一致）
  const byType = { photo: 0, video: 0, 'live-photo-video': 0 }
  for (const item of newItems) {
    await workerPool.addTask(
      { type: item.type, storageKey: item.storageKey },
      {
        priority: item.type === 'photo' ? 1 : 0,
        maxAttempts: 3,
      },
    )
    byType[item.type] += 1
  }

  return {
    success: true,
    scanned: candidateSet.size,
    existing: existingCount,
    queued: newItems.length,
    aiQueued,
    conflicts: conflictCount,
    scanRoot,
    byType,
  }
})
