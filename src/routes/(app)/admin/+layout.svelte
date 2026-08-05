<script lang="ts">
  import type { Snippet } from 'svelte';
  
  interface Props {
    data: {
      models: Array<{ name: string; label?: string }>;
      config: { basePath: string };
    };
    children: Snippet;
  }

  let { data, children }: Props = $props();
</script>

<div class="flex min-h-screen bg-gray-50 font-sans">
  <aside class="w-64 bg-slate-800 text-white p-4">
    <h2 class="text-xl font-bold mb-4">dotWeaver Admin</h2>
    <nav class="space-y-1">
      <a href="{data.config.basePath}" class="block px-3 py-2 rounded text-slate-300 hover:bg-slate-700 hover:text-white">
        Dashboard
      </a>
      <div class="pt-4 pb-2 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
        Models
      </div>
      {#each data.models as model}
        <a 
          href="{data.config.basePath}/{model.name.toLowerCase()}" 
          class="block px-3 py-2 rounded text-slate-300 hover:bg-slate-700 hover:text-white"
        >
          {model.label || model.name}
        </a>
      {/each}
    </nav>
  </aside>
  <main class="flex-1 p-6">
    {@render children()}
  </main>
</div>
