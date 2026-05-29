import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '$env/dynamic/private';
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrisma() {
	const adapter = new PrismaPg({ connectionString: env.DATABASE_URL! });
	return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
