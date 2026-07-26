<template>
  <UContainer class="py-8">
    <UCard>
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
      </template>

      <p class="text-gray-600 dark:text-gray-400 mb-4">
        Transaction categorization review surface.
      </p>

      <div v-if="isPending" class="text-sm text-gray-400">
        Loading...
      </div>

      <div v-else-if="isAuthenticated" class="flex flex-col gap-3">
        <p class="text-sm text-gray-500 dark:text-gray-400">
          Signed in as <strong>{{ user?.email }}</strong>
        </p>
        <div class="flex gap-2">
          <UButton
            to="/review"
            label="Review transactions"
            icon="i-heroicons-chevron-right"
            trailing
            size="lg"
          />
          <UButton
            variant="outline"
            label="Sign out"
            @click="handleSignOut"
          />
        </div>
      </div>

      <div v-else class="flex flex-col gap-3">
        <UButton
          to="/login"
          label="Sign in"
          size="lg"
          class="self-start"
        />
        <div class="text-sm text-gray-500 dark:text-gray-400">
          <NuxtLink
            v-if="bootstrapAvailable"
            to="/setup"
            class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
          >
            Set up this instance
          </NuxtLink>
          <p v-else>
            Have an invitation link? Open it to create your account.
          </p>
        </div>
      </div>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
import { authClient } from '../../lib/auth-client';

const sessionState = authClient.useSession();
const session = computed(() => sessionState.value?.data ?? null);
const isPending = computed(() => sessionState.value?.isPending ?? true);
const isAuthenticated = computed(() => !!session.value?.user);
const user = computed(() => session.value?.user ?? null);

const bootstrapAvailable = ref(false);

onMounted(async () => {
  try {
    const config = await $fetch<{
      result: {
        registrationMode: string;
        bootstrapAvailable: boolean;
        invitationRequired: boolean;
      };
    }>('/api/auth/config');
    bootstrapAvailable.value = config.result.bootstrapAvailable;
  } catch {
    // Config unavailable — default to invite-only instructions.
  }
});

async function handleSignOut() {
  await authClient.signOut();
  // The session ref updates reactively — the UI switches to the logged-out view.
}
</script>
