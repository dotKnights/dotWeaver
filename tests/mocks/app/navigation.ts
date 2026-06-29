export function afterNavigate() {}
export function beforeNavigate() {}
export function disableScrollHandling() {}
export function goto() {
	return Promise.resolve();
}
export function invalidate() {
	return Promise.resolve();
}
export function invalidateAll() {
	return Promise.resolve();
}
export function onNavigate() {}
export function preloadCode() {
	return Promise.resolve();
}
export function preloadData() {
	return Promise.resolve({ type: 'loaded', status: 200, data: {} });
}
export function pushState() {}
export function refreshAll() {
	return Promise.resolve();
}
export function replaceState() {}
