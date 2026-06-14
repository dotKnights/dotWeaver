import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';

describe('ConnectorCard', () => {
	it('shows a connected badge', async () => {
		const screen = render(ConnectorCard, { name: 'GitHub', status: 'connected' });
		await expect.element(screen.getByText('Connecté')).toBeInTheDocument();
	});

	it('shows a reconnect badge', async () => {
		const screen = render(ConnectorCard, { name: 'Google', status: 'needs_reconnect' });
		await expect.element(screen.getByText('Reconnexion requise')).toBeInTheDocument();
	});

	it('shows a disconnected badge', async () => {
		const screen = render(ConnectorCard, { name: 'GitHub', status: 'disconnected' });
		await expect.element(screen.getByText('Non connecté')).toBeInTheDocument();
	});
});
