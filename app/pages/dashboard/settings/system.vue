<script lang="ts" setup>
import type { FieldDescriptor } from '~~/shared/types/settings'
definePageMeta({
  layout: 'dashboard',
})

useHead({
  title: $t('title.systemSettings'),
})

const { fields: oauthFields, state: oauthState, submit: oauthSubmit, loading: oauthLoading } = useSettingsForm('oauth')
const { fields: analyticsFields, state: analyticsState, submit: analyticsSubmit, loading: analyticsLoading } = useSettingsForm('analytics')
const { fields: aiFields, state: aiState, submit: aiSubmit, loading: aiLoading } = useSettingsForm('ai')
const { fields: uploadFields, state: uploadState, submit: uploadSubmit, loading: uploadLoading } = useSettingsForm('upload')
const { fields: securityFields, state: securityState, submit: securitySubmit, loading: securityLoading } = useSettingsForm('security')

const filterVisible = (fields: FieldDescriptor[], state: Record<string, any>) => {
  return fields.filter((field) => {
    if (!field.ui?.visibleIf) return true
    const { fieldKey, value } = field.ui.visibleIf
    return state[fieldKey] === value
  })
}

const visibleOAuthFields = computed(() => filterVisible(oauthFields.value, oauthState))
const visibleAnalyticsFields = computed(() =>
  filterVisible(analyticsFields.value, analyticsState),
)
const visibleAIFields = computed(() =>
  filterVisible(aiFields.value, aiState).filter(
    (field) => !CUSTOM_AI_FIELD_KEYS.has(field.key),
  ),
)
const visibleUploadFields = computed(() => filterVisible(uploadFields.value, uploadState))
const visibleSecurityFields = computed(() =>
  filterVisible(securityFields.value, securityState),
)

const handleOAuthSubmit = async () => {
  try {
    await oauthSubmit(oauthState)
  } catch {
    /* empty */
  }
}

const handleAnalyticsSubmit = async () => {
  try {
    await analyticsSubmit(analyticsState)
  } catch {
    /* empty */
  }
}

const handleAISubmit = async () => {
  try {
    await aiSubmit(aiState)
  } catch {
    /* empty */
  }
}

// ===== 提示词模板管理 =====
interface PromptTemplateItem {
  id: string
  name: string
  prompt: string
}

const CUSTOM_AI_FIELD_KEYS = new Set(['promptTemplates', 'activePromptTemplate'])

const parsePromptTemplates = (raw: unknown): PromptTemplateItem[] => {
  try {
    const parsed = JSON.parse(typeof raw === 'string' && raw ? raw : '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t: any) => t && typeof t.id === 'string' && typeof t.prompt === 'string',
    )
  } catch {
    return []
  }
}

const promptTemplates = computed<PromptTemplateItem[]>({
  get: () => parsePromptTemplates(aiState.promptTemplates),
  set: (val) => {
    aiState.promptTemplates = JSON.stringify(val)
  },
})

const activeTemplateId = computed<string>({
  get: () => String(aiState.activePromptTemplate || 'default'),
  set: (val) => {
    aiState.activePromptTemplate = val
  },
})

const templateOptions = computed(() =>
  promptTemplates.value.map((t) => ({ label: t.name, value: t.id })),
)

const editingTemplate = ref<{
  id: string | null
  name: string
  prompt: string
} | null>(null)

const startCreateTemplate = () => {
  editingTemplate.value = { id: null, name: '', prompt: '' }
}

const startEditTemplate = (tpl: PromptTemplateItem) => {
  editingTemplate.value = { id: tpl.id, name: tpl.name, prompt: tpl.prompt }
}

