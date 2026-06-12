import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env as privateEnv } from '$env/dynamic/private';

/**
 * Removes data created by the e2e suite from the dev database:
 * - organizations whose slug starts with "e2e" (cascades members + invitations)
 * - users whose email starts with "e2e-" (cascades sessions, accounts, memberships)
 */
export default async function globalTeardown() {
	const connectionString = privateEnv.DATABASE_URL;
	if (!connectionString) {
		console.warn('[e2e teardown] DATABASE_URL not set — skipping cleanup');
		return;
	}

	const adapter = new PrismaPg({ connectionString });
	const prisma = new PrismaClient({ adapter });

	try {
		const orgs = await prisma.organization.deleteMany({ where: { slug: { startsWith: 'e2e' } } });
		const users = await prisma.user.deleteMany({ where: { email: { startsWith: 'e2e-' } } });
		console.log(
			`[e2e teardown] removed ${orgs.count} test team(s) and ${users.count} test user(s)`
		);
	} finally {
		await prisma.$disconnect();
	}
}
