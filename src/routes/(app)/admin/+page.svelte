<script lang="ts">
  interface Props {
    data: {
      models: Array<{ name: string; label?: string; count: number }>;
      stats: { totalRecords: number; modelsCount: number };
    };
  }

  let { data }: Props = $props();
</script>

<div>
  <h1 class="text-2xl font-bold text-slate-800 mb-2">Dashboard</h1>
  <p class="text-slate-500 mb-6">Welcome to dotWeaver Admin</p>

  <div class="grid grid-cols-2 gap-4 mb-8">
    <div class="bg-white border border-slate-200 rounded-lg p-5">
      <div class="text-3xl font-bold text-slate-800">{data.stats.modelsCount}</div>
      <div class="text-slate-500">Models</div>
    </div>
    <div class="bg-white border border-slate-200 rounded-lg p-5">
      <div class="text-3xl font-bold text-slate-800">{data.stats.totalRecords}</div>
      <div class="text-slate-500">Total Records</div>
    </div>
  </div>

  <h2 class="text-lg font-semibold text-slate-800 mb-4">Models</h2>
  <div class="grid grid-cols-3 gap-4">
    {#each data.models as model}
      <a href="/admin/{model.name.toLowerCase()}" class="bg-white border border-slate-200 rounded-lg p-5 hover:border-indigo-500 hover:shadow transition">
        <div class="font-semibold text-slate-800">{model.label || model.name}</div>
        <div class="text-sm text-slate-500">{model.count} records</div>
      </a>
    {/each}
  </div>
</div>
