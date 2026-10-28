import sharp from 'sharp'
import { settingsManager, SECRET_PLACEHOLDER } from '~~/server/services/settings/settingsManager'
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

export interface PromptTemplate {
  id: string
  name: string
  prompt: string
}

/** 内置默认模板（与设置项 defaultValue 保持一致，作为兜底） */
export const DEFAULT_PROMPT_TEMPLATE: PromptTemplate = {
  id: 'default',
  name: '默认模板',
  prompt: `请为图片撰写一段简短的配文包括图片标题和图片描述。其目的并非重复描述画面内容，而是传达一种深意——即观者在看过画面后，脑海中会留下的那句话。
撰写原则：
1. 联想必须完全基于画面中已有的信息。切勿凭空编造时间、人物关系或事件背景。
2. 语言应自然且有趣，可带有些许克制的幽默感或诗意；但要避免矫揉造作、励志口号、小学生作文式的表达，以及套路化的陈词滥调。
3. 可以表达一种微妙的日常心境、淡淡的自嘲或冷幽默，对记忆或某个瞬间的内敛感悟，亦或是某种耐人寻味的平实观察。
4. 除非确实必要，否则应避免使用诸如“世界”、“梦”、“时光”、“岁月”、“温柔”、“治愈”、“刚刚好”、“悄悄”、“慢慢”这类陈词滥调。
5. 避免使用诸如“……里……着整个世界/整个夏天”之类的句式，以及简单的“……像……”、“……比……更……”等比较结构。
6. 不要提及媒介本身，例如“这张照片”、“这一刻”或“那天”等表述。
7. 仅提供一个句子，无需换行、引号、前缀或任何解释。标题中文长度控制在 10 个汉字以内，描述中文长度 8 至 24 个汉字之间，且不得超过 30 字；其他语言亦应保持精炼，建议在 4 至 18 个词之间。`,
}

// 与 PUT /api/photos/:photoId 的 bodySchema 保持一致的字段上限
const MAX_TITLE_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_TAG_COUNT = 64
const MAX_TAG_LENGTH = 128
// 送入视觉模型的图片最长边
const VISION_IMAGE_SIZE = 1280
// 推理模型（如 deepseek-flash）会把大量 token 耗在 reasoning 上，上限要给足
const MAX_OUTPUT_TOKENS = 8000

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
 * 从设置读取提示词模板列表（解析失败时回退内置默认模板）
 */
export async function getPromptTemplates(): Promise<PromptTemplate[]> {
  const raw = await settingsManager.get<string>('ai', 'promptTemplates')
  if (!raw) return [DEFAULT_PROMPT_TEMPLATE]
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [DEFAULT_PROMPT_TEMPLATE]
    const templates: PromptTemplate[] = parsed
      .filter(
        (t: any) =>
          t && typeof t.id === 'string' && typeof t.prompt === 'string' && t.prompt.trim(),
      )
      .map((t: any) => ({
        id: t.id,
        name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id,
        prompt: t.prompt,
      }))
    return templates.length > 0 ? templates : [DEFAULT_PROMPT_TEMPLATE]
  } catch {
    return [DEFAULT_PROMPT_TEMPLATE]
  }
}

/**
 * 当前启用的提示词模板（找不到时用列表第一个，再兜底内置默认）
 */
export async function getActivePromptTemplate(): Promise<PromptTemplate> {
  const templates = await getPromptTemplates()
  const activeId = await settingsManager.get<string>('ai', 'activePromptTemplate')
  return (
    templates.find((t) => t.id === activeId) ?? templates[0] ?? DEFAULT_PROMPT_TEMPLATE
  )
}

/**
 * 合并表单输入与已保存配置（用于测试/加载模型）。
 * 表单里未填或填了掩码（••••••••）的密钥自动回退为已保存值，
 * 各字段允许为空——由调用方决定缺什么算失败。
 */
export interface ResolvedAIInput {
  apiBase?: string
  apiKey?: string
  model?: string
  language: string
}

