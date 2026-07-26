<template>
  <UContainer class="min-h-screen flex items-center justify-center py-8">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Sign in to continue
        </p>
      </template>

      <UForm
        :state="{ email: signInEmail, password: signInPassword }"
        class="space-y-4"
        @submit="handleSignIn"
      >
        <UFormField label="Email" name="email" required>
          <UInput
            v-model="signInEmail"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="signInPassword"
            type="password"
            placeholder="&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="signInError"
          color="error"
          variant="soft"
          :title="signInError"
          icon="i-heroicons-exclamation-triangle"
        />

        <UButton
          type="submit"
          :loading="signInLoading"
          label="Sign in"
          size="lg"
          class="w-full"
        />
      </UForm>

      <template #footer>
        <div class="flex flex-col gap-2 text-sm text-center">
          <NuxtLink
            v-if="bootstrapAvailable"
            to="/setup"
            class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
          >
            Set up this instance
          </NuxtLink>
          <p class="text-gray-500 dark:text-gray-400">
            Have an invitation link?
            <NuxtLink
              to="/invite"
              class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
            >
              Use it here
            </NuxtLink>
          </p>
        </div>
      </template>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
/**
 * Sign-in page.
 *
 * Bootstrap and invitation flows live on dedicated pages (/setup, /invite).
 * This page handles only email/password sign-in.  Already-authenticated
 * users are redirected to /review by the global route middleware.
 */

import { authClient } from '../../lib/auth-client';

// Sign-in form
const signInEmail = ref('');
const signInPassword = ref('');
const signInError = ref('');
const signInLoading = ref(false);

// Safe config — fetch once, never block render
const bootstrapAvailable = ref(false);

onMounted(async () => {
  try {
    const config = await $fetch<{
      registrationMode: string;
      bootstrapAvailable: boolean;
    }>('/api/auth/config');
    bootstrapAvailable.value = config.bootstrapAvailable;
  } catch {
    // Config unavailable — default to invite-only mode (no bootstrap link).
  }
});

async function handleSignIn() {
  signInLoading.value = true;
  signInError.value = '';

  const { error: authError } = await authClient.signIn.email({
    email: signInEmail.value,
    password: signInPassword.value,
  });

  if (authError) {
    signInError.value = authError.message || 'Sign in failed';
    signInLoading.value = false;
    return;
  }

  await navigateTo('/review');
}
</script>
