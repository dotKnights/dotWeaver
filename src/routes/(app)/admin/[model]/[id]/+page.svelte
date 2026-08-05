<script lang="ts">
  interface Props {
    data: {
      model: {
        name: string;
        label?: string;
        primaryKey: string;
        fields: Array<{ name: string; type: string; required: boolean; label?: string }>;
      };
      item: Record<string, unknown>;
      config: { basePath: string; readonly?: string[] };
    };
  }

  let { data }: Props = $props();

  function toLabel(name: string): string {
    return name.replace(/([A-Z])/g, ' $1').trim();
  }

  function mapType(type: string): string {
    switch (type) {
      case 'Int': case 'Float': case 'Decimal': case 'BigInt': return 'number';
      case 'Boolean': return 'checkbox';
      case 'DateTime': return 'datetime-local';
      default: return 'text';
    }
  }

  function formatValue(value: unknown, type: string): string {
    if (value === null || value === undefined) return '';
    if (type === 'DateTime') {
      const d = new Date(value as string);
      return d.toISOString().slice(0, 16);
    }
    return String(value);
  }

  function isReadonly(fieldName: string): boolean {
    return data.config.readonly?.includes(fieldName) || 
           fieldName === data.model.primaryKey ||
           /^(createdAt|updatedAt)$/i.test(fieldName);
  }
</script>

<div class="max-w-2xl">
  <a href="{data.config.basePath}/{data.model.name.toLowerCase()}" class="text-slate-500 hover:text-slate-700 text-sm mb-2 inline-block">
    ← Back to list
  </a>
  <h1 class="text-2xl font-bold text-slate-800">Edit {data.model.label || toLabel(data.model.name)}</h1>
  <p class="text-slate-500 text-sm mb-6">ID: {data.item[data.model.primaryKey]}</p>

  <form method="POST" class="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
    {#each data.model.fields as field}
      {@const readonly = isReadonly(field.name)}
      <div>
        <label for={field.name} class="block text-sm font-medium text-slate-700 mb-1">
          {field.label || toLabel(field.name)}
        </label>
        {#if readonly}
          <div class="px-3 py-2 bg-slate-100 rounded-lg text-slate-600 text-sm">
            {formatValue(data.item[field.name], field.type) || '—'}
          </div>
        {:else if field.type === 'Boolean'}
          <input type="checkbox" id={field.name} name={field.name} checked={Boolean(data.item[field.name])} class="rounded border-slate-300" />
        {:else}
          <input 
            type={mapType(field.type)} 
            id={field.name} 
            name={field.name}
            value={formatValue(data.item[field.name], field.type)}
            class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        {/if}
      </div>
    {/each}
    
    <div class="pt-4 flex gap-3">
      <a href="{data.config.basePath}/{data.model.name.toLowerCase()}" class="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">
        Cancel
      </a>
      <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
        Update
      </button>
    </div>
  </form>
</div>