export async function resolveAIConfigInput(input?: {
  apiBase?: unknown
  apiKey?: unknown
  model?: unknown
}): Promise<ResolvedAIInput> {
  const stored = await getAIConfig()

  const apiBaseRaw =
    typeof input?.apiBase === 'string' ? input.apiBase.trim() : ''
  const apiKeyRaw = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  const modelRaw = typeof input?.model === 'string' ? input.model.trim() : ''

  return {
    apiBase: apiBaseRaw
      ? apiBaseRaw.replace(/\/+$/, '')
      : (stored?.apiBase ?? ''),
    apiKey:
      apiKeyRaw && apiKeyRaw !== SECRET_PLACEHOLDER ? apiKeyRaw : (stored?.apiKey ?? ''),
    model: modelRaw || (stored?.model ?? ''),
    language: stored?.language ?? 'zh-CN',
  }
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

function buildPrompt(
  template: PromptTemplate,
  language: string,
  context?: PhotoAIContext,
): string {
  const contextLine = buildContextLine(context)

  switch (language) {
    case 'en':
      return [
        'You are a photo caption assistant. Carefully look at this photo and follow the guide below.',
        '',
        '[Guide]',
        template.prompt,
        '',
        '[Output format] Output ONLY a JSON object (no markdown fences, no extra text) in this exact shape:',
        '{',
        '  "title": "the image title",',
        '  "description": "the image caption",',
        '  "tags": ["5 to 8 tags, each at most 2 words"]',
        '}',
        `Capture info (reference only, trust the actual image content): ${contextLine}`,
        'Write title, description and tags in English.',
      ].join('\n')
    case 'zh-TW':
      return [
        '你是一個照片配文助手。請仔細觀察這張照片，並遵循下面的提示詞指南產生中繼資料。',
        '',
        '【提示詞指南】',
        template.prompt,
        '',
        '【輸出格式】只輸出一個 JSON 物件（不要 markdown 程式碼區塊、不要任何其他文字）：',
        '{',
        '  "title": "圖片標題",',
        '  "description": "圖片描述",',
        '  "tags": ["標籤：每個不超過 2 個字，5 到 8 個"]',
        '}',
        `拍攝資訊（僅供參考，以圖片實際內容為準）：${contextLine}`,
        '所有內容使用繁體中文輸出。',
      ].join('\n')
    case 'ja':
      return [
        'あなたは写真のキャプションアシスタントです。この写真をよく観察し、以下のガイドに従ってメタデータを生成してください。',
        '',
        '【ガイド】',
        template.prompt,
        '',
        '【出力形式】JSON オブジェクトのみを出力してください（マークダウンや余計な文字は不要）：',
        '{',
        '  "title": "画像のタイトル",',
        '  "description": "画像の説明",',
        '  "tags": ["タグ：各 2 文字以内、5〜8 個"]',
        '}',
        `撮影情報（参考のみ、実際の画像内容を優先）：${contextLine}`,
        'タイトル・説明・タグはすべて日本語で出力してください。',
      ].join('\n')
    case 'zh-CN':
    default:
      return [
        '你是一个照片配文助手。请仔细观察这张照片，并遵循下面的提示词指南生成元数据。',
        '',
        '【提示词指南】',
        template.prompt,
        '',
        '【输出格式】只输出一个 JSON 对象（不要 markdown 代码块、不要任何其他文字）：',
        '{',
        '  "title": "图片标题",',
        '  "description": "图片描述",',
        '  "tags": ["标签：每个不超过 2 个汉字，5 到 8 个"]',
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

/** 按语言限制单个标签长度：中/日 2 个字，英文 2 个单词 */
function limitTagLength(tag: string, language: string): string {
  if (language === 'en') {
    return tag.split(/\s+/).slice(0, 2).join(' ')
  }
  return tag.slice(0, 2)
}

function normalizeMetadata(
  data: Record<string, unknown>,
  language: string,
): GeneratedPhotoMetadata {
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
        .map((tag) => limitTagLength(tag.trim(), language))
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
  const template = await getActivePromptTemplate()
  const prompt = buildPrompt(template, config.language, options.context)

  log.info(
    `调用 AI 模型 ${config.model}（模板：${template.name}）生成照片元数据`,
  )

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
        max_tokens: MAX_OUTPUT_TOKENS,
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
    // 推理模型可能把 token 全部耗在 reasoning_content 上导致正文为空
    const reasoning = response?.choices?.[0]?.message?.reasoning_content
    const finishReason = response?.choices?.[0]?.finish_reason
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new Error(
        `AI 返回正文为空（推理过程消耗了全部输出额度，finish=${finishReason}），请换用更大的输出额度或非推理模型`,
      )
    }
    throw new Error('AI 返回内容为空')
  }

  const metadata = normalizeMetadata(extractJson(text), config.language)

  if (!metadata.title && !metadata.description && metadata.tags.length === 0) {
    throw new Error('AI 返回的元数据为空')
  }

  log.success(`AI 生成元数据成功：title="${metadata.title}" tags=${metadata.tags.length}`)
  return metadata
}
