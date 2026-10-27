import sharp from 'sharp'
import { settingsManager } from '~~/server/services/settings/settingsManager'
import { NonRetryableError } from '~~/server/services/pipeline-queue/errors'
import { logger } from '~~/server/utils/logger'

const log = logger.dynamic('ai')

/** 生成元数据时可提供给模型参考的拍摄上下文 */
export interface PhotoAIContext {
  dateTaken?: string | null
  locationName?: string | null
  city?: string | null
  country?: string | null
  cameraModel?: string | null
}

export interface GeneratedPhotoMetadata {
  title: string
  description: string
  tags: string[]
}

export interface AIConfig {
  apiBase: string
  apiKey: string
  model: string
  language: string
}

// 与 PUT /api/photos/:photoId 的 bodySchema 保持一致的字段上限
const MAX_TITLE_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_TAG_COUNT = 64
const MAX_TAG_LENGTH = 128
// 送入视觉模型的图片最长边
const VISION_IMAGE_SIZE = 1280

/**
 * 读取 AI 配置。未启用或缺少关键配置时返回 null。
 */
export async function getAIConfig(): Promise<AIConfig | null> {
  const enabled = await settingsManager.get<boolean>('ai', 'enabled')
  if (!enabled) return null

  const apiBase = await settingsManager.get<string>('ai', 'apiBase')
  const apiKey = await settingsManager.get<string>('ai', 'apiKey')
  const model = await settingsManager.get<string>('ai', 'model')

  if (!apiBase || !apiKey || !model) return null

  const language = (await settingsManager.get<string>('ai', 'language')) || 'zh-CN'

  return { apiBase: apiBase.replace(/\/+$/, ''), apiKey, model, language }
}

/**
 * 把照片 buffer 转成可传给视觉模型的 data URL。
 * 会按 EXIF 方向旋转并压缩到合理尺寸，控制请求体积。
 */
