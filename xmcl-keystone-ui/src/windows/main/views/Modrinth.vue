<template>
  <div class="gap-2 p-4 overflow-auto mb-1 modrinth w-full pb-0 grid grid-cols-12">
    <v-progress-linear
      class="absolute top-0 z-10 m-0 p-0 left-0"
      :active="refreshing"
      height="3"
      :indeterminate="true"
    />
    <div class="flex flex-col gap-2 overflow-auto lg:col-span-9 md:col-span-12">
      <v-card
        class="flex py-1 flex-shrink flex-grow-0"
        outlined
      >
        <span class="flex items-center justify-center flex-shrink flex-1 min-w-36">
          <v-select
            v-model="_projectType"
            flat
            solo
            :items="projectTypes"
            hide-details
          />
        </span>
        <v-text-field
          v-model="keyword"
          color="green"
          append-icon="search"
          solo
          flat
          hide-details
          :placeholder="$t('modrinth.searchText')"
          @keypress.enter="_query = keyword"
        />
        <v-select
          v-model="_sortBy"
          :item-value="
            // @ts-expect-error
            v => v.name"
          class="max-w-40"
          hide-details
          flat
          :label="$t('modrinth.sort.title')"
          :items="sortOptions"
        />
        <v-select
          v-model="pageSize"
          class="max-w-40"
          :items="pageSizeOptions"
          hide-details
          flat
          :label="$t('modrinth.perPage')"
        />
        <v-pagination
          v-model="_page"
          :length="pageCount"
          :total-visible="5"
        />
      </v-card>

      <div
        v-if="!refreshing"
        class="flex flex-col gap-3 overflow-auto px-2.5"
      >
        <ModCard
          v-for="mod in projects"
          :key="mod.project_id"
          v-ripple
          :disabled="refreshing"
          :value="mod"
          class="cursor-pointer"
          @filter="onFiltered"
          @click="push(`/modrinth/${mod.project_id}`)"
        />
      </div>
      <v-skeleton-loader
        v-else
        class="flex flex-col gap-3 overflow-auto"
        type="list-item-avatar-three-line, list-item-avatar-three-line, list-item-avatar-three-line, list-item-avatar-three-line, list-item-avatar-three-line, list-item-avatar-three-line"
      />
    </div>
    <div class="flex flex-col overflow-y-auto lg:col-span-3 lg:flex md:hidden">
      <Categories
        class="overflow-auto"
        :loading="refreshingTag"
        :environments="environments"
        :categories="categories.filter(c => c.project_type === projectType)"
        :game-versions="gameVersions"
        :licenses="licenses"
        :loaders="modLoaders"
        :environment="environment"
        :mod-loader="modLoader"
        :game-version="gameVersion"
        :license="license"
        :category="category"
        @select:modLoader="_modLoader = _modLoader === $event ? '' : $event"
        @select:gameVersion="_gameVersion = _gameVersion === $event ? '' : $event"
        @select:license="_license = _license === $event ? '' : $event"
        @select:category="selectCategory"
        @select:environment="_environment = _environment === $event ? '' : $event"
      />
    </div>
  </div>
</template>

<script lang="ts">
import ModCard from './ModrinthModCard.vue'
import Categories from './ModrinthCategories.vue'
import { useRouter } from '/@/composables'
import { withDefault } from '/@/util/props'
import { useModrinth, useModrinthTags } from '../composables/modrinth'

export default defineComponent({
  components: { ModCard, Categories },
  props: {
    query: withDefault(String, () => ''),
    gameVersion: withDefault(String, () => ''),
    license: withDefault(String, () => ''),
    category: withDefault<string[]>(Array, () => [] as string[]),
    modLoader: withDefault(String, () => ''),
    environment: withDefault(String, () => ''),
    projectType: withDefault(String, () => 'mod'),
    sortBy: withDefault(String, () => ''),
    page: withDefault(Number, () => 1),
    from: withDefault(String, () => ''),
  },
  setup(props) {
    const { refresh: refreshTag, refreshing: refreshingTag, categories, modLoaders, environments, gameVersions, licenses } = useModrinthTags()
    const { refresh, query, category, gameVersion, license, modLoader, environment, projectType, sortBy, page, projectTypes, ...rest } = useModrinth(props)
    const { push } = useRouter()
    const keyword = ref(props.query)
    const onFiltered = (tag: string) => {
      if (categories.value.find(c => c.name === tag)) {
        selectCategory(tag)
      } else if (modLoaders.value.find(l => l.name === tag)) {
        modLoader.value = tag
      }
    }
    const selectCategory = (cat: string) => {
      if (category.value.indexOf(cat) === -1) {
        category.value = [...category.value, cat]
      } else {
        category.value = category.value.filter(v => v !== cat)
      }
    }
    onMounted(() => {
      refresh()
      refreshTag()
    })
    return {
      selectCategory,
      ...rest,
      categories,
      refreshingTag,
      modLoaders,
      environments,
      keyword,
      gameVersions,
      licenses,
      projectTypes,
      _query: query,
      _category: category,
      _projectType: projectType,
      _gameVersion: gameVersion,
      _license: license,
      _modLoader: modLoader,
      _environment: environment,
      _sortBy: sortBy,
      _page: page,
      refresh,
      push,
      onFiltered,
    }
  },
})
</script>

<style>
.modrinth
  .theme--.v-text-field
  > .v-input__control
  > .v-input__slot:before {
  border: none;
}

.modrinth .v-text-field>.v-input__control>.v-input__slot:before {
  border: none;
  border-width: 0px;
}
</style>
