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
const visibleAIFields = computed(() => filterVisible(aiFields.value, aiState))
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
