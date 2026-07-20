<template>
  <UContainer class="py-8">
    <UCard>
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
      </template>
      <p class="text-gray-600 dark:text-gray-400 mb-4">
        Transaction categorization review surface.
      </p>
      <UButton
        to="/review"
        label="Review transactions"
        icon="i-heroicons-chevron-right"
        trailing
        size="lg"
      />
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
// Landing page — no controller state until the user navigates to /review.
</script>