async function toVisionImage(imageBuffer: Buffer): Promise<string> {
  let processed: Buffer
  try {
    processed = await sharp(imageBuffer)
      .rotate()
      .resize(VISION_IMAGE_SIZE, VISION_IMAGE_SIZE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer()
  } catch (error) {
    // HDR/EXR 等 sharp 不支持的格式：原样送出（模型可能拒绝，交由上层报错）
    log.warn('图片预处理失败，将尝试直接使用原始数据', error)
    processed = imageBuffer
  }

  return `data:image/jpeg;base64,${processed.toString('base64')}`
}

function buildContextLine(context?: PhotoAIContext): string {
  const parts: string[] = []
  if (context?.dateTaken) parts.push(`拍摄时间：${context.dateTaken}`)
  const location = [context?.country, context?.city, context?.locationName]
    .filter(Boolean)
    .join(' ')
  if (location) parts.push(`拍摄地点：${location}`)
  if (context?.cameraModel) parts.push(`相机：${context.cameraModel}`)
  return parts.length > 0 ? parts.join('；') : '无'
}

function buildPrompt(language: string, context?: PhotoAIContext): string {
  const contextLine = buildContextLine(context)

  switch (language) {
    case 'en':
      return [
        'You are a photo metadata assistant. Carefully look at this photo and generate metadata.',
        'Output ONLY a JSON object (no markdown fences, no extra text) in this exact shape:',
        '{',
        '  "title": "a concise vivid title, at most 8 words",',
        '  "description": "1-2 sentences describing the scene and mood, at most 40 words",',
        '  "tags": ["5 to 8 tags: subjects, scene, action, colors, style, ..."]',
        '}',
        `Capture info (reference only, trust the actual image content): ${contextLine}`,
        'Write title, description and tags in English. Base everything on what you actually see in the image.',
      ].join('\n')
    case 'zh-TW':
      return [
        '你是一個照片中繼資料助手。請仔細觀察這張照片並產生中繼資料。',
        '只輸出一個 JSON 物件（不要 markdown 程式碼區塊、不要任何其他文字），格式如下：',
        '{',
        '  "title": "照片標題：簡潔生動，不超過 25 個字",',
        '  "description": "照片描述：1-2 句話，描述畫面內容與氛圍，不超過 100 個字",',
        '  "tags": ["5 到 8 個標籤：主體、場景、動作、色彩、風格等"]',
        '}',
        `拍攝資訊（僅供參考，以圖片實際內容為準）：${contextLine}`,
        '所有內容使用繁體中文輸出。',
      ].join('\n')
    case 'ja':
      return [
        'あなたは写真メタデータアシスタントです。この写真をよく観察してメタデータを生成してください。',
        'JSON オブジェクトのみを出力してください（マークダウンや余計な文字は不要）。形式：',
        '{',
        '  "title": "写真のタイトル：簡潔で生き生きとして、20 文字以内",',
        '  "description": "写真の説明：シーンと雰囲気を 1〜2 文で、80 文字以内",',
        '  "tags": ["5〜8 個のタグ：被写体、シーン、動作、色、スタイルなど"]',
        '}',
        `撮影情報（参考のみ、実際の画像内容を優先）：${contextLine}`,
        'タイトル・説明・タグはすべて日本語で出力してください。',
      ].join('\n')
    case 'zh-CN':
    default:
      return [
        '你是一个照片元数据助手。请仔细观察这张照片并生成元数据。',
        '只输出一个 JSON 对象（不要 markdown 代码块、不要任何其他文字），格式如下：',
        '{',
        '  "title": "照片标题：简洁生动，不超过 25 个字",',
        '  "description": "照片描述：1-2 句话，描述画面内容和氛围，不超过 100 个字",',
        '  "tags": ["5 到 8 个标签：主体、场景、动作、色彩、风格等"]',
        '}',
        `拍摄信息（仅供参考，以图片实际内容为准）：${contextLine}`,
        '所有内容使用简体中文输出。',
      ].join('\n')
  }
}

/**
 * 从模型回复中解析 JSON（容忍 markdown 代码块与前后多余文字）
 */
function extractJson(text: string): Record<string, unknown> {
  let cleaned = text.trim()
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim()
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI 返回内容不是有效 JSON：${text.slice(0, 200)}`)
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`AI 返回内容 JSON 解析失败（${reason}）：${text.slice(0, 200)}`)
  }
}

function normalizeMetadata(data: Record<string, unknown>): GeneratedPhotoMetadata {
  const title =
    typeof data.title === 'string'
      ? data.title.trim().slice(0, MAX_TITLE_LENGTH)
      : ''
  const description =
    typeof data.description === 'string'
      ? data.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : ''
  const rawTags = Array.isArray(data.tags) ? data.tags : []
  const tags = [
    ...new Set(
      rawTags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAG_COUNT)

  return { title, description, tags }
}

function extractErrorMessage(error: any): string {
  return (
    error?.data?.error?.message ||
    error?.data?.message ||
    error?.statusMessage ||
    error?.message ||
    '未知错误'
  )
}

/**
 * 调用 OpenAI 兼容的视觉模型，为照片生成标题、描述和标签。
 *
 * @param options.imageBuffer 照片原始字节（会自动压缩后再送模型）
 * @param options.context 可供参考的拍摄上下文（时间/地点/相机）
 */
export async function generatePhotoMetadata(options: {
  imageBuffer: Buffer
  context?: PhotoAIContext
}): Promise<GeneratedPhotoMetadata> {
  const config = await getAIConfig()
  if (!config) {
    throw new NonRetryableError(
      'AI 智能识别未启用或未配置（需要在系统设置中填写 API 地址、API Key 和模型名称）',
    )
  }

  const imageDataUrl = await toVisionImage(options.imageBuffer)
  const prompt = buildPrompt(config.language, options.context)

  log.info(`调用 AI 模型 ${config.model} 生成照片元数据`)

  let response: any
  try {
    response = await $fetch(`${config.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        model: config.model,
        temperature: 0.3,
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      },
      timeout: 120_000,
    })
  } catch (error: any) {
    const status: number | undefined =
      error?.statusCode ?? error?.status ?? error?.data?.statusCode

    if (status === 401 || status === 403) {
      throw new NonRetryableError(
        `AI API 认证失败（${status}）：请检查 API Key 是否正确`,
      )
    }
    if (status === 404) {
      throw new NonRetryableError(
        'AI API 地址或模型不存在（404）：请检查 API 地址与模型名称',
      )
    }
    if (status === 400) {
      throw new NonRetryableError(
        `AI API 请求被拒绝（400）：${extractErrorMessage(error)}`,
      )
    }

    throw new Error(
      `AI API 调用失败${status ? `（${status}）` : ''}：${extractErrorMessage(error)}`,
    )
  }

  const content = response?.choices?.[0]?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
        : ''

  if (!text.trim()) {
    throw new Error('AI 返回内容为空')
  }

  const metadata = normalizeMetadata(extractJson(text))

  if (!metadata.title && !metadata.description && metadata.tags.length === 0) {
    throw new Error('AI 返回的元数据为空')
  }

  log.success(`AI 生成元数据成功：title="${metadata.title}" tags=${metadata.tags.length}`)
  return metadata
}
