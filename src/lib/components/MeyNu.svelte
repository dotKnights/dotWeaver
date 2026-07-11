<script lang="ts">
	import * as Command from '$lib/components/ui/command/index.js';

	let open = $state(false);
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
		}
	}}
/>

<Command.Dialog bind:open>
	<Command.Input placeholder="Type a command or search..." />
	<Command.List>
	  <Command.Empty>No results found.</Command.Empty>
	  <Command.Group heading="Suggestions">
		<Command.Item>Calendar</Command.Item>
		<Command.Item>Search Emoji</Command.Item>
		<Command.Item>Calculator</Command.Item>
	  </Command.Group>
	</Command.List>
  </Command.Dialog>