<template>
  <fieldset
    class="space-y-3 rounded border p-3 sm:col-span-2"
    aria-label="Entered receipt items and tenders"
  >
    <p>
      Copy every amount as shown, including explicit zero discount or tax. No totals are calculated
      here. All entries remain unverified.
    </p>
    <div class="grid gap-3 sm:grid-cols-2">
      <label v-for="key in ['discount', 'tax'] as const" :key="key"
        >Receipt {{ key }} shown<input
          :value="modelValue[key]"
          :data-testid="`photo-receipt-${key}`"
          inputmode="decimal"
          class="block w-full rounded border p-2 dark:bg-gray-950"
          @input="setReceipt(key, $event)"
      /></label>
    </div>
    <fieldset
      v-for="(line, index) in modelValue.lines"
      :key="index"
      class="grid gap-3 rounded border p-3 sm:grid-cols-2"
    >
      <legend>Item {{ index + 1 }}</legend>
      <label v-for="field in fields" :key="field.key"
        >{{ field.label
        }}<input
          :value="line[field.key]"
          :data-testid="`photo-line-${field.key}`"
          :inputmode="field.key === 'description' || field.key === 'sku' ? 'text' : 'decimal'"
          class="block w-full rounded border p-2 dark:bg-gray-950"
          @input="setLine(index, field.key, $event)"
      /></label>
      <button
        type="button"
        data-testid="remove-photo-line"
        class="rounded border p-2"
        @click="removeLine(index)"
      >
        Remove item {{ index + 1 }}
      </button>
    </fieldset>
    <button
      type="button"
      data-testid="add-photo-line"
      class="rounded border px-3 py-2"
      @click="addLine"
    >
      Add item
    </button>
    <fieldset
      v-for="(tender, index) in modelValue.tenders"
      :key="index"
      class="grid gap-3 rounded border p-3 sm:grid-cols-2"
    >
      <legend>Payment tender {{ index + 1 }}</legend>
      <label
        >Tender type<select
          :value="tender.kind"
          data-testid="photo-tender-kind"
          class="block w-full rounded border p-2 dark:bg-gray-950"
          @change="setTender(index, 'kind', $event)"
        >
          <option value="">Choose the type shown</option>
          <option v-for="kind in tenderKinds" :key="kind.value" :value="kind.value">
            {{ kind.label }}
          </option>
        </select></label
      >
      <label
        >Tender amount shown<input
          :value="tender.amount"
          data-testid="photo-tender-amount"
          inputmode="decimal"
          class="block w-full rounded border p-2 dark:bg-gray-950"
          @input="setTender(index, 'amount', $event)"
      /></label>
      <button
        type="button"
        data-testid="remove-photo-tender"
        class="rounded border p-2"
        @click="removeTender(index)"
      >
        Remove tender {{ index + 1 }}
      </button>
    </fieldset>
    <button
      type="button"
      data-testid="add-photo-tender"
      class="rounded border px-3 py-2"
      @click="addTender"
    >
      Add payment tender
    </button>
    <p>
      Include each card, cash, gift card, reward or wallet tender separately. Missing or uncertain
      item facts can be left unknown by turning off item entry.
    </p>
  </fieldset>
</template>
<script setup lang="ts">
import type { ReceiptPhotoItemsForm } from '../utils/receipt-photo-client';
const props = defineProps<{ modelValue: ReceiptPhotoItemsForm }>();
const emit = defineEmits<{ 'update:modelValue': [value: ReceiptPhotoItemsForm] }>();
type Line = ReceiptPhotoItemsForm['lines'][number];
const fields: Array<{ key: keyof Line; label: string }> = [
  { key: 'description', label: 'Description exactly as shown' },
  { key: 'sku', label: 'SKU (optional)' },
  { key: 'quantity', label: 'Quantity shown (up to six decimal places)' },
  { key: 'unitGross', label: 'Unit gross amount shown' },
  { key: 'gross', label: 'Line gross amount shown' },
  { key: 'discount', label: 'Line discount shown' },
  { key: 'tax', label: 'Line tax shown' },
  { key: 'net', label: 'Line net amount shown' },
];
const tenderKinds = [
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank' },
  { value: 'gift_card', label: 'Gift card' },
  { value: 'reward', label: 'Reward' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'cash', label: 'Cash' },
] as const;
const text = (event: Event) => (event.target as HTMLInputElement).value;
function setReceipt(key: 'discount' | 'tax', event: Event) {
  emit('update:modelValue', { ...props.modelValue, [key]: text(event) });
}
function setLine(index: number, key: keyof Line, event: Event) {
  emit('update:modelValue', {
    ...props.modelValue,
    lines: props.modelValue.lines.map((line, i) =>
      i === index ? { ...line, [key]: text(event) } : line,
    ),
  });
}
function addLine() {
  emit('update:modelValue', {
    ...props.modelValue,
    lines: [
      ...props.modelValue.lines,
      {
        description: '',
        sku: '',
        quantity: '',
        unitGross: '',
        gross: '',
        discount: '',
        tax: '',
        net: '',
      },
    ],
  });
}
function removeLine(index: number) {
  emit('update:modelValue', {
    ...props.modelValue,
    lines: props.modelValue.lines.filter((_line, i) => i !== index),
  });
}
function setTender(index: number, key: 'kind' | 'amount', event: Event) {
  const value = text(event);
  if (key === 'kind' && value !== '' && !tenderKinds.some((kind) => kind.value === value)) return;
  emit('update:modelValue', {
    ...props.modelValue,
    tenders: props.modelValue.tenders.map((tender, i) =>
      i === index
        ? ({ ...tender, [key]: value } as ReceiptPhotoItemsForm['tenders'][number])
        : tender,
    ),
  });
}
function addTender() {
  emit('update:modelValue', {
    ...props.modelValue,
    tenders: [...props.modelValue.tenders, { kind: '', amount: '' }],
  });
}
function removeTender(index: number) {
  emit('update:modelValue', {
    ...props.modelValue,
    tenders: props.modelValue.tenders.filter((_tender, i) => i !== index),
  });
}
</script>
