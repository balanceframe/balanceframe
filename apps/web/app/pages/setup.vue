<template>
  <UContainer class="min-h-screen flex items-center justify-center py-8">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Set up your instance
        </p>
      </template>

      <div v-if="loading" class="text-sm text-gray-400 text-center py-4">
        Loading...
      </div>

      <div v-else-if="!bootstrapAvailable" class="text-center py-4">
        <p class="text-gray-500 dark:text-gray-400 mb-4">
          This instance has already been set up.
        </p>
        <UButton to="/login" label="Sign in" size="lg" />
      </div>

      <UForm
        v-else
        :state="{
          name,
          email,
          password,
          bootstrapSecret,
        }"
        class="space-y-4"
        @submit="handleBootstrap"
      >
        <UFormField label="Name" name="name" required>
          <UInput
            v-model="name"
            type="text"
            placeholder="Your name"
            autocomplete="name"
            class="w-full"
          />
        </UFormField>

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
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Bootstrap secret" name="bootstrapSecret" required>
          <UInput
            v-model="bootstrapSecret"
            type="password"
            placeholder="Operator bootstrap secret"
            autocomplete="off"
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

        <UButton
          type="submit"
          :loading="loadingSubmit"
          label="Set up instance"
          size="lg"
          class="w-full"
        />
      </UForm>

      <template #footer>
        <div class="text-sm text-center">
          <NuxtLink
            to="/login"
            class="text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300"
          >
            Back to sign in
          </NuxtLink>
        </div>
      </template>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
/**
 * Bootstrap setup page.
 *
 * Rendered only when the safe /api/auth/config reports bootstrapAvailable.
 * Collects the operator bootstrap secret locally and posts to the
 * registration bootstrap endpoint. On success the user is redirected to
 * sign in.
 *
 * The bootstrap secret is never persisted client-side — it is held in
 * a reactive ref and discarded on navigation.
 */

definePageMeta({
  layout: false,
});

const loading = ref(true);
const loadingSubmit = ref(false);
const bootstrapAvailable = ref(false);
const error = ref('');

const name = ref('');
const email = ref('');
const password = ref('');
const bootstrapSecret = ref('');

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
    bootstrapAvailable.value = false;
  } finally {
    loading.value = false;
  }
});

async function handleBootstrap() {
  loadingSubmit.value = true;
  error.value = '';

  try {
    await $fetch('/api/registration/bootstrap', {
      method: 'POST',
      body: {
        name: name.value,
        email: email.value,
        password: password.value,
        bootstrapSecret: bootstrapSecret.value,
      },
    });

    await navigateTo('/login');
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : 'Setup failed. Please try again.';
    error.value = msg;
  } finally {
    loadingSubmit.value = false;
  }
}
</script>