const saveEditingTemplate = () => {
  const editing = editingTemplate.value
  if (!editing) return
  const name = editing.name.trim()
  const prompt = editing.prompt.trim()
  if (!name || !prompt) {
    toast.add({
      title: '模板名称和提示词不能为空',
      color: 'warning',
    })
    return
  }
  const list = [...promptTemplates.value]
  if (editing.id) {
    const idx = list.findIndex((t) => t.id === editing.id)
    if (idx >= 0) {
      list[idx] = { ...list[idx], name, prompt }
    }
  } else {
    list.push({ id: `tpl-${Date.now()}`, name, prompt })
  }
  promptTemplates.value = list
  editingTemplate.value = null
  toast.add({
    title: '模板已保存',
    description: '点击"保存设置"后生效',
    color: 'info',
  })
}

const deleteTemplate = (tpl: PromptTemplateItem) => {
  if (tpl.id === 'default') return
  promptTemplates.value = promptTemplates.value.filter((t) => t.id !== tpl.id)
  if (activeTemplateId.value === tpl.id) {
    activeTemplateId.value = 'default'
  }
  editingTemplate.value = null
  toast.add({
    title: `已删除模板「${tpl.name}」`,
    description: '点击"保存设置"后生效',
    color: 'info',
  })
}

const toast = useToast()
const aiTesting = ref(false)

const handleAITest = async () => {
  aiTesting.value = true
  try {
    const result = await $fetch('/api/system/settings/ai-test', {
      method: 'POST',
      body: {
        apiBase: aiState.apiBase,
        apiKey: aiState.apiKey,
        model: aiState.model,
      },
    })
    toast.add({
      title: result.success ? (result.vision ? '测试通过' : '注意') : '测试失败',
      description: result.message,
      color: result.success ? (result.vision ? 'success' : 'warning') : 'error',
    })
  } catch (error: any) {
    toast.add({
      title: '测试失败',
      description: error?.data?.statusMessage || error?.message || '未知错误',
      color: 'error',
    })
  } finally {
    aiTesting.value = false
  }
}

// ===== 备份与恢复 =====
const backupIncludeStorage = ref(false)
const backupLoading = ref(false)
const restoreLoading = ref(false)
const restoreFileInput = ref<HTMLInputElement | null>(null)

const handleBackup = async () => {
  backupLoading.value = true
  try {
    const url = `/api/system/backup?storage=${backupIncludeStorage.value ? '1' : '0'}`
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail || `HTTP ${response.status}`)
    }
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') || ''
    const match = disposition.match(/filename="?([^";]+)"?/)
    const filename = match?.[1] || 'chronoframe-backup.zip'
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
    toast.add({
      title: '备份已开始下载',
      description: backupIncludeStorage.value
        ? '包含照片文件，体积可能较大'
        : '仅包含数据库（设置与照片元数据）',
      color: 'success',
    })
  } catch (error: any) {
    toast.add({
      title: '备份失败',
      description: error?.message || '未知错误',
      color: 'error',
    })
  } finally {
    backupLoading.value = false
  }
}

const handleRestoreFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  const confirmed = window.confirm(
    `确定要用「${file.name}」恢复吗？\n\n恢复会覆盖当前数据库和本地照片文件，操作不可撤销（当前数据会自动留一份 .bak 备份）。恢复完成后需要重启服务。`,
  )
  if (!confirmed) return

  restoreLoading.value = true
  try {
    const result = await $fetch('/api/system/restore', {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/zip' },
    })
    toast.add({
      title: '恢复完成',
      description: result.message,
      color: 'success',
    })
  } catch (error: any) {
    toast.add({
      title: '恢复失败',
      description: error?.data?.statusMessage || error?.message || '未知错误',
      color: 'error',
    })
  } finally {
    restoreLoading.value = false
  }
}

const handleUploadSubmit = async () => {
  try {
    await uploadSubmit(uploadState)
  } catch {
    /* empty */
  }
}

