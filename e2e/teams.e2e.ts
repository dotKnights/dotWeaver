import { test, expect } from '@playwright/test';
import { registerUser, uniqueEmail } from './helpers';

test('a user can create a team and generate an invite link', async ({ page }) => {
	await registerUser(page, uniqueEmail());

	await page.goto('/teams');
	const teamName = `E2E Team ${Date.now()}`;
	await page.getByLabel('Team name').fill(teamName);
	await page.getByRole('button', { name: 'Create' }).click();

	// Slug is auto-generated from the name ("E2E Team 123" -> "e2e-team-123").
	await page.waitForURL('**/teams/e2e-team-**', { timeout: 15000 });
	await expect(page.getByRole('heading', { name: teamName })).toBeVisible();

	// Invite someone and confirm a copyable accept link is surfaced.
	await page.getByLabel('Email').fill('invitee@example.com');
	await page.getByRole('button', { name: 'Send invitation' }).click();
	await expect(page.getByText('/accept-invitation/')).toBeVisible({ timeout: 10000 });
});

test('the active-team dropdown lists the teams a user belongs to', async ({ page }) => {
	await registerUser(page, uniqueEmail());

	await page.goto('/teams');
	const teamName = `E2E Team ${Date.now()}`;
	await page.getByLabel('Team name').fill(teamName);
	await page.getByRole('button', { name: 'Create' }).click();
	await page.waitForURL('**/teams/e2e-team-**', { timeout: 15000 });

	// Reload so the layout loads membership fresh, then assert the header dropdown
	// reflects the persisted team.
	await page.reload();
	const dropdown = page.locator('header select');
	await expect(dropdown).toBeVisible();
	await expect(dropdown.getByRole('option', { name: teamName })).toHaveCount(1);
});
