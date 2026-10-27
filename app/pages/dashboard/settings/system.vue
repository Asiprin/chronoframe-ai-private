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
            <UButton
              :loading="aiLoading"
              type="submit"
              form="aiSettingsForm"
              variant="soft"
              icon="tabler:device-floppy"
            >
              保存设置
            </UButton>
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
      </div>
    </template>
  </UDashboardPanel>
</template>

<style scoped></style>