const handleSecuritySubmit = async () => {
  try {
    await securitySubmit(securityState)
  } catch {
    /* empty */
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar :title="$t('title.systemSettings')" />
    </template>

    <template #body>
      <div class="space-y-6 max-w-6xl">
        <UCard variant="outline">
          <template #header>
            <span>OAuth 认证设置</span>
          </template>

          <UForm
            id="oauthSettingsForm"
            class="space-y-4"
            @submit="handleOAuthSubmit"
          >
            <SettingField
              v-for="field in visibleOAuthFields"
              :key="field.key"
              :field="field"
              :model-value="oauthState[field.key]"
              @update:model-value="(val) => (oauthState[field.key] = val)"
            />
          </UForm>

          <template #footer>
            <UButton
              :loading="oauthLoading"
              type="submit"
              form="oauthSettingsForm"
              variant="soft"
              icon="tabler:device-floppy"
            >
              保存设置
            </UButton>
          </template>
        </UCard>

        <UCard variant="outline">
          <template #header>
            <span>分析统计设置</span>
          </template>

          <UForm
            id="analyticsSettingsForm"
            class="space-y-4"
            @submit="handleAnalyticsSubmit"
          >
            <SettingField
              v-for="field in visibleAnalyticsFields"
              :key="field.key"
              :field="field"
              :model-value="analyticsState[field.key]"
              @update:model-value="(val) => (analyticsState[field.key] = val)"
            />
          </UForm>

          <template #footer>
            <UButton
              :loading="analyticsLoading"
              type="submit"
              form="analyticsSettingsForm"
              variant="soft"
              icon="tabler:device-floppy"
            >
              保存设置
            </UButton>
          </template>
        </UCard>

        <UCard variant="outline">
          <template #header>
            <span>AI 智能识别设置</span>
          </template>

          <UForm
            id="aiSettingsForm"
            class="space-y-4"
            @submit="handleAISubmit"
          >
            <SettingField
              v-for="field in visibleAIFields"
              :key="field.key"
              :field="field"
              :model-value="aiState[field.key]"
              @update:model-value="(val) => (aiState[field.key] = val)"
            />

            <USeparator />

            <!-- 提示词模板管理 -->
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="space-y-1">
                  <div class="font-medium">提示词模板</div>
                  <p class="text-sm text-neutral-500 dark:text-neutral-400">
                    AI 生成元数据的提示词指南，可自行添加、编辑、删除模板
                  </p>
                </div>
                <USelect
                  v-model="activeTemplateId"
                  :items="templateOptions"
                  class="w-56"
                />
              </div>

              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <div class="text-sm text-neutral-500 dark:text-neutral-400">
                    模板管理
                  </div>
                  <UButton
                    size="xs"
                    variant="soft"
                    icon="tabler:plus"
                    @click="startCreateTemplate"
                  >
                    新建模板
                  </UButton>
                </div>

                <div
                  v-if="editingTemplate"
                  class="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <UInput
                    v-model="editingTemplate.name"
                    placeholder="模板名称"
                    class="w-full"
                  />
                  <UTextarea
                    v-model="editingTemplate.prompt"
                    :rows="8"
                    placeholder="提示词内容"
                    class="w-full"
                  />
                  <div class="flex gap-2">
                    <UButton size="xs" @click="saveEditingTemplate">
                      保存模板
                    </UButton>
                    <UButton
                      size="xs"
                      variant="soft"
                      @click="editingTemplate = null"
                    >
                      取消
                    </UButton>
                  </div>
                </div>

                <div
                  v-for="tpl in promptTemplates"
                  :key="tpl.id"
                  class="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
                >
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 text-sm font-medium">
                      <span>{{ tpl.name }}</span>
                      <UBadge
                        v-if="tpl.id === 'default'"
                        color="neutral"
                        variant="subtle"
                        size="sm"
                      >
                        默认
                      </UBadge>
                      <UBadge
                        v-if="tpl.id === activeTemplateId"
                        color="primary"
                        variant="subtle"
                        size="sm"
                      >
                        使用中
                      </UBadge>
                    </div>
                    <p
                      class="mt-1 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400"
                    >
                      {{ tpl.prompt }}
                    </p>
                  </div>
                  <div class="flex shrink-0 gap-1">
                    <UButton
                      size="xs"
                      variant="ghost"
                      color="neutral"
                      icon="tabler:pencil"
                      @click="startEditTemplate(tpl)"
                    />
                    <UButton
                      size="xs"
                      variant="ghost"
                      color="error"
                      icon="tabler:trash"
                      :disabled="tpl.id === 'default'"
                      @click="deleteTemplate(tpl)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </UForm>

          <template #footer>
            <div class="flex items-center gap-2">
              <UButton
                :loading="aiTesting"
                variant="soft"
                color="info"
                icon="tabler:plug-connected"
                @click="handleAITest"
              >
                测试连接
              </UButton>
              <UButton
                :loading="aiLoading"
                type="submit"
                form="aiSettingsForm"
                variant="soft"
                icon="tabler:device-floppy"
              >
                保存设置
              </UButton>
            </div>
          </template>
        </UCard>

        <UCard variant="outline">
          <template #header>
            <span>上传配置</span>
          </template>

          <UForm
            id="uploadSettingsForm"
            class="space-y-4"
            @submit="handleUploadSubmit"
          >
            <SettingField
              v-for="field in visibleUploadFields"
              :key="field.key"
              :field="field"
              :model-value="uploadState[field.key]"
              @update:model-value="(val) => (uploadState[field.key] = val)"
            />
          </UForm>

          <template #footer>
            <UButton
              :loading="uploadLoading"
              type="submit"
              form="uploadSettingsForm"
              variant="soft"
              icon="tabler:device-floppy"
            >
              保存设置
            </UButton>
          </template>
        </UCard>

        <UCard variant="outline">
          <template #header>
            <span>安全设置</span>
          </template>

          <UForm
            id="securitySettingsForm"
            class="space-y-4"
            @submit="handleSecuritySubmit"
          >
            <SettingField
              v-for="field in visibleSecurityFields"
              :key="field.key"
              :field="field"
              :model-value="securityState[field.key]"
              @update:model-value="(val) => (securityState[field.key] = val)"
            />
          </UForm>

          <template #footer>
            <UButton
              :loading="securityLoading"
              type="submit"
              form="securitySettingsForm"
              variant="soft"
              icon="tabler:device-floppy"
            >
              保存设置
            </UButton>
          </template>
        </UCard>
        <UCard variant="outline">
          <template #header>
            <span>备份与恢复</span>
          </template>

          <div class="space-y-6">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="space-y-1 max-w-md">
                <div class="font-medium">下载备份</div>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                  导出数据库（设置、照片元数据、相册）为 zip 备份文件。
                  勾选后会连同本地存储的照片文件一起打包（体积可能很大）。
                </p>
                <UCheckbox
                  v-model="backupIncludeStorage"
                  label="包含照片文件（仅本地存储有效）"
                />
              </div>
              <UButton
                :loading="backupLoading"
                variant="soft"
                icon="tabler:download"
                @click="handleBackup"
              >
                下载备份
              </UButton>
            </div>

            <USeparator />

            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="space-y-1 max-w-md">
                <div class="font-medium">恢复备份</div>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                  上传备份 zip 文件恢复数据。恢复会覆盖当前数据库与本地照片文件
                  （覆盖前会自动保存一份 .bak），完成后需要重启服务生效。
                </p>
              </div>
              <div class="flex items-center gap-2">
                <input
                  ref="restoreFileInput"
                  type="file"
                  accept=".zip,application/zip"
                  class="hidden"
                  @change="handleRestoreFileChange"
                >
                <UButton
                  :loading="restoreLoading"
                  variant="soft"
                  color="warning"
                  icon="tabler:upload"
                  @click="restoreFileInput?.click()"
                >
                  选择备份文件恢复
                </UButton>
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>

<style scoped></style>
