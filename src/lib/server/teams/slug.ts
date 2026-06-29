export function slugify(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'team';
}

export async function resolveSlug(
	name: string,
	exists: (slug: string) => Promise<boolean>
): Promise<string> {
	const base = slugify(name);
	if (!(await exists(base))) return base;
	let n = 2;
	while (await exists(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
