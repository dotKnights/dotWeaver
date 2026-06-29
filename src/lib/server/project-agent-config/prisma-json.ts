import type { Prisma } from '@prisma/client';

export function asPrismaJson(value: unknown): Prisma.InputJsonValue {
	return value as Prisma.InputJsonValue;
}
