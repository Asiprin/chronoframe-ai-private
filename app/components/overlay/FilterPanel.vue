<script lang="ts" setup>
import type { TabsItem } from '@nuxt/ui'

const {
  availableFilters,
  selectedCounts,
  toggleFilter,
  isFilterSelected,
  clearAllFilters,
  hasActiveFilters,
  activeFilters,
} = usePhotoFilters()

// 编辑标签模式：标签角标 × 可把该标签从照片中删除（照片信息面板同步移除）
const { photos, refresh } = usePhotos()
const toast = useToast()
const { loggedIn } = useUserSession()
const isTagEditMode = ref(false)
const deletingTag = ref<string | null>(null)

const handleDeleteTag = async (tag: string) => {
  if (deletingTag.value) return
  deletingTag.value = tag
  try {
    const targets = photos.value.filter((p) => (p.tags || []).includes(tag))
    for (const photo of targets) {
      const nextTags = (photo.tags || []).filter((t) => t !== tag)
      await $fetch(`/api/photos/${encodeURIComponent(photo.id)}`, {
        method: 'PUT',
        body: { tags: nextTags },
      })
    }
    await refresh()
    toast.add({
      title: `已删除标签「${tag}」`,
      description:
        targets.length > 0 ? `已从 ${targets.length} 张照片中移除` : '',
      color: 'success',
    })
  } catch (error: any) {
    toast.add({
      title: '删除标签失败',
      description: error?.data?.statusMessage || error?.message || '',
      color: 'error',
    })
  } finally {
    deletingTag.value = null
  }
}

const currentTab = ref('labels')
const isSearchMode = ref(false)

const searchQuery = computed({
  get: () => activeFilters.value.search,
  set: (value: string) => {
    activeFilters.value.search = value
  },
})

const selectedRating = computed({
  get: () => activeFilters.value.ratings,
  set: (value: number) => {
    activeFilters.value.ratings = value
  },
})

const tabItems = computed<TabsItem[]>(() => [
  {
    label: $t('ui.action.filter.tabs.tags'),
    value: 'labels',
    badge: selectedCounts.value.tags || undefined,
    icon: 'tabler:tags',
    slot: 'tags',
  },
  {
    label: '相册',
    value: 'albums',
    badge: selectedCounts.value.albums || undefined,
    icon: 'tabler:photo-album',
    slot: 'albums',
  },
  {
    label: $t('ui.action.filter.tabs.cameras'),
    value: 'cameras',
    badge: selectedCounts.value.cameras || undefined,
    icon: 'tabler:camera',
    slot: 'cameras',
  },
  {
    label: $t('ui.action.filter.tabs.lenses'),
    value: 'lenses',
    badge: selectedCounts.value.lenses || undefined,
    icon: 'tabler:aperture',
    slot: 'lenses',
  },
  {
    label: $t('ui.action.filter.tabs.cities'),
    value: 'cities',
    badge: selectedCounts.value.cities || undefined,
    icon: 'tabler:map-pin',
    slot: 'cities',
  },
  {
    label: $t('ui.action.filter.tabs.ratings'),
    value: 'ratings',
    badge: selectedCounts.value.ratings || undefined,
    icon: 'tabler:star',
    slot: 'ratings',
  },
])

const handleToggleFilter = (type: string, value: string | number) => {
  toggleFilter(type as any, value)
}

</script>

