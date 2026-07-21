<template>
  <UContainer class="min-h-screen flex items-center justify-center py-8">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {{ isSignUp ? 'Create an account' : 'Sign in to continue' }}
        </p>
      </template>

      <!-- Tab toggle -->
      <div class="flex gap-0 mb-6 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <button
          :class="[
            'flex-1 py-2 text-sm font-medium transition-colors',
            !isSignUp
              ? 'bg-primary-500 text-white'
              : 'bg-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
          ]"
          @click="isSignUp = false"
        >
          Sign in
        </button>
        <button
          :class="[
            'flex-1 py-2 text-sm font-medium transition-colors',
            isSignUp
              ? 'bg-primary-500 text-white'
              : 'bg-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
          ]"
          @click="isSignUp = true"
        >
          Create account
        </button>
      </div>

      <!-- Sign in form -->
      <UForm
        v-if="!isSignUp"
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

      <!-- Sign up form -->
      <UForm
        v-else
        :state="{ name: signUpName, email: signUpEmail, password: signUpPassword }"
        class="space-y-4"
        @submit="handleSignUp"
      >
        <UFormField label="Name" name="name" required>
          <UInput
            v-model="signUpName"
            type="text"
            placeholder="Your name"
            autocomplete="name"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Email" name="email" required>
          <UInput
            v-model="signUpEmail"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="signUpPassword"
            type="password"
            placeholder="&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;&#xb7;"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="signUpError"
          color="error"
          variant="soft"
          :title="signUpError"
          icon="i-heroicons-exclamation-triangle"
        />

        <UButton
          type="submit"
          :loading="signUpLoading"
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
 * Toggles between Sign in and Create account tabs.
 * Already-authenticated users are redirected to /review by the global
 * route middleware, so we do not check session here.
 */

import { authClient } from '../../lib/auth-client';

const isSignUp = ref(false);

// Sign-in form
const signInEmail = ref('');
const signInPassword = ref('');
const signInError = ref('');
const signInLoading = ref(false);

// Sign-up form
const signUpName = ref('');
const signUpEmail = ref('');
const signUpPassword = ref('');
const signUpError = ref('');
const signUpLoading = ref(false);

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

async function handleSignUp() {
  signUpLoading.value = true;
  signUpError.value = '';

  const { error: authError } = await authClient.signUp.email({
    name: signUpName.value,
    email: signUpEmail.value,
    password: signUpPassword.value,
  });

  if (authError) {
    signUpError.value = authError.message || 'Registration failed';
    signUpLoading.value = false;
    return;
  }

  await navigateTo('/review');
}
</script>
