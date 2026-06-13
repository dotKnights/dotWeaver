import { test, expect } from '@playwright/test';
import { registerUser, uniqueEmail } from './helpers';

test('mail route asks a logged-in user to connect Google when Gmail is not linked', async ({
	page
}) => {
	await registerUser(page, uniqueEmail());
	await page.goto('/mail');
	await expect(page).toHaveURL(/\/mail/);
	await expect(page.getByRole('heading', { name: 'Connect Gmail' })).toBeVisible();
	await expect(
		page.getByText('Connect Google with read-only Gmail access to review your threads.')
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Connect Google' })).toBeVisible();
});
