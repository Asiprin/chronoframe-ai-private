const HEIC_EXTENSIONS = ['.heic', '.heif', '.hif']

export default eventHandler(async (event) => {
  await requireUserSession(event)
  const { storageProvider } = useStorageProvider(event)
  const photoId = getRouterParam(event, 'photoId')

  if (!photoId) {
    return createError({
      statusCode: 400,
      statusMessage: 'Photo ID is required',
    })
  }

  const photo = await useDB()
    .select()
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo) {
    return createError({
      statusCode: 404,
      statusMessage: 'Photo not found',
    })
  }

  logger.image.info(`Deleting photo ${photo.title || photo.id || photoId}`)

  // 逐个删除存储文件，失败不再静默吞掉——收集后上报给调用方
  const failedFiles: string[] = []
  const deleteFile = async (key: string, label: string) => {
    // 网络存储偶发抖动（超时/断连）时延迟重试，指数退避 1s/2s
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await storageProvider.delete(key)
        return
      } catch (error) {
        if (attempt < maxAttempts) {
          logger.image.warn(
            `删除${label}第 ${attempt} 次失败，${attempt}s 后重试: ${key}`,
          )
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
          continue
        }
        failedFiles.push(key)
        logger.image.warn(`删除${label}失败（保留在存储中）: ${key}`, error)
      }
    }
  }

  if (photo.storageKey) {
    logger.image.info(`Deleting photo files for ${photoId} from storage`)
    await deleteFile(photo.storageKey, '原文件')
    const lowerStorageKey = photo.storageKey.toLowerCase()
    const heicExtension = HEIC_EXTENSIONS.find((ext) =>
      lowerStorageKey.endsWith(ext),
    )
    if (heicExtension) {
      const jpegKey =
        photo.storageKey.slice(
          0,
          photo.storageKey.length - heicExtension.length,
        ) + '.jpeg'
      if (jpegKey !== photo.storageKey) {
        await deleteFile(jpegKey, 'HEIC 转换的 JPEG')
      }
    }
  }
  if (photo.thumbnailKey) {
    await deleteFile(photo.thumbnailKey, '缩略图')
  }
  if (photo.livePhotoVideoKey) {
    await deleteFile(photo.livePhotoVideoKey, '实况视频')
  }

  useDB().delete(tables.photos).where(eq(tables.photos.id, photoId)).run()

  if (failedFiles.length > 0) {
    logger.image.warn(
      `Photo ${photoId} 记录已删除，但 ${failedFiles.length} 个文件未能从存储删除`,
    )
  } else {
    logger.image.success(`Photo ${photoId} deleted`)
  }

  return {
    success: true,
    failedFiles,
  }
})
