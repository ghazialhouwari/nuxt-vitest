<template>
  <h2>{{ title }}</h2>
  <div>
    <slot />
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title?: string
  }>(),
  {
    title: 'The original',
  }
)
const title = ref(props.title)
await new Promise(resolve => setTimeout(resolve, 1))
</script>
