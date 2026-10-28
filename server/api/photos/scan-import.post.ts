import path from 'node:path'
import { sql } from 'drizzle-orm'
import { generateSafePhotoId } from '~~/server/utils/file-utils'
import { deriveTitleFromFileName } from '~~/server/services/image/exif'

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

  // 2. 与数据库比对（多键去重：任一文件键命中即视为已入库）
  const db = useDB()
  const existingRows = await db
    .select({
      id: tables.photos.id,
      storageKey: tables.photos.storageKey,
      thumbnailKey: tables.photos.thumbnailKey,
      livePhotoVideoKey: tables.photos.livePhotoVideoKey,
      fileSize: tables.photos.fileSize,
    })
    .from(tables.photos)

  // 存储里一个文件都没枚举到、库里却有照片 → 大概率是存储列表不可用，给明确报错
  if (objects.length === 0 && existingRows.length > 0) {
    throw createError({
      statusCode: 422,
      statusMessage: '未能发现照片文件，请检查存储设置和照片目录',
    })
  }

  // 库内全部文件键（原图/缩略图/实况视频），以及 storageKey→大小（冲突检测用）
  const knownKeys = new Set<string>()
  const storageKeySizes = new Map<string, number | null>()
  for (const row of existingRows) {
    for (const k of [
      row.storageKey,
      row.thumbnailKey,
      row.livePhotoVideoKey,
    ]) {
      if (typeof k === 'string' && k) knownKeys.add(normalizeKey(k))
    }
    if (row.storageKey) {
      storageKeySizes.set(normalizeKey(row.storageKey), row.fileSize ?? null)
    }
  }

  // photoId 判定：jpg/mp4 等同名文件会生成同一 photoId（库中已有即绝不重复导入）
  const knownIds = new Set(existingRows.map((row) => row.id))

  // 任务记录判定（任意状态，含已完成/失败/排队中）：进过队列的文件不再重复入队
  const taskRows = await db
    .select({ payload: tables.pipelineQueue.payload })
    .from(tables.pipelineQueue)
  const taskKeys = new Set<string>()
  const aiTaskPhotoIds = new Set<string>()
  for (const row of taskRows) {
    const payload = row.payload as Record<string, unknown> | null
    if (!payload || typeof payload !== 'object') continue
    if (typeof payload.storageKey === 'string' && payload.storageKey) {
      taskKeys.add(normalizeKey(payload.storageKey))
    }
    if (
      payload.type === 'photo-ai-metadata' &&
      typeof payload.photoId === 'string'
    ) {
      aiTaskPhotoIds.add(payload.photoId)
    }
  }

  // 同名同大小指纹（文件键前缀错位时防重复导入已有照片）
  const existingFingerprints = new Set(
    existingRows
      .filter((row) => typeof row.fileSize === 'number')
      .map(
        (row) =>
          `${path.basename(normalizeKey(row.storageKey || ''))}|${row.fileSize}`,
      ),
  )

  // 图片同名（含库内）判定：用于伴生视频归类
  const imageStems = new Set(
    [...candidateKeys, ...knownKeys]
      .filter((key) =>
        LIVE_PHOTO_IMAGE_EXTENSIONS.has(getExtension(String(key))),
      )
      .map((key) => getPairId(String(key))),
  )

  const classify = (key: string): ScanTaskType => {
    const ext = getExtension(key)
    if (
      VIDEO_EXTENSIONS.has(ext) ||
      LIVE_PHOTO_VIDEO_EXTENSIONS.has(ext)
    ) {
      // 同名图片存在 → 伴生视频（Motion Photo/Live Photo 的视频部分），
      // 归为实况视频配对，不作为独立视频入库
      return imageStems.has(getPairId(key))
        ? 'live-photo-video'
        : 'video'
    }
    return 'photo'
  }

  const newItems: Array<{ type: ScanTaskType; storageKey: string }> = []
  let existingCount = 0
  let conflictCount = 0
  for (const obj of objects) {
    const storageKey = obj.key
    if (!candidateSet.has(storageKey)) continue
    const normKey = normalizeKey(storageKey)

    // 四重判定，任一命中即视为已入库/已排队：
    // ① 库内文件键（原图/缩略图/实况视频） ② photoId（同名文件撞同 id）
    // ③ 任务记录（进过队列的文件，含已完成/失败） ④ 同名同大小指纹（键错位兜底）
    const inLibrary = knownKeys.has(normKey)
    const hit = storageKeySizes.get(normKey)
    if (
      inLibrary ||
      hit !== undefined ||
      knownIds.has(generateSafePhotoId(storageKey)) ||
      taskKeys.has(normKey)
    ) {
      existingCount += 1
      // 同名但大小与入库记录不同 → 大概率是另一个文件，需重命名才能导入
      if (typeof hit === 'number' && obj.size != null && hit !== obj.size) {
        conflictCount += 1
      }
      continue
    }
    const fingerprint = `${path.basename(normKey)}|${obj.size ?? -1}`
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
    .select({
      id: tables.photos.id,
      storageKey: tables.photos.storageKey,
      title: tables.photos.title,
      description: tables.photos.description,
    })
    .from(tables.photos)
    .where(sql`COALESCE(${tables.photos.isVideo}, 0) != 1`)
  let aiQueued = 0
  for (const row of needAiRows) {
    // 只处理"未生成标题和描述"的照片（缺标题或缺描述），
    // 已处理过/已有任务记录的绝不重复入队
    const missingTitle =
      !row.title || row.title === deriveTitleFromFileName(row.storageKey || '')
    const missingDescription = !row.description
    if (!missingTitle && !missingDescription) continue
    if (aiTaskPhotoIds.has(row.id)) continue
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
