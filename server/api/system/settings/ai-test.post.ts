import sharp from 'sharp'
import {
  resolveAIConfigInput,
  type ResolvedAIInput,
} from '~~/server/services/ai/metadata'

const PASS_MESSAGE = 'API 和模型配置正常'
const FAIL_MESSAGE = '请检查 API 和模型配置'

/**
 * AI 服务连通性 + 图片识别能力测试。
 *
 * 生成一张纯色测试图（矢量绘制、不依赖系统字体，Docker/无字体环境同样可靠），
 * 要求模型回答主色，验证真·视觉识别能力。
 *
 * 返回简化文案：通过 = "API 和模型配置正常"，失败 = "请检查 API 和模型配置"
 * （detail 仅给一行简短原因）。
 */
export default eventHandler(async (event) => {
  await requireUserSession(event)

  const body = await readBody(event).catch(() => ({}))
  const config: ResolvedAIInput = await resolveAIConfigInput(body)

  const fail = (detail: string) => ({ success: false, message: FAIL_MESSAGE, detail })

  if (!config.apiBase || !config.apiKey || !config.model) {
    return fail('配置不完整')
  }

  // 纯色测试图（红色），不依赖字体渲染；期望模型回答含"红/red"
  const testImage = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 210, g: 35, b: 35 },
    },
  })
    .png()
    .toBuffer()
  const imageDataUrl = `data:image/png;base64,${testImage.toString('base64')}`

  let answer = ''
  try {
    const response = await $fetch(`${config.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        model: config.model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '只用一个词回答：这张图片的主要颜色是什么？',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      },
      timeout: 60_000,
    })

    const content = response?.choices?.[0]?.message?.content
    answer =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
              .join('')
          : ''
  } catch (error: any) {
    const status: number | undefined =
      error?.statusCode ?? error?.status ?? error?.data?.statusCode

    if (status === 401 || status === 403) return fail('认证失败')
    if (status === 404) return fail('接口地址或模型不存在')
    if (status === 400) return fail('请求被拒绝，请检查模型名称')
    return fail('网络连接失败')
  }

  const visionOk = /红|紅|red/i.test(answer)
  if (!visionOk) {
    return fail('模型不支持图片识别')
  }

  return { success: true, message: PASS_MESSAGE }
})
