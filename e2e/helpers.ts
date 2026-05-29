import { type Page, expect } from '@playwright/test';

/** All e2e-created accounts use this prefix so the global teardown can purge them. */
export const E2E_EMAIL_PREFIX = 'e2e-';

/** All e2e-created teams use this slug prefix so the global teardown can purge them. */
export const E2E_TEAM_PREFIX = 'E2E Team';

export function uniqueEmail(): string {
	return `${E2E_EMAIL_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1_000_000)}@example.com`;
}

export const TEST_PASSWORD = 'password123';

/**
 * Registers a new account through the UI. Because `/login` redirects to `/dashboard`
 * whenever a session exists, a successful sign-up lands the user on the dashboard.
 */
export async function registerUser(
	page: Page,
	email: string,
	password: string = TEST_PASSWORD,
	name: string = 'E2E User'
): Promise<void> {
	await page.goto('/register');
	// Wait for hydration so superForm's use:enhance intercepts the submit; otherwise the
	// native POST hits a route with no action and returns 405.
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Name').fill(name);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();
	await page.waitForURL('**/dashboard', { timeout: 15000 });
}

/** Signs in through the login form and waits for the dashboard. */
export async function login(
	page: Page,
	email: string,
	password: string = TEST_PASSWORD
): Promise<void> {
	await page.goto('/login');
	await page.waitForLoadState('networkidle');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL('**/dashboard', { timeout: 15000 });
	await expect(page).toHaveURL(/\/dashboard/);
}
