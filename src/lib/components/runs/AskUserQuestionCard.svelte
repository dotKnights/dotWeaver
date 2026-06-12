<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { OTHER_OPTION_VALUE } from '$lib/schemas/run-interactions';
	import { LoaderCircle, SendHorizontal } from '@lucide/svelte';

	type QuestionOption = { label: string; description: string; preview?: string };
	type Question = {
		question: string;
		header: string;
		options: QuestionOption[];
		multiSelect: boolean;
	};
	type Interaction = {
		id: string;
		request: { questions: Question[] };
	};
	type DraftAnswer = { selected: string[]; otherText: string };

	let {
		interaction,
		busy = false,
		error = null,
		onsubmit
	}: {
		interaction: Interaction;
		busy?: boolean;
		error?: string | null;
		onsubmit: (answers: Record<string, { selected: string[]; otherText?: string }>) => void;
	} = $props();

	function initialAnswers(questions: Question[]): Record<string, DraftAnswer> {
		const next: Record<string, DraftAnswer> = {};
		for (const question of questions) {
			next[question.question] = { selected: [], otherText: '' };
		}
		return next;
	}

	let answerDrafts = $state<Record<string, Record<string, DraftAnswer>>>({});
	const answers = $derived.by(
		() => answerDrafts[interaction.id] ?? initialAnswers(interaction.request.questions)
	);

	function setQuestionAnswer(question: Question, answer: DraftAnswer) {
		answerDrafts = {
			...answerDrafts,
			[interaction.id]: {
				...answers,
				[question.question]: answer
			}
		};
	}

	function toggle(question: Question, value: string) {
		const current = answers[question.question] ?? { selected: [], otherText: '' };
		if (question.multiSelect) {
			const selected = current.selected.includes(value)
				? current.selected.filter((item) => item !== value)
				: [...current.selected, value];
			setQuestionAnswer(question, { ...current, selected });
		} else {
			setQuestionAnswer(question, { ...current, selected: [value] });
		}
	}

	function setOtherText(question: Question, otherText: string) {
		const current = answers[question.question] ?? { selected: [], otherText: '' };
		setQuestionAnswer(question, { ...current, otherText });
	}

	function isComplete(question: Question) {
		const answer = answers[question.question];
		if (!answer || answer.selected.length === 0) return false;
		if (!question.multiSelect && answer.selected.length !== 1) return false;
		if (answer.selected.includes(OTHER_OPTION_VALUE) && answer.otherText.trim().length === 0) {
			return false;
		}
		return true;
	}

	const complete = $derived(interaction.request.questions.every(isComplete));

	function submit() {
		if (!complete || busy) return;
		const payload: Record<string, { selected: string[]; otherText?: string }> = {};
		for (const [question, answer] of Object.entries(answers)) {
			payload[question] = {
				selected: answer.selected,
				...(answer.otherText.trim() ? { otherText: answer.otherText.trim() } : {})
			};
		}
		onsubmit(payload);
	}
</script>

<section class="rounded-md border border-primary/30 bg-card p-4 shadow-sm">
	<div class="mb-4">
		<p class="text-xs font-medium tracking-wide text-primary uppercase">Question de l'IA</p>
		<h2 class="text-base font-semibold">Reponse requise pour continuer le run</h2>
	</div>

	<div class="space-y-4">
		{#each interaction.request.questions as question (question.question)}
			{@const answer = answers[question.question] ?? { selected: [], otherText: '' }}
			<div class="space-y-2">
				<div>
					<p class="text-xs font-medium text-muted-foreground">{question.header}</p>
					<p class="text-sm font-medium">{question.question}</p>
				</div>

				<div class="grid gap-2">
					{#each [...question.options, { label: OTHER_OPTION_VALUE, description: 'Reponse libre' }] as option (option.label)}
						<label
							class={[
								'flex cursor-pointer gap-2 rounded-md border p-2 text-sm transition-colors',
								answer.selected.includes(option.label) && 'border-primary bg-primary/5'
							]}
						>
							<input
								type={question.multiSelect ? 'checkbox' : 'radio'}
								name={question.question}
								checked={answer.selected.includes(option.label)}
								onchange={() => toggle(question, option.label)}
							/>
							<span>
								<span class="block font-medium">
									{option.label === OTHER_OPTION_VALUE ? 'Autre' : option.label}
								</span>
								<span class="block text-xs text-muted-foreground">{option.description}</span>
							</span>
						</label>
					{/each}
				</div>

				{#if answer.selected.includes(OTHER_OPTION_VALUE)}
					<textarea
						class="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm"
						aria-label="Precise ta reponse"
						value={answer.otherText}
						oninput={(event) => setOtherText(question, event.currentTarget.value)}
					></textarea>
				{/if}
			</div>
		{/each}
	</div>

	{#if error}
		<p class="mt-3 text-sm text-destructive">{error}</p>
	{/if}

	<div class="mt-4 flex justify-end">
		<Button onclick={submit} disabled={!complete || busy}>
			{#if busy}
				<LoaderCircle class="animate-spin" />
				Reprise...
			{:else}
				<SendHorizontal />
				Repondre et reprendre
			{/if}
		</Button>
	</div>
</section>
