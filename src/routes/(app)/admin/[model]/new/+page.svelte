<script lang="ts">
  interface Props {
    data: {
      model: {
        name: string;
        label?: string;
        fields: Array<{ name: string; type: string; required: boolean; label?: string }>;
      };
      config: { basePath: string };
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
</script>

<div class="max-w-2xl">
  <a href="{data.config.basePath}/{data.model.name.toLowerCase()}" class="text-slate-500 hover:text-slate-700 text-sm mb-2 inline-block">
    ← Back to list
  </a>
  <h1 class="text-2xl font-bold text-slate-800 mb-6">Create {data.model.label || toLabel(data.model.name)}</h1>

  <form method="POST" class="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
    {#each data.model.fields as field}
      <div>
        <label for={field.name} class="block text-sm font-medium text-slate-700 mb-1">
          {field.label || toLabel(field.name)}
          {#if field.required}<span class="text-red-500">*</span>{/if}
        </label>
        {#if field.type === 'Boolean'}
          <input type="checkbox" id={field.name} name={field.name} class="rounded border-slate-300" />
        {:else}
          <input 
            type={mapType(field.type)} 
            id={field.name} 
            name={field.name} 
            required={field.required}
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
        Create
      </button>
    </div>
  </form>
</div>
