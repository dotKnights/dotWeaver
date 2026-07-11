<script lang="ts">
	import image from '$lib/assets/image.png';
	import MeyNu from '$lib/components/MeyNu.svelte';
	import { motion } from 'motion-sv';

	let expanded = $state(false);

	const EXPANDED_SCALE = 4.5;
	const menuItems = ['Accueil', 'Projets', 'Paramètres'];
</script>

<svelte:head>
	<title>Dashboard | dotWeaver</title>
</svelte:head>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			expanded = false;
		}
	}}
/>

<MeyNu />

<div class="flex h-screen w-screen items-center justify-center bg-[#2A34F5] p-4">
	<div class="flex h-full w-full items-center justify-center bg-white rounded-md">
		<div class="absolute top-4 left-4 z-20 size-14">
			<motion.div
				animate={{ width: expanded ? `${EXPANDED_SCALE * 100}%` : '100%' }}
				transition={{ type: 'spring', stiffness: 200, damping: 20 }}
				class="absolute inset-y-0 left-0 bg-[#2A34F5] rounded-br-md"
			>
				<svg
					aria-hidden="true"
					class="pointer-events-none absolute top-0 left-full size-2"
					viewBox="0 0 2 2"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path d="M0 2S0 0 2 0H0" fill="#2A34F5" />
				</svg>
			</motion.div>

			<svg
				aria-hidden="true"
				class="pointer-events-none absolute top-full left-0 size-2"
				viewBox="0 0 2 2"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path d="M0 2S0 0 2 0H0" fill="#2A34F5" />
			</svg>

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
						class="font-satoshi text-xs font-bold whitespace-nowrap text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
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
	</div>
</div>
