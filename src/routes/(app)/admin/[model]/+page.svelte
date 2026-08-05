<script lang="ts">
  interface Props {
    data: {
      model: {
        name: string;
        label?: string;
        fields: Array<{ name: string; type: string; label?: string }>;
        primaryKey: string;
      };
      items: Record<string, unknown>[];
      total: number;
      page: number;
      perPage: number;
      config: { basePath: string };
    };
  }

  let { data }: Props = $props();

  function toLabel(name: string): string {
    return name.replace(/([A-Z])/g, ' $1').trim();
  }

  function formatValue(value: unknown, type?: string): string {
    if (value === null || value === undefined) return '—';
    if (type === 'DateTime' || value instanceof Date) {
      return new Date(value as string).toLocaleDateString();
    }
    if (typeof value === 'boolean') return value ? '✓' : '✗';
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return String(obj.name || obj.title || obj.email || obj.id || JSON.stringify(value));
    }
    return String(value);
  }
</script>

<div>
  <div class="flex justify-between items-center mb-6">
    <div>
      <h1 class="text-2xl font-bold text-slate-800">{data.model.label || toLabel(data.model.name)}</h1>
      <p class="text-slate-500">{data.total} records</p>
    </div>
    <a href="{data.config.basePath}/{data.model.name.toLowerCase()}/new" class="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700">
      + New
    </a>
  </div>

  <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
    <table class="w-full">
      <thead class="bg-slate-50 border-b border-slate-200">
        <tr>
          {#each data.model.fields.slice(0, 6) as field}
            <th class="text-left px-4 py-3 text-sm font-semibold text-slate-600">{field.label || toLabel(field.name)}</th>
          {/each}
          <th class="px-4 py-3 text-sm font-semibold text-slate-600">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each data.items as item}
          <tr class="border-b border-slate-100 hover:bg-slate-50">
            {#each data.model.fields.slice(0, 6) as field}
              <td class="px-4 py-3 text-sm text-slate-700">{formatValue(item[field.name], field.type)}</td>
            {/each}
            <td class="px-4 py-3">
              <a href="{data.config.basePath}/{data.model.name.toLowerCase()}/{item[data.model.primaryKey]}" class="text-indigo-600 hover:text-indigo-800 text-sm">Edit</a>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan={data.model.fields.length + 1} class="px-4 py-8 text-center text-slate-500">No records found</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