<template>
  <div class="space-y-1.5 w-[calc(100vw-34px)] sm:w-md">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-bold text-neutral-900 dark:text-white p-2">
        {{ $t('ui.action.filter.title') }}
      </h3>
      <div class="flex items-center gap-1">
        <UButton
          v-if="hasActiveFilters"
          size="sm"
          variant="ghost"
          color="neutral"
          icon="tabler:filter-x"
          @click="
            () => {
              clearAllFilters()
              isSearchMode = false
              searchQuery = ''
            }
          "
        >
          {{ $t('ui.action.filter.clearAll') }}
        </UButton>
        <!-- 搜索功能 -->
        <div
          v-if="isSearchMode"
          class="flex items-center gap-1"
        >
          <UInput
            v-model="searchQuery"
            size="sm"
            icon="tabler:search"
            placeholder="搜索文件名等..."
            class="w-32"
            @keydown.escape="isSearchMode = false"
          />
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            icon="tabler:x"
            @click="
              () => {
                isSearchMode = false
                searchQuery = ''
              }
            "
          />
        </div>
        <UButton
          v-else
          size="sm"
          variant="ghost"
          color="neutral"
          icon="tabler:search"
          @click="isSearchMode = true"
        />
        <UTooltip v-if="loggedIn" :text="isTagEditMode ? '完成编辑' : '编辑标签'">
          <UButton
            size="sm"
            variant="ghost"
            :color="isTagEditMode ? 'primary' : 'neutral'"
            icon="tabler:pencil"
            @click="isTagEditMode = !isTagEditMode"
          />
        </UTooltip>
      </div>
    </div>
    <!-- 标签页 -->
    <UTabs
      v-model="currentTab"
      color="neutral"
      size="xs"
      :items="tabItems"
      :ui="{
        list: 'bg-white/30 dark:bg-neutral-800/50',
        indicator: 'bg-white/80',
        trigger:
          'data-[state=inactive]:text-muted data-[state=active]:text-default dark:data-[state=active]:text-inverted',
        trailingBadge:
          'ring-0 rounded-full py-0 bg-info-100/80 dark:bg-info-900/80 text-info-500 dark:text-info-400 border border-info-300/50 dark:border-info-700/50',
        trailingBadgeSize: 'sm',
      }"
    >
      <!-- 标签面板 -->
      <template #tags>
        <div class="space-y-0.5 max-h-64 overflow-y-auto">
          <div class="flex flex-wrap gap-2">
            <div
              v-for="tag in availableFilters.tags"
              :key="tag.label"
              class="relative"
            >
              <UBadge
                :label="tag.label"
                :color="isFilterSelected('tags', tag.label) ? 'info' : 'neutral'"
                :trailing-icon="
                  isTagEditMode
                    ? ''
                    : isFilterSelected('tags', tag.label)
                      ? 'tabler:check'
                      : ''
                "
                variant="soft"
                class="cursor-pointer select-none transition-colors"
                :class="`${isFilterSelected('tags', tag.label) ? '' : 'bg-neutral-800/10 text-neutral-800 hover:bg-neutral-800/20 dark:bg-white/10 dark:text-white dark:hover:bg-white/20'}`"
                @click="!isTagEditMode && handleToggleFilter('tags', tag.label)"
              />
              <!-- 编辑标签模式：角标 × 删除该标签 -->
              <button
                v-if="isTagEditMode"
                type="button"
                class="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-error text-white shadow transition-transform hover:scale-110"
                :disabled="deletingTag !== null"
                @click.stop="handleDeleteTag(tag.label)"
              >
                <Icon name="tabler:x" class="size-2.5" />
              </button>
            </div>
          </div>
          <div
            v-if="availableFilters.tags.length === 0"
            class="text-center text-sm text-neutral-500 dark:text-neutral-400 py-4"
          >
            {{ $t('ui.action.filter.empty.tags') }}
          </div>
        </div>
      </template>

      <!-- 相册面板 -->
      <template #albums>
        <div class="space-y-0.5 max-h-64 overflow-y-auto">
          <div
            v-for="album in availableFilters.albums"
            :key="album.value"
            class="flex items-center justify-between cursor-pointer select-none hover:bg-neutral-400/30 dark:hover:bg-info-800/30 rounded-lg px-2 py-2"
            :class="
              isFilterSelected('albums', album.value)
                ? 'bg-neutral-400/30 dark:bg-info-800/30'
                : ''
            "
            @click="handleToggleFilter('albums', album.value)"
          >
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <Icon
                :name="album.value === 'none' ? 'tabler:photo-off' : 'tabler:photo-album'"
                class="size-4 shrink-0"
                :class="album.value === 'none' ? 'text-neutral-400' : 'text-primary-500'"
              />
              <span class="text-sm text-default font-medium truncate">
                {{ album.label }}
              </span>
              <UBadge
                variant="soft"
                color="neutral"
                size="xs"
              >
                {{ album.count }}
              </UBadge>
            </div>
            <Icon
              v-if="isFilterSelected('albums', album.value)"
              name="tabler:check"
              class="size-4 text-green-500 shrink-0"
            />
          </div>
          <div
            v-if="availableFilters.albums.length === 0"
            class="text-center text-sm text-neutral-500 dark:text-neutral-400 py-4"
          >
            暂无相册
          </div>
        </div>
      </template>

      <!-- 相机面板 -->
      <template #cameras>
        <div class="space-y-0.5 max-h-64 overflow-y-auto">
          <div
            v-for="camera in availableFilters.cameras"
            :key="camera.label"
            class="flex items-center justify-between cursor-pointer select-none hover:bg-neutral-400/30 dark:hover:bg-info-800/30 rounded-lg px-2 py-2"
            :class="
              isFilterSelected('cameras', camera.label)
                ? 'bg-neutral-400/30 dark:bg-info-800/30'
                : ''
            "
            @click="handleToggleFilter('cameras', camera.label)"
          >
            <span class="text-sm text-default font-medium truncate">
              {{ camera.label }}
            </span>
            <Icon
              v-if="isFilterSelected('cameras', camera.label)"
              name="tabler:check"
              class="size-4 text-green-500"
            />
          </div>
          <div
            v-if="availableFilters.cameras.length === 0"
            class="text-center text-sm text-neutral-500 dark:text-neutral-400 py-4"
          >
            {{ $t('ui.action.filter.empty.cameras') }}
          </div>
        </div>
      </template>

      <!-- 镜头面板 -->
      <template #lenses>
        <div class="space-y-0.5 max-h-64 overflow-y-auto">
          <div
            v-for="lens in availableFilters.lenses"
            :key="lens.label"
            class="flex items-center justify-between cursor-pointer select-none hover:bg-neutral-400/30 dark:hover:bg-info-800/30 rounded-lg px-2 py-2"
            :class="
              isFilterSelected('lenses', lens.label)
                ? 'bg-neutral-400/30 dark:bg-info-800/30'
                : ''
            "
            @click="handleToggleFilter('lenses', lens.label)"
          >
            <span class="text-sm text-default font-medium truncate">
              {{ lens.label }}
            </span>
            <Icon
              v-if="isFilterSelected('lenses', lens.label)"
              name="tabler:check"
              class="size-4 text-green-500"
            />
          </div>
          <div
            v-if="availableFilters.lenses.length === 0"
            class="text-center text-sm text-neutral-500 dark:text-neutral-400 py-4"
          >
            {{ $t('ui.action.filter.empty.lenses') }}
          </div>
        </div>
      </template>

      <!-- 城市面板 -->
      <template #cities>
        <div class="space-y-0.5 max-h-64 overflow-y-auto">
          <div
            v-for="city in availableFilters.cities"
            :key="city.label"
            class="flex items-center justify-between cursor-pointer select-none hover:bg-neutral-400/30 dark:hover:bg-info-800/30 rounded-lg px-2 py-2"
            :class="
              isFilterSelected('cities', city.label)
                ? 'bg-neutral-400/30 dark:bg-info-800/30'
                : ''
            "
            @click="handleToggleFilter('cities', city.label)"
          >
            <span class="text-sm text-default font-medium truncate">
              {{ city.label }}
            </span>
            <Icon
              v-if="isFilterSelected('cities', city.label)"
              name="tabler:check"
              class="size-4 text-green-500"
            />
          </div>
          <div
            v-if="availableFilters.cities.length === 0"
            class="text-center text-sm text-neutral-500 dark:text-neutral-400 py-4"
          >
            {{ $t('ui.action.filter.empty.cities') }}
          </div>
        </div>
      </template>

      <!-- 评分面板 -->
      <template #ratings>
        <div
          class="max-h-64 overflow-y-auto flex flex-col items-center gap-3 py-4"
        >
          <Rating
            v-model="selectedRating"
            size="xl"
            :allow-half="false"
          />
          <div
            class="text-xs font-semibold text-neutral-900/90 dark:text-white/90"
          >
            {{
              selectedRating
                ? $t(
                    'ui.action.filter.rating.showStarsAndAbove',
                    selectedRating,
                  )
                : $t('ui.action.filter.rating.showAll')
            }}
          </div>
        </div>
      </template>
    </UTabs>
  </div>
</template>

<style scoped></style>
