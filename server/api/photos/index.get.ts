import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import {
  photoListSelection,
  toPhotoListItem,
} from '~~/server/utils/photoResponse'
import { getPublicPhotoVisibilityCondition } from '~~/server/utils/photoVisibility'

// 照片目录单页默认数量，兼顾首屏请求体积与滚动加载频率。
const DEFAULT_PAGE_SIZE = 60
// 防止客户端通过超大分页参数重新触发全量查询。
const MAX_PAGE_SIZE = 200

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
})

export default eventHandler(async (event) => {
  const { cursor, limit } = await getValidatedQuery(event, querySchema.parse)
  const db = useDB()
  // 瀑布流时间排序方向（app.photoOrder）：desc=新在前（默认），asc=旧在前
  const isAsc =
    (await settingsManager.get<string>('app', 'photoOrder')) === 'asc'
  const session = await getUserSession(event)
  const visibilityCondition = session.user
    ? undefined
    : getPublicPhotoVisibilityCondition()

  let cursorCondition
  if (cursor) {
    const cursorPhoto = db
      .select({
        id: tables.photos.id,
        dateTaken: tables.photos.dateTaken,
      })
      .from(tables.photos)
      .where(and(eq(tables.photos.id, cursor), visibilityCondition))
      .get()

    if (!cursorPhoto) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid photo cursor',
      })
    }

    cursorCondition = cursorPhoto.dateTaken
      ? isAsc
        ? or(
            gt(tables.photos.dateTaken, cursorPhoto.dateTaken),
            isNull(tables.photos.dateTaken),
            and(
              eq(tables.photos.dateTaken, cursorPhoto.dateTaken),
              gt(tables.photos.id, cursorPhoto.id),
            ),
          )
        : or(
            lt(tables.photos.dateTaken, cursorPhoto.dateTaken),
            isNull(tables.photos.dateTaken),
            and(
              eq(tables.photos.dateTaken, cursorPhoto.dateTaken),
              lt(tables.photos.id, cursorPhoto.id),
            ),
          )
      : and(
          isNull(tables.photos.dateTaken),
          isAsc
            ? gt(tables.photos.id, cursorPhoto.id)
            : lt(tables.photos.id, cursorPhoto.id),
        )
  }

  const rows = db
    .select(photoListSelection)
    .from(tables.photos)
    .where(and(visibilityCondition, cursorCondition))
    .orderBy(
      // 升序时无日期的照片排在末尾（降序时 SQLite 默认 NULL 在后）
      ...(isAsc
        ? [
            sql`${tables.photos.dateTaken} IS NULL`,
            asc(tables.photos.dateTaken),
            asc(tables.photos.id),
          ]
        : [desc(tables.photos.dateTaken), desc(tables.photos.id)]),
    )
    .limit(limit + 1)
    .all()

  // 总数仅在第一页计算，后续游标页沿用客户端已有总数。
  const totalResult = cursor
    ? undefined
    : db
        .select({ count: sql<number>`count(*)` })
        .from(tables.photos)
        .where(visibilityCondition)
        .get()

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const items = pageRows.map(toPhotoListItem)

  return {
    items,
    total: totalResult?.count ?? null,
    nextCursor: hasMore ? (pageRows.at(-1)?.id ?? null) : null,
  }
})
