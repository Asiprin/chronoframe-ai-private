import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { exiftool } from 'exiftool-vendored'

import { extractExifData } from '~~/server/services/image/exif'
import type { StorageProvider } from '~~/server/services/storage/interfaces'
import type { Photo } from '~~/server/utils/db'
import type { NeededExif } from '~~/shared/types/photo'

/**
 * 保留全景图相关的 EXIF 字段（exiftool 重写文件时可能丢失）
 * 与 server/api/photos/[photoId]/index.put.ts 中的逻辑保持一致
 */
const preservePanoramaExif = (exif: NeededExif | null | undefined) => {
  if (!exif) return {}
  const keys: Array<keyof NeededExif> = [
    'GPanoUsePanoramaViewer',
    'GPanoProjectionType',
    'GPanoFullPanoWidthPixels',
    'GPanoFullPanoHeightPixels',
    'GPanoCroppedAreaImageWidthPixels',
    'GPanoCroppedAreaImageHeightPixels',
    'GPanoCroppedAreaLeftPixels',
    'GPanoCroppedAreaTopPixels',
    'PanoramaDetected',
    'PanoramaConfidence',
    'PanoramaDetectionMethod',
    'PanoramaSeamSimilarity',
  ]

  const out: Partial<NeededExif> = {}
  for (const key of keys) {
    const value = exif[key]
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export interface ExifWriteBackResult {
  exif: NeededExif | null
  fileSize: number
}

/**
 * 把 AI 生成的标题/描述/标签写回原图 EXIF，并重新上传到存储。
 *
 * - 仅处理传入的字段（undefined 表示不改动）
 * - HDR/EXR 等不支持内嵌元数据的格式直接跳过，返回 null
 * - 写回后会重新提取 EXIF 并保留全景字段
 *
 * 注意：调用方应自行 try/catch，写回失败不应影响数据库更新结果。
 */
export async function writeMetadataToExif(options: {
  storageProvider: StorageProvider
  photo: Pick<Photo, 'storageKey' | 'exif'>
  metadata: {
    title?: string | null
    description?: string | null
    tags?: string[] | null
  }
}): Promise<ExifWriteBackResult | null> {
  const { storageProvider, photo, metadata } = options

  const ext = path.extname(photo.storageKey || '').toLowerCase()
  if (ext === '.hdr' || ext === '.exr') {
    return null
  }

  const originalBuffer = await storageProvider.get(photo.storageKey)
  if (!originalBuffer) {
    throw new Error(`未在存储中找到照片文件：${photo.storageKey}`)
  }

  const exifUpdates: Record<string, any> = {}

  if (metadata.title !== undefined) {
    const titleValue = metadata.title && metadata.title.length > 0 ? metadata.title : null
    exifUpdates.Title = titleValue
    exifUpdates.XPTitle = titleValue
  }

  if (metadata.description !== undefined) {
    const descriptionValue =
      metadata.description && metadata.description.length > 0 ? metadata.description : null
    exifUpdates.Description = descriptionValue
    exifUpdates.ImageDescription = descriptionValue
    exifUpdates.CaptionAbstract = descriptionValue
    exifUpdates.XPComment = descriptionValue
    exifUpdates.UserComment = descriptionValue
  }

  if (metadata.tags !== undefined) {
    const tagsValue = metadata.tags && metadata.tags.length > 0 ? metadata.tags : null
    exifUpdates.Subject = tagsValue
    exifUpdates.Keywords = tagsValue
    exifUpdates.XPKeywords =
      metadata.tags && metadata.tags.length > 0 ? metadata.tags.join('; ') : null
  }

  if (Object.keys(exifUpdates).length === 0) {
    return null
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-ai-'))
  const tempFile = path.join(tempDir, `ai${ext || '.jpg'}`)

  try {
    await writeFile(tempFile, originalBuffer)
    await exiftool.write(tempFile, exifUpdates, ['-overwrite_original'])

    const updatedBuffer = await readFile(tempFile)
    const prefix =
      storageProvider.config && 'prefix' in storageProvider.config
        ? storageProvider.config.prefix
        : ''
    await storageProvider.create(
      photo.storageKey.replace(prefix || '', ''),
      updatedBuffer,
    )

    const exifData = await extractExifData(updatedBuffer)
    const panoramaExif = preservePanoramaExif(photo.exif)
    const mergedExif =
      exifData || Object.keys(panoramaExif).length > 0
        ? { ...(exifData ?? {}), ...panoramaExif }
        : null

    return {
      exif: mergedExif,
      fileSize: updatedBuffer.length,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
