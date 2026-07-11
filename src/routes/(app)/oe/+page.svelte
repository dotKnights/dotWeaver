<script lang="ts">
	import image from '$lib/assets/image.png';
	import MeyNu from '$lib/components/MeyNu.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { motion } from 'motion-sv';

	let expanded = $state(false);

	const EXPANDED_SCALE = 4.5;
	const menuItems = ['Accueil', 'Projets', 'Paramètres'];
</script>

<svelte:head>
	<title>Dashboard | dotWeaver</title>
</svelte:head>

<svelte:window onkeydown={(e: KeyboardEvent) => {
	if (e.key === 'Escape') {
		expanded = false;
	}
}} />

<MeyNu />

<div class="flex h-screen w-screen items-center justify-center bg-[#2A34F5] p-4">
	<div class="flex h-full w-full items-center justify-center bg-white">
		<div class="absolute size-14 top-6 left-6 z-20 ">
			<motion.div
				animate={{ scaleX: expanded ? EXPANDED_SCALE : 1 }}
				transition={{ type: 'spring', stiffness: 200, damping: 20 }}
				class="absolute inset-0 origin-left bg-[#2A34F5]"
			/>

			<nav
				aria-label="Navigation principale"
				aria-hidden={!expanded}
				class:pointer-events-none={!expanded}
				class="absolute top-0 left-14 z-10 flex h-14 w-[196px] items-center gap-2 overflow-hidden px-3"
			>
				{#each menuItems as item, index}
					<motion.button
						type="button"
						tabindex={expanded ? 0 : -1}
						initial={{ opacity: 0, y: -5, filter: 'blur(10px)' }}
						animate={{
							opacity: expanded ? 1 : 0,
							y: expanded ? 0 : 5,
							filter: expanded ? 'blur(0px)' : 'blur(10px)'
						}}
						transition={{
							duration: expanded ? 0.22 : 0.14,
							delay: expanded ? 0.1 + index * 0.055 : (menuItems.length - 1 - index) * 0.025,
							ease: expanded ? [0.22, 1, 0.36, 1] : [0.4, 0, 1, 1]
						}}
						class="text-xs font-satoshi font-bold whitespace-nowrap text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
					>
						{item}
					</motion.button>
				{/each}
			</nav>

			<button
				type="button"
				onclick={() => (expanded = !expanded)}
				aria-expanded={expanded}
				aria-label={expanded ? 'Fermer le menu' : 'Ouvrir le menu'}
				class="absolute inset-0 z-20 flex cursor-pointer items-center justify-center"
			>
				<img src={image} alt="" class="pointer-events-none h-8 w-8 object-contain" />
			</button>
			
			
		</div>
		<div class="w-170 h-40 border" >
			<p>dotWeaver</p>
			<DropdownMenu.Root>
			  <DropdownMenu.Trigger>Open</DropdownMenu.Trigger>
			  <DropdownMenu.Content>
				<DropdownMenu.Group>
				  <DropdownMenu.GroupHeading>My Account</DropdownMenu.GroupHeading>
				  <DropdownMenu.Separator />
				  <DropdownMenu.Item>Profile</DropdownMenu.Item>
				  <DropdownMenu.Item>Billing</DropdownMenu.Item>
				  <DropdownMenu.Item>Team</DropdownMenu.Item>
				  <DropdownMenu.Item>Subscription</DropdownMenu.Item>
				</DropdownMenu.Group>
			  </DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</div>
</div>
