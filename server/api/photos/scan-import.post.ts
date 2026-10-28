import path from 'node:path'

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
  const objects = await storageProvider.listAll()
  const candidateKeys = objects
    .map((o) => o.key)
    .filter((key) => {
      const name = path.basename(key)
      if (name.startsWith('.')) return false
      const rel = stripPrefix(key)
      if (rel === 'thumbnails' || rel.startsWith('thumbnails/')) return false
      const ext = getExtension(key)
      return (
        IMAGE_EXTENSIONS.has(ext) ||
        VIDEO_EXTENSIONS.has(ext) ||
        LIVE_PHOTO_VIDEO_EXTENSIONS.has(ext)
      )
    })

  // 2. 与数据库比对，找出未入库的文件
  const db = useDB()
  const existingRows = await db
    .select({ storageKey: tables.photos.storageKey })
    .from(tables.photos)
  const existingKeys = new Set(existingRows.map((row) => row.storageKey))

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
  for (const storageKey of candidateKeys) {
    if (existingKeys.has(storageKey)) continue
    newItems.push({ type: classify(storageKey), storageKey })
  }

  if (newItems.length === 0) {
    return {
      success: true,
      scanned: candidateKeys.length,
      existing: candidateKeys.length,
      queued: 0,
      byType: { photo: 0, video: 0, 'live-photo-video': 0 },
    }
  }

  // 3. 批量投递处理任务（优先级与网页上传一致）
  const workerPool = globalThis.__workerPool
  if (!workerPool) {
    throw createError({
      statusCode: 503,
      statusMessage: '任务队列未就绪，请稍后重试',
    })
  }

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
    scanned: candidateKeys.length,
    existing: candidateKeys.length - newItems.length,
    queued: newItems.length,
    byType,
  }
})
