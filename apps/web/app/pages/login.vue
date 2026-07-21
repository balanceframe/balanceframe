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
        :state="{ email, password }"
        class="space-y-4"
        @submit="handleLogin"
      >
        <UFormField label="Email" name="email" required>
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="password"
            type="password"
            placeholder="&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          icon="i-heroicons-exclamation-triangle"
        />

        <div class="flex flex-col gap-2">
          <UButton
            type="submit"
            :loading="loading"
            label="Sign in"
            size="lg"
            class="w-full"
          />
          <UButton
            variant="outline"
            label="Create account"
            size="lg"
            class="w-full"
            @click="showRegister = !showRegister"
          />
        </div>
      </UForm>

      <UForm
        v-if="showRegister"
        :state="{ name, email, password }"
        class="space-y-4 mt-6 pt-6 border-t border-gray-200 dark:border-gray-700"
        @submit="handleRegister"
      >
        <p class="text-sm font-medium text-gray-600 dark:text-gray-400">
          Create a new account
        </p>

        <UFormField label="Name" name="name" required>
          <UInput
            v-model="name"
            type="text"
            placeholder="Your name"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Email" name="email" required>
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="password"
            type="password"
            placeholder="&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="registerError"
          color="error"
          variant="soft"
          :title="registerError"
          icon="i-heroicons-exclamation-triangle"
        />

        <UButton
          type="submit"
          :loading="registering"
          label="Create account"
          size="lg"
          class="w-full"
        />
      </UForm>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
/**
 * Login / registration page.
 *
 * First-time users create an account.  Returning users sign in.
 * Already-authenticated users are redirected to /review via the
 * global route middleware, so we do not check session here.
 */

import { authClient } from '../../lib/auth-client';

const email = ref('');
const password = ref('');
const name = ref('');
const error = ref('');
const registerError = ref('');
const loading = ref(false);
const registering = ref(false);
const showRegister = ref(false);

async function handleLogin() {
  loading.value = true;
  error.value = '';

  const { error: authError } = await authClient.signIn.email({
    email: email.value,
    password: password.value,
  });

  if (authError) {
    error.value = authError.message || 'Sign in failed';
    loading.value = false;
    return;
  }

  await navigateTo('/review');
}

async function handleRegister() {
  registering.value = true;
  registerError.value = '';

  const { error: authError } = await authClient.signUp.email({
    name: name.value,
    email: email.value,
    password: password.value,
  });

  if (authError) {
    registerError.value = authError.message || 'Registration failed';
    registering.value = false;
    return;
  }

  await navigateTo('/review');
}
</script>
