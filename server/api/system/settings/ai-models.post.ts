import { resolveAIConfigInput } from '~~/server/services/ai/metadata'

/**
 * 拉取 AI 服务的可用模型列表（GET {apiBase}/models，OpenAI 兼容）。
 * 表单中密钥为掩码/空时自动回退为已保存的密钥。
 */
export default eventHandler(async (event) => {
  await requireUserSession(event)

  const body = await readBody(event).catch(() => ({}))
  const config = await resolveAIConfigInput(body)

  const fail = (detail: string) => ({ success: false, models: [], detail })

  if (!config.apiBase || !config.apiKey) {
    return fail('请先填写 API 地址和 API Key')
  }

  try {
    const response = await $fetch(`${config.apiBase}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout: 30_000,
    })

    const models = Array.isArray(response?.data)
      ? response.data
          .map((item: any) => (typeof item?.id === 'string' ? item.id : ''))
          .filter(Boolean)
      : []

    if (models.length === 0) {
      return fail('接口未返回模型列表')
    }

    return { success: true, models }
  } catch (error: any) {
    const status: number | undefined =
      error?.statusCode ?? error?.status ?? error?.data?.statusCode

    if (status === 401 || status === 403) return fail('认证失败')
    if (status === 404) return fail('接口地址不存在')
    return fail('网络连接失败')
  }
})
