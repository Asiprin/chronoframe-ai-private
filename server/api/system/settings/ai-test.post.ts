import sharp from 'sharp'
import { z } from 'zod'
import {
  SECRET_PLACEHOLDER,
  settingsManager,
} from '~~/server/services/settings/settingsManager'

const bodySchema = z.object({
  apiBase: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
})

/**
 * POST /api/system/settings/ai-test
 *
 * 测试 AI 视觉服务连通性。
 * - 支持提交表单中未保存的值（apiKey 为掩码或为空时回退到已保存的密钥）
 * - 生成一张带随机数字的测试图片验证真实图片识别能力（纯文本模型无法通过）
 */
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  if (!session || !session.user.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = bodySchema.parse((await readBody(event).catch(() => ({}))) ?? {})

  const savedApiKey = await settingsManager.get<string>('ai', 'apiKey')
  const apiBase = (
    body.apiBase?.trim() ||
    (await settingsManager.get<string>('ai', 'apiBase')) ||
    ''
  )
    .replace(/\/+$/, '')
    .trim()
  const apiKey =
    body.apiKey?.trim() && body.apiKey.trim() !== SECRET_PLACEHOLDER
      ? body.apiKey.trim()
      : savedApiKey || ''
  const model =
    body.model?.trim() || (await settingsManager.get<string>('ai', 'model')) || ''

  if (!apiBase || !apiKey || !model) {
    throw createError({
      statusCode: 400,
      statusMessage: '请填写完整的 API 地址、API Key 和模型名称',
    })
  }

  // 生成带随机数字的测试图片（sharp 渲染 SVG）
  const digits = String(Math.floor(1000 + Math.random() * 9000))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1e88e5"/><text x="128" y="176" font-size="120" font-family="Arial, Helvetica, sans-serif" font-weight="bold" fill="#ffffff" text-anchor="middle">${digits}</text></svg>`
  const testImage = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()
  const dataUrl = `data:image/jpeg;base64,${testImage.toString('base64')}`

  const startedAt = Date.now()
  try {
    const response: any = await $fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        max_tokens: 8000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '这张图片里显示了什么数字？只回答数字本身，不要输出任何其他内容。',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      timeout: 60_000,
    })

    const content = response?.choices?.[0]?.message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part: any) =>
                typeof part?.text === 'string' ? part.text : '',
              )
              .join('')
          : ''
    const latencyMs = Date.now() - startedAt

    if (!text.trim()) {
      return {
        success: false,
        vision: false,
        latencyMs,
        message:
          'API 已连通，但模型没有返回内容（推理模型可能输出额度不足，请重试）',
      }
    }

    const visionOk = text.replace(/\s/g, '').includes(digits)
    return {
      success: true,
      vision: visionOk,
      latencyMs,
      message: visionOk
        ? `连接成功，模型 ${model} 图片识别正常（${latencyMs}ms）`
        : `API 已连通，但模型似乎无法识别图片内容（回答："${text.trim().slice(0, 50)}"）。请确认模型支持视觉输入`,
    }
  } catch (error: any) {
    const status: number | undefined =
      error?.statusCode ?? error?.status ?? error?.data?.statusCode
    const detail =
      error?.data?.error?.message ||
      error?.data?.message ||
      error?.message ||
      '未知错误'
    const latencyMs = Date.now() - startedAt

    let message: string
    if (status === 401 || status === 403) {
      message = `认证失败（${status}）：API Key 不正确`
    } else if (status === 404) {
      message = 'API 地址或模型不存在（404）：请检查 API 地址与模型名称'
    } else if (status === 400) {
      message = `请求被拒绝（400）：${detail}`
    } else if (/fetch failed/i.test(detail)) {
      message = `网络连接失败：无法访问 ${apiBase}（可能是 DNS、代理或 TLS 证书问题）`
    } else {
      message = `测试失败：${detail}`
    }

    return { success: false, vision: false, latencyMs, message }
  }
})
