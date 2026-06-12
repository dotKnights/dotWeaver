import { test, expect } from '@playwright/test';
import { registerUser, login, uniqueEmail } from './helpers';

test('unauthenticated visit to a protected route redirects to login', async ({ page }) => {
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/login/);
});

test('registering a new account lands on the dashboard', async ({ page }) => {
	await registerUser(page, uniqueEmail());
	await expect(page).toHaveURL(/\/dashboard/);
});

test('an existing user can sign out and sign back in', async ({ page }) => {
	const email = uniqueEmail();
	await registerUser(page, email);

	// Drop the session to simulate a fresh visitor, then sign in via the form.
	await page.context().clearCookies();
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/login/);

	await login(page, email);
});
