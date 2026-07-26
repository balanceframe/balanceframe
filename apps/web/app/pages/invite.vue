<template>
  <UContainer class="min-h-screen flex items-center justify-center py-8">
    <UCard class="w-full max-w-md">
      <template #header>
        <h1 class="text-2xl font-bold">BalanceFrame</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Create your account
        </p>
      </template>

      <div v-if="!token" class="text-center py-4">
        <p class="text-gray-500 dark:text-gray-400 mb-4">
          This invitation link is invalid or has expired.
        </p>
        <UButton to="/login" label="Sign in" size="lg" />
      </div>

      <UForm
        v-else
        :state="{ name, email, password }"
        class="space-y-4"
        @submit="handleRedeem"
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

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          icon="i-heroicons-exclamation-triangle"
        />

        <UButton
          type="submit"
          :loading="loading"
          label="Create account"
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
 * Invitation redemption page.
 *
 * Accepts a bearer token from the URL fragment (#token=...), immediately
 * clears it from the address bar with history.replaceState, then collects
 * account details and posts to the invitation redemption endpoint.
 *
 * The token is never persisted in local storage, session storage, or
 * any other client-side store.  It exists only as a reactive ref for the
 * duration of this page visit.
 */

definePageMeta({
  layout: false,
});

const token = ref('');
const name = ref('');
const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

onMounted(() => {
  // Read the fragment and clear it immediately so the token never
  // appears in browser history, address bar, or proxy access logs.
  const hash = window.location.hash;
  const match = hash.match(/#token=([^&]+)/);
  if (match) {
    const rawToken = match[1];
    if (rawToken) {
      token.value = decodeURIComponent(rawToken);
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
});

async function handleRedeem() {
  loading.value = true;
  error.value = '';

  // Narrow the token: must be present and non-empty before we call the API.
  const inviteToken = token.value;
  if (!inviteToken) {
    error.value = 'This invitation link is invalid or has expired.';
    loading.value = false;
    token.value = '';
    return;
  }

  try {
    await $fetch('/api/invitations/redeem', {
      method: 'POST',
      body: {
        token: inviteToken,
        name: name.value,
        email: email.value,
        password: password.value,
      },
    });

    // Success — redirect to sign in.  Token is discarded with the component.
    await navigateTo('/login');
  } catch (e: unknown) {
    // Extract structured error data from the $fetch response
    const errorData = (e as { data?: { error?: { message?: string; retryable?: boolean } } })?.data?.error;
    const serverMessage = errorData?.message;
    const msg =
      serverMessage ||
      (e instanceof Error ? e.message : 'This invitation is invalid or has expired.');
    error.value = msg;

    // Determine if this is a terminal token error or a correctable field error.
    // retryable === false: token/store/identity failures — clear token, user needs a new link.
    // retryable === true or undefined: validation failures or network errors — preserve token.
    if (errorData?.retryable === false) {
      token.value = '';
    }
    // Otherwise preserve the in-memory token so the user can fix fields and retry.
  } finally {
    loading.value = false;
  }
}
</script>
